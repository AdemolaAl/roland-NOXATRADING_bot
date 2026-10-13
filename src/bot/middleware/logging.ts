import type { Middleware } from 'telegraf'
import { getLogger } from '../../infra/logger.js'
import { markUpdateReceived } from '../../infra/pollWatchdog.js'
import type { BotContext } from '../index.js'

// Throughput counter — every update increments these in memory. Once a
// minute we log a single rollup so the operator can see the bot is alive
// and how busy it is, without spamming one log line per update.
const stats = {
  updates: 0,
  callbacks: 0,
  messages: 0,
  windowStart: Date.now(),
}

setInterval(() => {
  const now = Date.now()
  const elapsedSeconds = (now - stats.windowStart) / 1000
  if (stats.updates > 0) {
    getLogger().info(
      {
        event: 'tg_throughput',
        windowSeconds: Math.round(elapsedSeconds),
        updates: stats.updates,
        callbacks: stats.callbacks,
        messages: stats.messages,
        updatesPerSec: Number((stats.updates / elapsedSeconds).toFixed(2)),
      },
      'telegram throughput',
    )
  }
  stats.updates = 0
  stats.callbacks = 0
  stats.messages = 0
  stats.windowStart = now
}, 60_000).unref()

// Per-update logging is the dominant log source — at viral scale (hundreds
// of updates/sec) it alone exceeds Railway's 500 logs/sec rate limit, which
// causes Railway to silently drop log lines, including ones we actually
// need to see. So we emit `tg_update` at DEBUG level by default; flip
// LOG_LEVEL=debug temporarily if you need the per-update breadcrumb trail.
// Errors, IQ events, nudge sends, etc. stay at INFO — those are the signals
// we always want.
export const loggingMw: Middleware<BotContext> = async (ctx, next) => {
  const logger = ctx.logger ?? getLogger()
  markUpdateReceived()
  stats.updates += 1
  if (ctx.callbackQuery) {
    stats.callbacks += 1
  } else if (ctx.message) {
    stats.messages += 1
  }
  const textPreview =
    ctx.message && 'text' in ctx.message && typeof ctx.message.text === 'string'
      ? ctx.message.text.slice(0, 40)
      : undefined
  const callbackData =
    ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined
  logger.debug(
    {
      event: 'tg_update',
      telegramId: ctx.from?.id,
      username: ctx.from?.username,
      updateType: ctx.updateType,
      chatId: ctx.chat?.id,
      ...(textPreview ? { textPreview } : {}),
      ...(callbackData ? { callbackData } : {}),
    },
    'telegram update',
  )
  await next()
}
