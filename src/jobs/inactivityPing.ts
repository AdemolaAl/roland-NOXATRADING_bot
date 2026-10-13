import type { Telegram } from 'telegraf'
import type { PgBoss } from 'pg-boss'
import { getBoss } from './boss.js'
import { adminRepo, userRepo } from '../core/repositories/index.js'
import { mediaInputFor } from '../bot/media.js'
import { query } from '../infra/db.js'
import { loadEnv } from '../infra/env.js'
import { getLogger } from '../infra/logger.js'
import { nextNudgeDelaySeconds, pickNudge } from './nudgeContent.js'

export async function scheduleInactivityPing(
  telegramId: bigint,
  delaySeconds?: number,
): Promise<void> {
  const boss = await getBoss()
  const env = loadEnv()
  const seconds = delaySeconds ?? env.INACTIVITY_PING_HOURS * 3600
  await boss.sendDebounced(
    'inactivity-ping',
    { telegramId: telegramId.toString() },
    {},
    seconds,
    telegramId.toString(),
  )
}

const REBUILD_CONCURRENCY = 10

export async function rebuildInactivitySchedules(): Promise<void> {
  const log = getLogger()
  const startedAt = Date.now()
  const boss = await getBoss()
  await boss.deleteQueuedJobs('inactivity-ping')

  const env = loadEnv()
  const thresholdMs = env.INACTIVITY_PING_HOURS * 60 * 60 * 1000
  const rows = await query<{ telegram_id: string; last_activity: Date }>(
    `SELECT u.telegram_id, u.last_activity
     FROM users u
     LEFT JOIN admins a
       ON a.telegram_id = u.telegram_id
      AND a.removed_at IS NULL
     WHERE u.status = 'active'
       AND u.nudges_paused_at IS NULL
       AND u.bot_blocked_at IS NULL
       AND a.telegram_id IS NULL`,
  )

  const queue = rows.rows.slice()
  const total = queue.length
  log.info(
    { event: 'inactivity_rebuild_started', total, concurrency: REBUILD_CONCURRENCY },
    'rebuilding inactivity schedules',
  )

  let done = 0
  const workers = Array.from({ length: REBUILD_CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const row = queue.shift()
      if (!row) break
      const inactiveForMs = Date.now() - new Date(row.last_activity).getTime()
      const delaySeconds =
        inactiveForMs >= thresholdMs
          ? 60
          : Math.max(60, Math.ceil((thresholdMs - inactiveForMs) / 1000))
      try {
        await scheduleInactivityPing(BigInt(row.telegram_id), delaySeconds)
      } catch (err) {
        log.debug(
          { err, telegramId: row.telegram_id, event: 'inactivity_schedule_failed' },
          'one inactivity schedule failed; will rebuild on next deploy',
        )
      } finally {
        done += 1
      }
    }
  })

  await Promise.all(workers)
  log.info(
    { event: 'inactivity_rebuild_done', total, done, ms: Date.now() - startedAt },
    'inactivity schedules rebuilt',
  )
}

// pg-boss v12 defaults to one worker per .work() call. With a steady stream
// of nudge jobs (one per active user every 30 min) the queue serialised
// behind a single worker, so a slow Telegram sendPhoto would back up the
// entire schedule. localConcurrency: 10 spawns 10 parallel workers in this
// process; with batchSize: 1 each picks up one job at a time. 10 in-flight
// nudges × ~4 DB ops per nudge = ~40 connections worst case, comfortably
// inside our pool.max=50 budget. Telegram's per-chat rate limit isn't a
// concern because each nudge targets a distinct chat.
const INACTIVITY_PING_CONCURRENCY = 10

// Terminal Telegram delivery errors that mean "this chat will never accept
// another sendPhoto/sendMessage from us." Retrying is wasted API budget and
// looks like abuse to Telegram's anti-spam heuristics. Anything else (5xx,
// 429, timeouts) is transient and should be allowed to retry on the next
// scheduled tick.
function isUnreachableChatError(err: unknown): boolean {
  const code = extractTgErrorCode(err)
  if (code === 403) return true
  if (code === 400) {
    const description = extractTgDescription(err).toLowerCase()
    // chat not found: user deleted the chat / account.
    // user_bot_to_bot_disabled: target account is itself a bot — Telegram
    // forbids bot-to-bot DMs, no amount of retrying will fix it.
    return (
      description.includes('chat not found') ||
      description.includes('user_bot_to_bot_disabled')
    )
  }
  return false
}

function extractTgErrorCode(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; response?: { error_code?: unknown } }
    if (typeof e.code === 'number') return e.code
    if (typeof e.response?.error_code === 'number') return e.response.error_code
  }
  return undefined
}

function extractTgDescription(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { description?: unknown; response?: { description?: unknown }; message?: unknown }
    if (typeof e.description === 'string') return e.description
    if (typeof e.response?.description === 'string') return e.response.description
    if (typeof e.message === 'string') return e.message
  }
  return ''
}

export function registerInactivityPingWorker(boss: PgBoss, telegram: Telegram) {
  return boss.work<{ telegramId: string }>(
    'inactivity-ping',
    { batchSize: 1, localConcurrency: INACTIVITY_PING_CONCURRENCY },
    async (jobs) => {
      const job = jobs[0]
      if (!job) return
      const id = BigInt(job.data.telegramId)
      const log = getLogger().child({ event: 'nudge', telegramId: id.toString() })

      // Global kill-switch — set NUDGES_PAUSED=1 in Railway env and redeploy
      // to halt all nudge delivery process-wide. We still re-schedule so the
      // moment the flag flips off, the cadence resumes from the same beat.
      const env = loadEnv()
      if (env.NUDGES_PAUSED) {
        await scheduleInactivityPing(id, 30 * 60)
        return
      }

      const user = await userRepo.findById(id)
      if (!user || user.status !== 'active') return
      if (user.bot_blocked_at) {
        // Persisted flag from a previous failed send. Don't re-attempt and
        // don't re-schedule — the user has to /start again to come back.
        return
      }
      if (user.nudges_paused_at) {
        log.info({ event: 'nudge_skipped_paused' }, 'user paused nudges')
        return
      }

      const admin = await adminRepo.findById(id)
      if (admin && !admin.removed_at) return

      // If activity moved more recently than expected, re-arm at the original
      // 1h cadence rather than firing immediately.
      const thresholdMs = env.INACTIVITY_PING_HOURS * 60 * 60 * 1000
      const inactiveForMs = Date.now() - new Date(user.last_activity).getTime()
      if (inactiveForMs < thresholdMs) {
        const remainingSeconds = Math.max(60, Math.ceil((thresholdMs - inactiveForMs) / 1000))
        await scheduleInactivityPing(id, remainingSeconds)
        return
      }

      const nudge = pickNudge(user)

      // Delete the previous nudge first so the user only ever sees the latest
      // card. Failure here is fine — the message may be older than Telegram's
      // delete window or the user may have blocked the bot.
      if (user.last_nudge_message_id) {
        await telegram
          .deleteMessage(Number(id), user.last_nudge_message_id)
          .catch(() => {})
      }

      let sentMessageId: number | null = null
      try {
        if (nudge.image) {
          const sent = await telegram.sendPhoto(
            Number(id),
            mediaInputFor(nudge.image),
            {
              caption: nudge.text,
              parse_mode: nudge.parseMode,
              ...nudge.keyboard,
            },
          )
          sentMessageId = sent.message_id
        } else {
          const sent = await telegram.sendMessage(Number(id), nudge.text, {
            parse_mode: nudge.parseMode,
            ...nudge.keyboard,
          })
          sentMessageId = sent.message_id
        }
      } catch (err) {
        // Terminal Telegram errors mean the chat is gone — user blocked the
        // bot, deleted their account, or never opened the chat in the first
        // place. Flag the user so future schedules skip them entirely
        // instead of generating the same 403/400 every 30 minutes forever.
        if (isUnreachableChatError(err)) {
          await userRepo.markBotBlocked(id).catch((dbErr) => {
            log.warn(
              { err: dbErr, event: 'nudge_mark_blocked_failed' },
              'failed to persist bot_blocked_at after terminal send error',
            )
          })
          log.info(
            { event: 'nudge_chat_unreachable', tgErrorCode: extractTgErrorCode(err) },
            'user unreachable — flagging and stopping nudge cadence',
          )
          // Do NOT re-schedule. activityMw should clear bot_blocked_at on
          // the next /start, which is when we should pick the user back up.
          return
        }
        log.warn({ err, event: 'nudge_send_failed' }, 'failed to deliver nudge')
        return
      }

      await userRepo.setLastNudgeMessageId(id, sentMessageId)
      const newCount = await userRepo.incrementNudgeCount(id)
      const nextDelay = nextNudgeDelaySeconds(newCount)
      // Cadence loops forever (steady state at 24h after the escalation phase).
      // Only stops if the user taps Pause Notifications or blocks the bot —
      // a blocked send fails silently above and we still schedule the next.
      await scheduleInactivityPing(id, nextDelay)
      log.info(
        {
          event: 'nudge_sent',
          count: newCount,
          nextInSeconds: nextDelay,
          hasImage: Boolean(nudge.image),
          replacedMessageId: user.last_nudge_message_id,
        },
        'nudge delivered, next scheduled',
      )
    },
  )
}
