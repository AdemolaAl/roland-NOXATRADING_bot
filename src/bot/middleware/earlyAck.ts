import type { Middleware } from 'telegraf'
import type { BotContext } from '../index.js'

// Fire the callback-query ACK as early as possible — BEFORE any DB work,
// scene rehydration, or scene logic — so Telegram's spinner clears within
// the ~10s window even when the rest of the middleware chain is queued
// behind a backlog.
//
// We then replace ctx.answerCbQuery with a no-op so legacy handlers
// downstream that still call ctx.answerCbQuery('Demo mode 🧪') don't fire
// a second API call (which would error with "query ID is invalid" because
// we already answered). The toast text those handlers wanted to show is a
// nice-to-have; the user-visible scene reply that follows is the real
// signal the action worked.
export const earlyAckMw: Middleware<BotContext> = async (ctx, next) => {
  if (ctx.callbackQuery && 'id' in ctx.callbackQuery) {
    void ctx.telegram
      .callApi('answerCallbackQuery', { callback_query_id: ctx.callbackQuery.id })
      .catch(() => {})
    ctx.answerCbQuery = (async () => true) as typeof ctx.answerCbQuery
  }
  await next()
}
