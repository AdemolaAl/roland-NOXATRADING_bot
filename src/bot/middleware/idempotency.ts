import type { Middleware } from 'telegraf'
import { processedUpdateRepo } from '../../core/repositories/index.js'
import { getLogger } from '../../infra/logger.js'
import type { BotContext } from '../index.js'

// Webhook delivery has at-least-once semantics: Telegram retries 5xx
// responses with backoff for ~24h. Without dedup, a handler that places
// a trade and then 5xx's would re-execute on every retry — double-trades
// against real money. Polling didn't have this risk because each
// getUpdates batch was offset-acknowledged.
//
// Strategy: claim each update_id atomically via INSERT ... ON CONFLICT
// DO NOTHING the moment we see it. Insert succeeds (rowCount=1) → first
// delivery, run the rest of the chain. Insert no-ops (rowCount=0) →
// duplicate, skip the chain entirely so Telegram gets a 200 OK without
// any side effects.
//
// Tradeoff: if a handler crashes AFTER the row insert but BEFORE all
// side effects complete, the retry is rejected and the user is stuck
// with half-applied state. The existing tradeInFlight stale-flag
// recovery (_sceneHelpers.ts:794) handles half-trades on the next
// /start, so this is acceptable. The alternative — record only on
// successful completion — would re-fire side effects on retry, which
// is the bug we're trying to prevent.
export const idempotencyMw: Middleware<BotContext> = async (ctx, next) => {
  const updateId = ctx.update?.update_id
  if (typeof updateId !== 'number') {
    // Defensive: every Telegram update has an update_id, but if
    // somehow we got an update without one, fall through rather than
    // block traffic.
    return next()
  }
  const fresh = await processedUpdateRepo.recordIfNew(updateId).catch((err) => {
    // DB blip on the dedup insert is fail-open: log and continue. A
    // duplicate trade is bad; refusing to process any updates because
    // Postgres is hiccuping is worse.
    getLogger().error(
      { err, updateId, event: 'idempotency_db_failed' },
      'idempotency check failed — running handler anyway',
    )
    return true
  })
  if (!fresh) {
    getLogger().info(
      { event: 'duplicate_update_skipped', updateId },
      'duplicate Telegram update — already processed, skipping handler chain',
    )
    return
  }
  await next()
}
