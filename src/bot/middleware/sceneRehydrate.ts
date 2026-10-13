import type { Middleware } from 'telegraf'
import { userRepo } from '../../core/repositories/index.js'
import type { UserRow } from '../../core/repositories/userRepo.js'
import type { BotContext } from '../index.js'
import { whereShouldUserBe } from '../../core/services/userJourney.js'

type ScenesSession = { current?: string; state?: Record<string, unknown> }

// Maps every sub-flow scene to the achievement-routing target it
// belongs under. Used by the fast-path check so a user mid-flow (e.g.
// in AMOUNT after picking a pair, in IQ_SIGNUP_HELP after tapping the
// signup button) doesn't get yanked back to the parent gate on every
// update — which would silently kill the scene-bound on('text') /
// .action() handlers and make their next message land in the
// orphan-text fallback.
//
// Deliberately absent: LOGIN_VERIFYING, TRADE_EXECUTING,
// TRADE_EXECUTING_PRO. Those are transient bot-driven states; if the
// user lands on one across a bot restart they're stuck, so we WANT
// the rehydrate to eject them back to the entry target (LOGIN_EMAIL /
// HOME) so they can recover.
const SCENE_PARENT_TARGET: Record<string, string> = {
  CHANNEL_GATE: 'CHANNEL_GATE',
  WELCOME: 'WELCOME',
  ACCOUNT_TYPE: 'WELCOME',
  IQ_ACCOUNT_GATE: 'IQ_ACCOUNT_GATE',
  IQ_SIGNUP_HELP: 'IQ_ACCOUNT_GATE',
  LOGIN_EMAIL: 'LOGIN_EMAIL',
  LOGIN_PASSWORD: 'LOGIN_EMAIL',
  AGREEMENT: 'AGREEMENT',
  DEPOSIT_GATE: 'DEPOSIT_GATE',
  HOME: 'HOME',
  HOME_HISTORY: 'HOME',
  HELP_FAQ: 'HOME',
  SUPPORT_HANDOFF: 'HOME',
  TIMEFRAME: 'HOME',
  PAIR_SELECTION: 'HOME',
  PAIR_SELECT_PRO_1: 'HOME',
  PAIR_SELECT_PRO_2: 'HOME',
  PAIR_SELECT_PRO_3: 'HOME',
  AMOUNT: 'HOME',
  AMOUNT_CUSTOM: 'HOME',
  AMOUNT_PRO: 'HOME',
  POST_TRADE_MENU: 'HOME',
  STATS_VIEW: 'HOME',
  CELEBRATION: 'HOME',
  CELEBRATION_PRO: 'HOME',
  DEMO_CONVERSION: 'HOME',
  PRO_UPSELL: 'HOME',
  IDLE: 'HOME',
  NON_PARTNER_REJECT: 'NON_PARTNER_REJECT',
}

// Re-establishes the user's Telegraf scene context after a session
// loss. Two cases this covers:
//   1. Bot restart wiped Telegraf's in-memory session — without this,
//      the user's scene-bound action/text handlers go dead until /start.
//   2. A detached background task (post-trade UX runner) advanced the
//      user's persisted state while the user's in-memory __scenes.current
//      still points at the old scene. Without overriding here, the
//      user's next button tap hits the wrong scene's action handlers
//      and silently does nothing.
//
// Phase 3a: target picked by whereShouldUserBe(user) instead of the
// legacy STABLE_STAGES / TRANSIENT_FALLBACKS lookup. That makes
// rehydration consistent with /start and with scene short-circuit
// redirects — they all derive from the same achievement-flag function.
// SCENE_PARENT_TARGET above preserves the sub-flow safety the old
// STABLE_STAGES set provided: a user in AMOUNT / TIMEFRAME /
// IQ_SIGNUP_HELP / etc. isn't yanked back to the parent gate on every
// update, only when their achievement state truly moved them.
export const sceneRehydrateMw: Middleware<BotContext> = async (ctx, next) => {
  if (!ctx.from) {
    return next()
  }

  const cached = ctx.state.currentUser as UserRow | undefined
  const user = cached ?? (await userRepo.findById(BigInt(ctx.from.id)))
  if (!user) {
    return next()
  }

  const target = whereShouldUserBe(user)

  const session = ctx.session as Record<string, unknown> | undefined
  const scenes = session?.__scenes as ScenesSession | undefined
  const inMemory = scenes?.current?.toUpperCase()

  // Already in sync — fast path. Either the in-memory scene matches
  // the target exactly, or it's a legitimate sub-flow whose parent
  // target matches (user mid-trade-flow, mid-signup-help, mid-login
  // etc.). The second case is what keeps scene-bound on('text') and
  // .action() handlers alive across updates.
  if (inMemory && (inMemory === target || SCENE_PARENT_TARGET[inMemory] === target)) {
    return next()
  }

  // If the persisted flow_stage points at a transient or trade-internal
  // stage (TOKEN_*, LOGIN_VERIFYING, TRADE_EXECUTING etc.) and we're
  // rehydrating somewhere upstream, strip the trade-in-flight flags so
  // a bot kill mid-trade doesn't leave the user locked out of starting
  // a new one. Persist the corrected flow_stage too so the state
  // machine has a valid input on the next event.
  const persisted = user.flow_stage?.toUpperCase()
  if (persisted !== target) {
    const recoveredFlow = { ...(user.flow_data ?? {}) } as Record<string, unknown>
    if (persisted === 'TRADE_EXECUTING' || persisted === 'TRADE_EXECUTING_PRO') {
      delete recoveredFlow.tradeInFlight
      delete recoveredFlow.tradeInFlightAt
    }
    await userRepo.updateFlowStage(BigInt(user.telegram_id), target, recoveredFlow)
    if (cached) {
      cached.flow_stage = target
      cached.flow_data = recoveredFlow
    }
  }

  // Force in-memory scene to match the derived target.
  ctx.session = (ctx.session ?? {}) as BotContext['session']
  ;(ctx.session as Record<string, unknown>).__scenes = { current: target, state: {} }

  return next()
}
