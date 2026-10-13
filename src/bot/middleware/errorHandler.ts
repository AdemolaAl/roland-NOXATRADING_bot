import type { Middleware } from 'telegraf'
import { loadEnv } from '../../infra/env.js'
import { getLogger } from '../../infra/logger.js'
import type { BotContext } from '../index.js'

// Telegram-side errors that are cosmetic and outside our control. When
// they happen we still want a single warn-level log line for the record,
// but we DON'T want to:
//   - reply "Something glitched, try again." to the user (panics them
//     into spamming /start, which compounds the load problem)
//   - DM admins (one extra outbound API call per error, multiplying
//     pressure on the same Telegram bottleneck that caused the failure)
const COSMETIC_TG_ERRORS = [
  'query is too old',                    // callback_query timed out (~10s)
  'query ID is invalid',                 // callback_query already answered
  'message is not modified',             // editMessageText with same content
  'message to edit not found',           // user deleted the original message
  'message to delete not found',
  'message can\'t be edited',
  "message can't be edited",
  'MESSAGE_ID_INVALID',
]

// Transient connectivity errors between this process and api.telegram.org.
// These come from node-fetch as `FetchError` with an `errno` of one of the
// codes below. Causes are upstream (Railway egress blip, Telegram regional
// flake, DNS failure) — not anything the bot can fix at runtime. Treat
// like cosmetic: one WARN log, no user reply (the reply itself would
// fail the same way and burn another connection), no admin DM (the DM
// would also fail and stack a third in-flight request on the broken path).
// The user's next interaction recovers naturally once the blip clears.
const TRANSIENT_NETWORK_CODES = new Set([
  'ETIMEDOUT',     // socket-level timeout (most common)
  'ECONNRESET',    // peer reset mid-request
  'ECONNREFUSED',  // egress blocked momentarily
  'ENOTFOUND',     // DNS lookup failed
  'EAI_AGAIN',     // DNS temporary failure
  'EHOSTUNREACH',  // routing blip
  'ENETUNREACH',
])

function isCosmetic(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return COSMETIC_TG_ERRORS.some((needle) => message.includes(needle))
}

function isTransientNetwork(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; type?: string; code?: string; errno?: string }
  // node-fetch tags its errors with type === 'FetchError'; we also accept
  // any error carrying one of the connectivity errno codes regardless of
  // type (some wrappers bury the FetchError underneath).
  const isFetchError = e.type === 'FetchError' || e.name === 'FetchError'
  const code = e.code ?? e.errno
  if (!code) return false
  return isFetchError || TRANSIENT_NETWORK_CODES.has(code)
}

// Throttle admin error alerts — at most one per minute per error type per
// process. Without this, a single misconfiguration at scale fires hundreds
// of admin DMs in seconds, stacking onto the same Telegram queue that's
// already underwater.
const lastAlertAt = new Map<string, number>()
const ALERT_COOLDOWN_MS = 60_000

function shouldAlertAdmins(message: string): boolean {
  const now = Date.now()
  const last = lastAlertAt.get(message) ?? 0
  if (now - last < ALERT_COOLDOWN_MS) {
    return false
  }
  lastAlertAt.set(message, now)
  return true
}

export const errorHandlerMw: Middleware<BotContext> = async (ctx, next) => {
  try {
    await next()
  } catch (err) {
    const logger = ctx.logger ?? getLogger()
    const cosmetic = isCosmetic(err)
    const transient = isTransientNetwork(err)
    const swallow = cosmetic || transient
    const message = err instanceof Error ? err.message : String(err)
    const code = (err as { code?: string })?.code

    logger[swallow ? 'warn' : 'error'](
      {
        err,
        event: cosmetic
          ? 'tg_cosmetic_error'
          : transient
            ? 'tg_transient_network_error'
            : 'tg_middleware_error',
        telegramId: ctx.from?.id,
        updateType: ctx.updateType,
        code,
      },
      cosmetic
        ? 'cosmetic telegram error swallowed'
        : transient
          ? `transient network blip to telegram (${code ?? 'unknown'}) — swallowed`
          : 'telegram middleware error',
    )

    if (swallow) {
      // Cosmetic: the action probably succeeded; user sees at worst a
      // briefly stuck spinner. Transient network: the user's next
      // interaction will succeed once the blip clears, and any reply
      // we attempt now would fail the same way on the same broken
      // socket. In both cases, don't reply, don't DM admins.
      return
    }

    try {
      await ctx.reply('Something glitched, try again.')
    } catch {}

    if (shouldAlertAdmins(message)) {
      try {
        const env = loadEnv()
        await ctx.telegram.sendMessage(
          env.ALERT_CHANNEL_ID,
          `NOXATRADING bot error\ntelegramId=${ctx.from?.id ?? 'unknown'}\nupdateType=${ctx.updateType}\nmsg=${message.slice(0, 200)}`,
        )
      } catch {}
    }
  }
}
