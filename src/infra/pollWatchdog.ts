import { getLogger } from './logger.js'

// Telegraf's long-poll has stalled silently in production: getUpdates hits
// a 409 (stale container) or transient network error and the polling loop
// quietly stops while the rest of the process keeps running. Without a
// watchdog we don't notice until users complain — the only signal is the
// absence of the per-minute tg_throughput log line.
//
// The watchdog: warn at 60s of zero updates, recover at 90s. Recovery
// prefers an in-process re-launch (bot.stop + bot.launch again) so the
// IQ websocket cache stays warm and there's no Railway boot cycle. If no
// recovery callback is wired or it fails, we exit(1) and let Railway
// restart. Threshold tightened from 3 min after observing repeat stalls
// in prod 2026-05-09 — true 90-sec silence during active hours is rare
// for this bot. Operators can disable exit-on-quiet entirely with
// POLL_WATCHDOG_EXIT_ON_QUIET=0.

type RecoveryFn = () => Promise<void>

let lastUpdateAt = Date.now()
let watchdogTimer: NodeJS.Timeout | null = null
let warnedQuiet = false
let warnedFatalQuiet = false
let recovering = false

const CHECK_INTERVAL_MS = 30_000
const WARN_AFTER_MS = 60_000
const FATAL_AFTER_MS = 90_000
const BOOT_GRACE_MS = 60_000

export function shouldExitOnQuiet(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.POLL_WATCHDOG_EXIT_ON_QUIET?.toLowerCase()
  if (value === '0' || value === 'false') return false
  return true
}

export function markUpdateReceived(): void {
  lastUpdateAt = Date.now()
  warnedQuiet = false
  warnedFatalQuiet = false
}

export function startPollWatchdog(opts?: { onFatalQuiet?: RecoveryFn }): void {
  if (watchdogTimer) return
  const startedAt = Date.now()
  watchdogTimer = setInterval(() => {
    const sinceUpdate = Date.now() - lastUpdateAt
    const sinceBoot = Date.now() - startedAt
    if (sinceBoot < BOOT_GRACE_MS) return
    if (sinceUpdate >= FATAL_AFTER_MS) {
      // Re-entrancy guard: the timer ticks every 30s, but in-process
      // recovery may take longer. Without this we'd stack stop/launch
      // calls on each tick.
      if (recovering) return
      if (!shouldExitOnQuiet()) {
        if (!warnedFatalQuiet) {
          getLogger().warn(
            { event: 'poll_watchdog_idle', sinceUpdateMs: sinceUpdate },
            'no Telegram updates for 90+ sec — bot is idle, staying online',
          )
          warnedFatalQuiet = true
        }
        return
      }
      if (opts?.onFatalQuiet) {
        recovering = true
        getLogger().warn(
          { event: 'poll_watchdog_recovering', sinceUpdateMs: sinceUpdate },
          'no Telegram updates for 90+ sec — attempting in-process polling re-launch',
        )
        void opts
          .onFatalQuiet()
          .then(() => {
            // Reset the silence clock so a slow first poll after recovery
            // doesn't immediately re-trigger. markUpdateReceived will be
            // called again as soon as the next real update arrives.
            markUpdateReceived()
            recovering = false
          })
          .catch((err) => {
            getLogger().fatal(
              { err, event: 'poll_watchdog_recover_failed' },
              'in-process recovery failed — exiting so Railway restarts',
            )
            process.exit(1)
          })
        return
      }
      getLogger().fatal(
        { event: 'poll_watchdog_dead', sinceUpdateMs: sinceUpdate },
        'no Telegram updates for 90+ sec — exiting so Railway restarts',
      )
      process.exit(1)
    } else if (sinceUpdate >= WARN_AFTER_MS && !warnedQuiet) {
      getLogger().warn(
        { event: 'poll_watchdog_quiet', sinceUpdateMs: sinceUpdate },
        'no Telegram updates for 60+ sec — bot may simply be idle',
      )
      warnedQuiet = true
    }
  }, CHECK_INTERVAL_MS)
  watchdogTimer.unref?.()
}

export function stopPollWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
  warnedQuiet = false
  warnedFatalQuiet = false
  recovering = false
}
