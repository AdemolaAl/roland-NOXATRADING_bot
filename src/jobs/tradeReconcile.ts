import { decryptString } from '../core/services/encryption.js'
import { query } from '../infra/db.js'
import { loadEnv } from '../infra/env.js'
import { getLogger } from '../infra/logger.js'
import { getCachedClient, invalidateCachedClient } from '../trading/iqSessionCache.js'

type PendingTrade = {
  id: string
  user_telegram_id: string
  iq_session_token: string | null
  account_mode: 'demo' | 'live'
  gale_steps: Array<{ iq_trade_id?: string; outcome?: string }>
}

const RECONCILE_BATCH = 100
const RECONCILE_CONCURRENCY = 5

// Run once at boot (post-launch). Best-effort attempt to settle trades that
// were mid-flight when the previous container died. Capped at RECONCILE_BATCH
// rows and runs at most RECONCILE_CONCURRENCY at a time so it can't starve
// the rest of the bot under viral load — older unsettled trades will be
// picked up on the next deploy.
export async function reconcileInFlightTrades(): Promise<void> {
  const log = getLogger()
  const startedAt = Date.now()
  const result = await query<PendingTrade>(
    `SELECT t.id, t.user_telegram_id, t.gale_steps, u.iq_session_token, u.account_mode
     FROM trades t
     JOIN users u ON u.telegram_id = t.user_telegram_id
     WHERE t.ended_at IS NULL
     ORDER BY t.started_at DESC
     LIMIT $1`,
    [RECONCILE_BATCH],
  )

  const queue = result.rows.slice()
  log.info(
    { event: 'reconcile_started', total: queue.length, concurrency: RECONCILE_CONCURRENCY },
    'reconciling in-flight trades',
  )

  let done = 0
  const env = loadEnv()
  const workers = Array.from({ length: RECONCILE_CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const trade = queue.shift()
      if (!trade) break
      try {
        await reconcileOne(trade, env.SESSION_ENCRYPTION_KEY)
      } catch (err) {
        log.debug(
          { err, tradeId: trade.id, event: 'reconcile_one_failed' },
          'reconcile of one trade failed; will retry on next boot',
        )
      } finally {
        done += 1
        if (done % 10 === 0) {
          log.debug(
            { event: 'reconcile_progress', done, total: result.rows.length },
            'reconcile progress',
          )
        }
      }
    }
  })

  await Promise.all(workers)
  log.info(
    { event: 'reconcile_done', total: result.rows.length, ms: Date.now() - startedAt },
    'reconcile complete',
  )
}

async function reconcileOne(trade: PendingTrade, encryptionKey: string): Promise<void> {
  const lastStep = trade.gale_steps[trade.gale_steps.length - 1]
  if (!lastStep?.iq_trade_id || lastStep.outcome) {
    return
  }
  if (!trade.iq_session_token) {
    return
  }

  const telegramId = BigInt(trade.user_telegram_id)
  const sessionToken = trade.iq_session_token
  let client
  try {
    client = await getCachedClient(telegramId, trade.account_mode, () =>
      decryptString(sessionToken, encryptionKey),
    )
  } catch {
    // resumeSession failed — the stored session is dead. Drop the cache
    // entry; user's next real action will hit the login flow.
    await invalidateCachedClient(telegramId)
    return
  }
  try {
    await client.setAccountMode(trade.account_mode)
    await client.awaitResult(lastStep.iq_trade_id, 1000)
  } catch {
    // awaitResult timeout / position not closed in 1s is the normal case
    // for in-flight trades — keep the warm client cached. Only the resume
    // failure above means the session is actually dead.
  }
}
