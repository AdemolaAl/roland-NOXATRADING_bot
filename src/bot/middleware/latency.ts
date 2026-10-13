import type { Middleware } from 'telegraf'
import { getLogger } from '../../infra/logger.js'
import type { BotContext } from '../index.js'

const SLOW_UPDATE_MS = 500

// Times every update through the rest of the middleware chain. Logs only
// the slow ones (>500ms) to keep noise down — under healthy load most
// updates complete in single-digit ms. When something hangs, this is the
// signal that tells us *which* update was slow (callback vs text vs photo)
// and which scene was active, so we can drill in without having to
// reproduce locally.
export const latencyMw: Middleware<BotContext> = async (ctx, next) => {
  const startedAt = Date.now()
  try {
    await next()
  } finally {
    const ms = Date.now() - startedAt
    if (ms >= SLOW_UPDATE_MS) {
      const update = ctx.update as unknown as Record<string, unknown>
      const updateType =
        'callback_query' in update
          ? 'callback'
          : 'message' in update
            ? 'message'
            : (Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown')
      const callbackData =
        ctx.callbackQuery && 'data' in ctx.callbackQuery
          ? String(ctx.callbackQuery.data)
          : undefined
      const messageText =
        ctx.message && 'text' in ctx.message ? ctx.message.text.slice(0, 40) : undefined
      const sceneId =
        ((ctx.session as Record<string, unknown> | undefined)?.__scenes as
          | { current?: string }
          | undefined)?.current ?? null

      getLogger().info(
        {
          event: 'update_ms',
          ms,
          updateType,
          telegramId: ctx.from?.id,
          sceneId,
          callbackData,
          messageText,
        },
        'slow telegram update',
      )
    }
  }
}
