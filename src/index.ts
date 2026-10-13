import http from 'node:http'
import type { Telegram } from 'telegraf'
import type { Logger } from 'pino'
import { createBot } from './bot/index.js'
import { adminRepo } from './core/repositories/index.js'
import { closePool, getPool, query } from './infra/db.js'
import { loadEnv } from './infra/env.js'
import { getLogger } from './infra/logger.js'
import { startPollWatchdog } from './infra/pollWatchdog.js'
import { ensureAdminCacheReady } from './bot/middleware/adminCache.js'
import { closeBoss, getBoss } from './jobs/boss.js'
import { reconcileInFlightTrades } from './jobs/tradeReconcile.js'
import { rebuildInactivitySchedules, registerInactivityPingWorker } from './jobs/inactivityPing.js'
import { getEgressIp, warmEgressIp } from './infra/egressIp.js'
import { registerAlerter } from './infra/alerts.js'
import { registerDepositPollWorker } from './jobs/depositPoll.js'
import { registerScheduledBroadcastWorker } from './jobs/scheduledBroadcast.js'
import { createAffstorePostbackHandler } from './web/affstorePostback.js'

// Post a "deploy live" card to ALERT_CHANNEL_ID on container boot so the
// team knows when a fresh deploy is ready for testing.
//
// Deploy notifications go to the alert channel ONLY — never DM individual
// admins. Multiple per-admin DMs created restart-alert spam that was easy
// to mistake for repeat deployments.
//
// Skipped outside production so `tsx watch` restarts during local dev
// don't post to the alert channel every time a file is saved.
async function notifyDeploy(telegram: Telegram, logger: Logger) {
  if (process.env.NODE_ENV !== 'production') {
    logger.debug({ event: 'deploy_notify_skipped_nonprod' }, 'skipping deploy notification (non-production)')
    return
  }
  const sha = (process.env.RAILWAY_GIT_COMMIT_SHA ?? '').slice(0, 7) || 'unknown'
  const branch = process.env.RAILWAY_GIT_BRANCH ?? 'main'
  // Escape Markdown special chars so commit subjects with underscores
  // (e.g. PAIR_SELECTION) don't break parse_mode='Markdown' and bounce
  // back as 400 "can't parse entities".
  const escapeMd = (s: string) => s.replace(/([_*`\[])/g, '\\$1')
  const message = escapeMd(
    process.env.RAILWAY_GIT_COMMIT_MESSAGE
      ?.split('\n')[0]
      ?.slice(0, 80) ?? '',
  ) || undefined
  const env = process.env.NODE_ENV ?? 'unknown'
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'

  const lines = [
    '🚀 *NOXATRADING deploy live*',
    '',
    `Env: \`${env}\``,
    `Branch: \`${branch}\``,
    `Commit: \`${sha}\``,
    message ? `Subject: ${message}` : null,
    `Time: ${time}`,
    '',
    'Ready for testing.',
  ]
    .filter(Boolean)
    .join('\n')

  // Failure modes here: bot not added to the chat, bot lacks Send Messages
  // permission, wrong ALERT_CHANNEL_ID format, bot blocked by the channel
  // admin. Log loudly with the exact reason — this is the diagnostic path
  // for "alerts aren't reaching the channel" complaints.
  const cfg = loadEnv()
  try {
    await telegram.sendMessage(cfg.ALERT_CHANNEL_ID, lines, { parse_mode: 'Markdown' })
    logger.info(
      { event: 'deploy_alert_channel_sent', channel: cfg.ALERT_CHANNEL_ID, sha },
      'deploy notification posted to alert channel',
    )
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    logger.error(
      {
        err,
        errMessage,
        channel: cfg.ALERT_CHANNEL_ID,
        event: 'deploy_alert_channel_failed',
      },
      `could not post to ALERT_CHANNEL_ID=${cfg.ALERT_CHANNEL_ID}: ${errMessage}`,
    )
  }
}

async function shutdown(signal: string, bot: ReturnType<typeof createBot>) {
  getLogger().info({ event: 'shutdown', signal }, 'shutting down')
  bot.stop(signal)
  await closeBoss()
  await closePool()
  process.exit(0)
}

// Belt-and-braces: catch any async error that escaped a handler so the
// process keeps running instead of crash-looping. Without this, one user
// typing a bad IQ password while their handler was racing a setTimeout
// took the whole bot down (and produced the deploy-notification spam as
// Railway kept restarting). Log it loudly so we still notice, but never
// let it kill the process. Same for synchronous uncaught throws.
//
// One known noisy source: @tradecodehub/client-sdk-js leaks a setTimeout
// when its WebSocket transport is torn down (cache eviction → logout →
// shutdown). The leftover timer fires WsApiClient.unsubscribe() on a
// transport that's already been nulled, throwing
// "Cannot read properties of undefined (reading 'send')" once a minute
// per leaked timer. It's an SDK-internal cleanup bookkeeping packet, not
// a functional error — the WebSocket and its subscriptions are already
// dead, the IQ server expires them on its end, and the user-facing flow
// is unaffected. We still want the safety net to stay alive, but logging
// it at ERROR drowns out real rejections, so we downgrade these specific
// rejections to DEBUG (suppressed at production LOG_LEVEL=info).
function isSdkTransportNoise(err: Error): boolean {
  if (err.name !== 'TypeError') return false
  if (!/reading 'send'/.test(err.message)) return false
  const stack = err.stack ?? ''
  return /tradecodehub\/client-sdk-js|WsApiClient/.test(stack)
}
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason))
  if (isSdkTransportNoise(err)) {
    getLogger().debug({ err, event: 'iq_sdk_orphan_timer' }, 'IQ SDK orphan timer fired post-shutdown (harmless)')
    return
  }
  // egressIp stamped on every unhandled rejection so when IQ-side WebSocket
  // failures bubble up async (e.g. ETIMEDOUT to 45.88.36.129, WS stuck in
  // CONNECTING), the operator has the public IP to give IQ support without
  // running /diag_iq.
  getLogger().error(
    { err, event: 'unhandled_rejection', egressIp: getEgressIp() },
    'unhandled promise rejection — process kept alive',
  )
})
process.on('uncaughtException', (err) => {
  getLogger().error(
    { err, event: 'uncaught_exception', egressIp: getEgressIp() },
    'uncaught exception — process kept alive',
  )
})

// Polls the event loop every second; when the actual delay exceeds 1s by
// more than 200ms, something synchronous is blocking the loop (heavy log
// serialization, sync crypto, a tight loop). Logs the lag so we can find
// it without a profiler.
function startEventLoopLagProbe(): void {
  const PROBE_INTERVAL_MS = 1000
  const LAG_THRESHOLD_MS = 200
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const lag = now - last - PROBE_INTERVAL_MS
    last = now
    if (lag >= LAG_THRESHOLD_MS) {
      getLogger().warn(
        { event: 'event_loop_lag_ms', ms: lag },
        'event loop lagged',
      )
    }
  }, PROBE_INTERVAL_MS)
  timer.unref?.()
}

async function main() {
  const logger = getLogger()
  logger.info({ event: 'boot_start' }, 'NOXATRADING bot booting')

  // Kick off the egress IP probe so the cache is populated before any IQ
  // failure can occur. Fire-and-forget — the first probe completes in ~1s,
  // and every error log path tolerates a null value during that window.
  warmEgressIp()

  startEventLoopLagProbe()

  getPool()
  logger.debug({ event: 'db_pool_ready' }, 'Postgres pool initialized')

  await adminRepo.seedFromEnv()
  logger.debug({ event: 'admin_seeded' }, 'super-admin seeded from env')

  // Prime the in-memory admin lookup before the first Telegram update can
  // hit activityMw. activityMw consults isAdminCached() to decide whether
  // to re-arm the inactivity ping; an empty cache would briefly mis-treat
  // admins as regular users (sending them a redundant pg-boss enqueue),
  // not catastrophic but fixable for free at boot.
  await ensureAdminCacheReady()
  logger.debug({ event: 'admin_cache_primed' }, 'admin cache primed')

  const bot = createBot()
  logger.debug({ event: 'telegraf_built' }, 'Telegraf instance built')

  // Wire the module-level alert helper so any code path can post to
  // ALERT_CHANNEL_ID without threading the Telegram instance through
  // its call chain. Used by the silent re-auth monitor (and any
  // future operational alerter that fits the same shape).
  registerAlerter(bot.telegram)

  const affstorePostbackHandler = createAffstorePostbackHandler({ telegram: bot.telegram })

  const env = loadEnv()
  const port = Number(process.env.PORT ?? '3000')
  // Health probe philosophy: we want Railway to know the BOT process is
  // responsive, not necessarily that every DB query is fast. A SELECT 1
  // raced with a 1.5s timer covers both: fast path returns OK, slow path
  // returns "degraded" (200) so Railway doesn't restart the container
  // during a transient DB stall, and only a hard query error returns 503.
  // Restarts mid-flow drop in-flight Telegraf handlers and confuse users.
  const HEALTH_DB_TIMEOUT_MS = 1500
  // Captured by the http server below. Stays null under polling; populated
  // by bot.createWebhook(...) under webhook transport. Declared here so
  // the closure binds to the same variable that the webhook setup code
  // assigns later.
  type WebhookHandler = Awaited<ReturnType<typeof bot.createWebhook>>
  let webhookHandler: WebhookHandler | null = null
  let webhookPath: string | null = null
  http
    .createServer(async (req, res) => {
      if (req.url === '/health') {
        let timer: NodeJS.Timeout | undefined
        const timeoutSentinel = Symbol('health_db_timeout')
        try {
          const probe = query('SELECT 1')
          const result = await Promise.race([
            probe.then(() => 'ok' as const),
            new Promise<typeof timeoutSentinel>((resolve) => {
              timer = setTimeout(() => resolve(timeoutSentinel), HEALTH_DB_TIMEOUT_MS)
            }),
          ])
          if (result === timeoutSentinel) {
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end('degraded')
          } else {
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end('OK')
          }
        } catch {
          res.writeHead(503, { 'Content-Type': 'text/plain' }).end('DB unhealthy')
        } finally {
          if (timer) clearTimeout(timer)
        }
        return
      }

      if (req.url?.startsWith('/affstore-postback')) {
        await affstorePostbackHandler(req, res)
        return
      }

      // Webhook route: only matches when transport=webhook AND the path
      // matches the secret hash. The handler verifies the
      // X-Telegram-Bot-Api-Secret-Token header before accepting the body.
      if (webhookHandler && req.url === webhookPath) {
        await webhookHandler(req, res, () => {
          res.writeHead(404).end()
        })
        return
      }

      res.writeHead(404).end()
    })
    .listen(port)

  // Telegraf 4.x: launch() resolves once long-polling has started, then the
  // bot keeps running in the background — it does not block this function.
  // bot.launch() doesn't resolve until the bot stops, so we kick it off
  // without awaiting and handle errors via the catch chain. On 409 Conflict
  // (a stale getUpdates session from a previous container during a rolling
  // deploy), we retry a few times with backoff to let the old session drain.
  const launchOnce = async () => {
    await bot.launch({ dropPendingUpdates: true })
  }

  const launchWithRetry = async () => {
    const maxAttempts = 6
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await launchOnce()
        return
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const is409 = /409|conflict|terminated by other/i.test(msg)
        if (!is409 || attempt === maxAttempts) {
          throw err
        }
        const waitMs = 10_000
        logger.warn(
          { errMessage: msg, attempt, waitMs, event: 'launch_409_retry' },
          `launch hit 409, waiting ${waitMs}ms for the old session to drain`,
        )
        await new Promise((r) => setTimeout(r, waitMs))
      }
    }
  }

  const runPostLaunchTasks = async () => {
    const boss = await getBoss()
    registerInactivityPingWorker(boss, bot.telegram)
    registerDepositPollWorker(boss, bot.telegram)
    registerScheduledBroadcastWorker(boss, bot.telegram)
    logger.debug({ event: 'workers_registered' }, 'pg-boss workers registered')

    void rebuildInactivitySchedules()
      .then(() =>
        logger.debug({ event: 'inactivity_rebuilt' }, 'inactivity schedules rebuilt'),
      )
      .catch((err) =>
        logger.warn({ err, event: 'inactivity_rebuild_failed' }, 'inactivity rebuild failed'),
      )

    void reconcileInFlightTrades()
      .then(() =>
        logger.debug({ event: 'trades_reconciled' }, 'in-flight trades reconciled'),
      )
      .catch((err) =>
        logger.warn({ err, event: 'trade_reconcile_failed' }, 'trade reconciliation failed'),
      )

    void notifyDeploy(bot.telegram, logger)

    // Register the bot commands menu (the hamburger icon next to the
    // input field). Gives users a tap-to-send list of slash commands so
    // they don't need to remember /start. Idempotent — safe to call on
    // every boot. Failures are non-fatal, just logged.
    bot.telegram
      .setMyCommands([
        { command: 'start', description: '🏠  Open NOXATRADING' },
        { command: 'delete', description: '🗑  Delete my account & start over' },
      ])
      .then(() =>
        logger.info({ event: 'commands_menu_set' }, 'bot commands menu registered'),
      )
      .catch((err) =>
        logger.warn(
          { err, event: 'commands_menu_set_failed' },
          'failed to register bot commands menu',
        ),
      )
  }

  if (env.BOT_TRANSPORT === 'webhook') {
    // Webhook transport: Telegram pushes updates to /<secret-path> on the
    // existing :8080 HTTP server. createWebhook calls setWebhook against
    // the Telegram API as a side effect — successful resolve means
    // Telegram now knows the URL and will start delivering updates.
    const domain = env.WEBHOOK_DOMAIN ?? env.RAILWAY_PUBLIC_DOMAIN
    if (!domain) {
      // env validator should have caught this; defensive only.
      throw new Error('webhook transport requires WEBHOOK_DOMAIN or RAILWAY_PUBLIC_DOMAIN')
    }
    if (!env.WEBHOOK_SECRET_TOKEN) {
      throw new Error('webhook transport requires WEBHOOK_SECRET_TOKEN')
    }
    // secretPathComponent hashes the bot token (sha3-256), so the path is
    // unguessable without the token. secret_token is a separate random
    // value Telegram echoes in X-Telegram-Bot-Api-Secret-Token — Telegraf
    // verifies it. Two layers of "this POST really is from Telegram".
    const path = `/telegraf/${bot.secretPathComponent()}`
    webhookPath = path
    try {
      webhookHandler = await bot.createWebhook({
        domain,
        path,
        secret_token: env.WEBHOOK_SECRET_TOKEN,
        drop_pending_updates: true,
      })
      logger.info(
        { event: 'bot_ready', port, transport: 'webhook', domain, path },
        `NOXATRADING bot online — webhook set on https://${domain}${path}, /health on :${port}`,
      )
    } catch (err) {
      logger.fatal({ err, event: 'webhook_setup_failed' }, 'failed to set Telegram webhook')
      process.exit(1)
    }
    // Watchdog is intentionally not started under webhook mode — its
    // recovery callback (bot.stop + bot.launch) is wrong for webhook.
    // Webhook health is monitored via Telegram's getWebhookInfo API
    // (last_error_message, pending_update_count) — future work.
  } else {
    // Polling transport: Telegraf long-poll loop calls getUpdates in a
    // tight loop and feeds each update into the same middleware chain.
    // Subject to silent-stall failure mode under load — see commit
    // ed15309 watchdog recovery.
    void launchWithRetry()
      .then(() => {
        logger.debug({ event: 'bot_launch_resolved' }, 'bot.launch promise resolved')
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        logger.fatal(
          { err, errMessage: msg, event: 'bot_launch_failed' },
          `bot.launch crashed: ${msg}`,
        )
        process.exit(1)
      })

    // In-process polling recovery: when the watchdog detects 90+ sec of
    // silence, prefer stop+relaunch on the current bot instance. Saves
    // the Railway boot cycle and keeps the IQ websocket cache warm.
    // Falls back to process.exit(1) inside the watchdog on failure.
    startPollWatchdog({
      onFatalQuiet: async () => {
        try {
          bot.stop('watchdog_recover')
        } catch (err) {
          // Telegraf throws "Bot is not running!" if polling already died.
          logger.debug({ err, event: 'poll_watchdog_stop_noop' }, 'bot.stop noop')
        }
        void launchWithRetry()
          .then(() =>
            logger.info({ event: 'poll_watchdog_recovered' }, 'polling re-launched in-process'),
          )
          .catch((err) => {
            logger.fatal(
              { err, event: 'poll_watchdog_relaunch_failed' },
              'in-process re-launch failed',
            )
            process.exit(1)
          })
      },
    })

    logger.info(
      { event: 'bot_ready', port, transport: 'polling' },
      `NOXATRADING bot online — long-polling Telegram, /health on :${port}`,
    )
  }

  void runPostLaunchTasks()

  process.once('SIGINT', () => {
    void shutdown('SIGINT', bot)
  })
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM', bot)
  })
}

void main().catch((err) => {
  getLogger().fatal({ err, event: 'startup_failed' }, 'startup failed')
  process.exit(1)
})
