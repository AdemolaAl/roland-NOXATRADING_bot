import type { UserRow } from '../repositories/userRepo.js'

// Achievement-state routing. Replaces flow_stage as the source of
// truth for "where should this user be?" decisions.
//
// flow_stage stays in the DB as an analytics hint and as input to the
// forward-only state machine, but routing boundaries (/start, scene
// enter() guards, sceneRehydrateMw, bot.action handlers) now derive
// the target scene from monotonic achievement columns. Once a gate
// is crossed, it stays crossed — except iq_session_token, the one
// intentionally non-monotonic rung (cleared on SDK auth-failed so
// the user re-enters their password).
//
// See migrations/017_user_journey_flags.sql for the columns this
// reads (channel_joined_at, first_deposit_at, lockout_reason, plus
// pre-existing iq_account_confirmed_at, iq_session_token,
// agreement_accepted).

export enum AchievementLevel {
  // Terminal state — admin-cleared only.
  LOCKED_OUT = 'LOCKED_OUT',
  // Furthest forward rung. User has funded their IQ account.
  DEPOSITED = 'DEPOSITED',
  // Accepted the trading terms.
  AGREEMENT_ACCEPTED = 'AGREEMENT_ACCEPTED',
  // Holds a live IQ Option SDK session. THIS RUNG IS NON-MONOTONIC —
  // a deposited user whose session expired drops back to
  // AGREEMENT_ACCEPTED (their LATEST achievement), but
  // whereShouldUserBe still routes them through LOGIN_EMAIL because
  // the gate is unmet right now. Level vs target scene differ here.
  HAS_VALID_SESSION = 'HAS_VALID_SESSION',
  // Affstore postback landed OR user self-reported via IQ_SIGNUP_DONE.
  IQ_ACCOUNT_CONFIRMED = 'IQ_ACCOUNT_CONFIRMED',
  // Passed CHANNEL_GATE.
  CHANNEL_JOINED = 'CHANNEL_JOINED',
  // Row exists, nothing else.
  STARTED = 'STARTED',
}

// Scenes whereShouldUserBe is allowed to return. Sub-flow scenes
// (LOGIN_PASSWORD, IQ_SIGNUP_HELP, TIMEFRAME, etc.) are reached
// through state-machine transitions from these entry scenes, not by
// direct routing.
export type RoutingTarget =
  | 'CHANNEL_GATE'
  | 'WELCOME'
  | 'IQ_ACCOUNT_GATE'
  | 'LOGIN_EMAIL'
  | 'AGREEMENT'
  | 'DEPOSIT_GATE'
  | 'HOME'
  | 'NON_PARTNER_REJECT'

// Read the user's tier intent. After deposit confirmation it lives on
// users.tier; before that it lives in flow_data.requestedTier (set
// when the user picks Demo / Auto / Pro at WELCOME). Returns null
// when the user hasn't picked a tier yet — that's the signal to
// route them to WELCOME.
export function getRequestedTier(user: UserRow): 'demo' | 'auto' | 'pro' | null {
  // Durable column, written at tier-pick (migration 019). Checked first
  // because it survives flow_data overwrites — the volatile
  // flow_data.requestedTier below was the sole demo-intent signal and its
  // loss was de-gating demo users back to WELCOME, silently killing the
  // "Create my IQ Option account" button.
  const fromColumn = String(user.requested_tier ?? '').toLowerCase()
  if (fromColumn === 'demo' || fromColumn === 'auto' || fromColumn === 'pro') {
    return fromColumn
  }
  const flow = (user.flow_data ?? {}) as Record<string, unknown>
  const fromFlow = String(flow.requestedTier ?? '').toLowerCase()
  if (fromFlow === 'demo' || fromFlow === 'auto' || fromFlow === 'pro') {
    return fromFlow
  }
  if (user.tier && user.tier !== 'demo') {
    return user.tier as 'auto' | 'pro'
  }
  // account_mode='live' implies the user once chose auto/pro and
  // crossed DEPOSIT_GATE — you can't reach live without it under the
  // legacy flow. Treat as auto-tier intent so a live-mode user with
  // an empty flow_data still routes past the tier-picker gate.
  if (user.account_mode === 'live') return 'auto'
  // 'demo' on users.tier is the default value, not necessarily a
  // user choice. Only return it if it came from flow_data above.
  return null
}

// IQ account confirmation has two equivalent signals: the Affstore
// postback writing iq_account_confirmed_at, OR the user self-reporting
// via the IQ_SIGNUP_DONE button (which sets flow.iqAccountConfirmed
// in iqSignupHelp.scene.ts:69). We treat both as confirmation so a
// fast user who taps "I've signed up" before the postback lands
// doesn't get bounced back to the signup gate. The postback
// eventually backfills the column for canonical record-keeping.
export function isIqAccountConfirmed(user: UserRow): boolean {
  if (user.iq_account_confirmed_at) return true
  const flow = (user.flow_data ?? {}) as Record<string, unknown>
  return flow.iqAccountConfirmed === true
}

// True when the user's tier intent requires a funded IQ account.
// Demo-tier users never need to deposit, so the DEPOSIT_GATE rung
// is skipped for them and they route straight to HOME after
// accepting the agreement.
export function requiresDeposit(user: UserRow): boolean {
  const tier = getRequestedTier(user)
  if (tier === 'auto' || tier === 'pro') return true
  // Failsafe: if account_mode is live, they must have deposited at
  // some point to get there. Treat as required so we don't route a
  // live-mode user to HOME without a deposit flag set.
  if (user.account_mode === 'live') return true
  return false
}

// Highest achievement level the user has reached. Pure observation
// of what's set on the row — useful for analytics/logging. Note that
// a session-expired-but-deposited user still reports DEPOSITED here
// because they HAVE achieved that gate; whereShouldUserBe handles
// the "what's blocking them right now" question separately.
export function deriveAchievementLevel(user: UserRow): AchievementLevel {
  if (user.lockout_reason) return AchievementLevel.LOCKED_OUT
  if (user.first_deposit_at) return AchievementLevel.DEPOSITED
  if (user.agreement_accepted) return AchievementLevel.AGREEMENT_ACCEPTED
  if (user.iq_session_token) return AchievementLevel.HAS_VALID_SESSION
  if (isIqAccountConfirmed(user)) return AchievementLevel.IQ_ACCOUNT_CONFIRMED
  if (user.channel_joined_at) return AchievementLevel.CHANNEL_JOINED
  return AchievementLevel.STARTED
}

// The routing decision. Walks gates bottom-up and returns the entry
// scene of the first unmet gate, or HOME if all gates are passed.
//
// Lockout short-circuit takes precedence over everything — a
// NON_PARTNER_REJECT user with achievements still routes to the
// lockout scene until admin reset clears lockout_reason.
//
// Deliberate property: this function is pure. Given the same UserRow,
// it always returns the same target. No DB access, no clock, no
// global state. That makes it testable and makes routing decisions
// reproducible from a single SELECT * FROM users WHERE telegram_id=…
export function whereShouldUserBe(user: UserRow): RoutingTarget {
  if (user.lockout_reason) return 'NON_PARTNER_REJECT'

  // Channel gate — entry point for every user.
  if (!user.channel_joined_at) return 'CHANNEL_GATE'

  // WELCOME is the tier-picker; can't proceed to IQ signup without it.
  if (!getRequestedTier(user)) return 'WELCOME'

  // IQ account creation gate. WELCOME → IQ_ACCOUNT_GATE → IQ_SIGNUP_HELP
  // (when user taps "I need to create") → LOGIN_EMAIL (when they tap
  // "I've signed up" OR Affstore postback fires the Continue DM).
  // We route to the entry scene here; the state machine handles the
  // sub-flow forward transitions once the user starts interacting.
  if (!isIqAccountConfirmed(user)) return 'IQ_ACCOUNT_GATE'

  // Login. iq_session_token is non-monotonic — a previously-logged-in
  // user whose session expired (SDK auth-failed wiped the token) lands
  // here. After re-login, the rest of the ladder passes through
  // because their other achievements (agreement, deposit) are
  // untouched and they end up at HOME.
  if (!user.iq_session_token) return 'LOGIN_EMAIL'

  // Terms of service.
  if (!user.agreement_accepted) return 'AGREEMENT'

  // Deposit gate — only required for live tiers. Demo users skip
  // this rung and route directly to HOME.
  if (!user.first_deposit_at && requiresDeposit(user)) return 'DEPOSIT_GATE'

  return 'HOME'
}
