import type { Telegram } from 'telegraf'
import type { PgBoss } from 'pg-boss'
import { broadcastRepo } from '../core/repositories/index.js'
import { buildSegmentQuery } from '../core/services/broadcastSegmenter.js'
import { personalizeMessage } from '../core/services/messagePersonalize.js'
import { query } from '../infra/db.js'
import { getLogger } from '../infra/logger.js'

type RecipientRow = {
  telegram_id: string
  telegram_username: string | null
  telegram_first_name: string | null
}

// Inflate the segment query so it returns name + username for placeholders.
function buildRecipientQuery(segment: string): { text: string; params: unknown[] } {
  const inner = buildSegmentQuery(segment as never)
  return {
    text: `SELECT u.telegram_id, u.telegram_username, u.telegram_first_name
           FROM users u
           WHERE u.telegram_id IN (${inner.text})`,
    params: inner.params,
  }
}

export function registerScheduledBroadcastWorker(boss: PgBoss, telegram: Telegram) {
  return boss.work<{ broadcastId: string }>('broadcast-send', async (jobs) => {
    const job = jobs[0]
    if (!job) return
    const broadcast = await broadcastRepo.findById(job.data.broadcastId)
    if (!broadcast) return

    const log = getLogger().child({ event: 'broadcast', broadcastId: broadcast.id })
    await broadcastRepo.markSending(broadcast.id)

    const built = buildRecipientQuery(broadcast.segment)
    const recipients = await query<RecipientRow>(built.text, built.params)
    const total = recipients.rows.length

    // Progress message in the admin's DM. We edit it as we go so the admin
    // knows the bot isn't frozen.
    const adminId = Number(broadcast.created_by_admin_id)
    let statusMessageId: number | null = null
    try {
      const sent = await telegram.sendMessage(
        adminId,
        `📣 Sending broadcast to *${total}* recipient${total === 1 ? '' : 's'}…`,
        { parse_mode: 'Markdown' },
      )
      statusMessageId = sent.message_id
    } catch {
      // admin may have blocked the bot — proceed without progress UI
    }

    const editStatus = async (text: string) => {
      if (!statusMessageId) return
      await telegram
        .editMessageText(adminId, statusMessageId, undefined, text, {
          parse_mode: 'Markdown',
        })
        .catch(() => {})
    }

    let delivered = 0
    let failed = 0
    const startedAt = Date.now()
    // Update progress at most once every ~750ms to avoid Telegram edit limits.
    let lastEditAt = 0
    const PROGRESS_INTERVAL_MS = 750

    try {
      for (let i = 0; i < total; i++) {
        const row = recipients.rows[i]!
        const text = personalizeMessage(broadcast.message_text, {
          firstName: row.telegram_first_name,
          username: row.telegram_username,
        })
        const recipientId = Number(row.telegram_id)

        try {
          if (broadcast.media_kind && broadcast.media_file_id) {
            // Reuse Telegram file_id — no re-upload, near-instant delivery.
            const opts = text ? { caption: text } : undefined
            switch (broadcast.media_kind) {
              case 'photo':
                await telegram.sendPhoto(recipientId, broadcast.media_file_id, opts)
                break
              case 'video':
                await telegram.sendVideo(recipientId, broadcast.media_file_id, opts)
                break
              case 'document':
                await telegram.sendDocument(recipientId, broadcast.media_file_id, opts)
                break
              case 'animation':
                await telegram.sendAnimation(recipientId, broadcast.media_file_id, opts)
                break
              default:
                await telegram.sendMessage(recipientId, text)
            }
          } else {
            await telegram.sendMessage(recipientId, text)
          }
          delivered += 1
        } catch (err) {
          failed += 1
          log.warn(
            { err, recipient: row.telegram_id, event: 'broadcast_send_failed' },
            'broadcast delivery failed',
          )
        }

        const now = Date.now()
        const isLast = i === total - 1
        if (isLast || now - lastEditAt >= PROGRESS_INTERVAL_MS) {
          lastEditAt = now
          const done = delivered + failed
          const pct = total === 0 ? 100 : Math.floor((done / total) * 100)
          const bar = renderProgressBar(pct)
          await editStatus(
            [
              `📣 *Broadcasting…*`,
              '',
              `${bar} ${pct}%`,
              `Sent: *${done}/${total}*  ·  ✅ ${delivered}  ·  ❌ ${failed}`,
            ].join('\n'),
          )
        }

        // Stay below Telegram's 30 messages/sec hard limit.
        await new Promise((resolve) => setTimeout(resolve, 35))
      }

      await broadcastRepo.markSent(broadcast.id, delivered, failed)
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
      await editStatus(
        [
          `✅ *Broadcast complete*`,
          '',
          `Delivered: *${delivered}/${total}*`,
          failed > 0 ? `Failed: *${failed}*` : '',
          `Took: *${seconds}s*`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
    } catch (err) {
      log.error({ err, event: 'broadcast_aborted' }, 'broadcast aborted unexpectedly')
      await broadcastRepo.markFailed(broadcast.id)
      await editStatus(
        `❌ *Broadcast failed*\n\nDelivered: ${delivered}/${total} before the error.`,
      )
    }
  })
}

function renderProgressBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, pct))
  const filled = Math.round((clamped / 100) * width)
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`
}
