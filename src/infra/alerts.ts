import type { Telegram } from 'telegraf'
import { loadEnv } from './env.js'
import { getLogger } from './logger.js'

// Module-level Telegram client used to post operational alerts to
// ALERT_CHANNEL_ID. Same shape as getLogger — set once at boot via
// registerAlerter(bot.telegram), called from anywhere without
// threading the bot instance through call sites.
//
// Failure modes for the send are swallowed (warn-logged). An alert
// failing to deliver should never break the path that triggered it —
// the operational signal already exists in the structured logs we
// captured before reaching here.
let telegram: Telegram | null = null

export function registerAlerter(t: Telegram): void {
  telegram = t
}

export async function sendAlert(text: string, opts?: { parseMode?: 'Markdown' }): Promise<void> {
  if (!telegram) {
    // Not yet wired — happens during early boot or in tests. Log so
    // the missing-wire-up is visible, then no-op.
    getLogger().warn({ event: 'alert_dropped_no_telegram', preview: text.slice(0, 80) }, 'sendAlert called before registerAlerter')
    return
  }
  const env = loadEnv()
  if (!env.ALERT_CHANNEL_ID) return
  try {
    await telegram.sendMessage(env.ALERT_CHANNEL_ID, text, {
      parse_mode: opts?.parseMode ?? 'Markdown',
    })
  } catch (err) {
    getLogger().warn(
      { err, event: 'alert_send_failed', preview: text.slice(0, 80) },
      'failed to post alert to ALERT_CHANNEL_ID',
    )
  }
}
