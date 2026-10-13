import { describe, expect, it } from '@jest/globals'
import type { UserRow } from '../repositories/userRepo.js'
import {
  AchievementLevel,
  deriveAchievementLevel,
  getRequestedTier,
  isIqAccountConfirmed,
  requiresDeposit,
  whereShouldUserBe,
} from './userJourney.js'

// Minimal-fields factory for test rows. Returns a UserRow with every
// achievement column null/false; tests override only the fields they
// care about so what's being tested is obvious.
function userFixture(overrides: Partial<UserRow> = {}): UserRow {
  return {
    telegram_id: '123',
    telegram_username: null,
    telegram_first_name: null,
    iq_user_id: null,
    iq_email: null,
    iq_session_token: null,
    iq_session_expires_at: null,
    iq_password_encrypted: null,
    iq_balance_cached: null,
    iq_balance_cached_at: null,
    iq_trader_id: null,
    iq_account_confirmed_at: null,
    iq_promoter_link: null,
    partner_code_verified: false,
    tier: 'demo',
    requested_tier: null,
    account_mode: 'demo',
    agreement_accepted: false,
    timeframe: null,
    base_stake: null,
    live_win_count: 0,
    status: 'active',
    suspension_reason: null,
    flow_stage: 'WELCOME',
    flow_data: {},
    nudge_count: 0,
    nudges_paused_at: null,
    last_nudge_message_id: null,
    bot_blocked_at: null,
    channel_joined_at: null,
    first_deposit_at: null,
    lockout_reason: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    last_activity: new Date('2026-01-01'),
    ...overrides,
  }
}

describe('userJourney', () => {
  describe('getRequestedTier', () => {
    it('reads requestedTier from flow_data', () => {
      const user = userFixture({ flow_data: { requestedTier: 'pro' } })
      expect(getRequestedTier(user)).toBe('pro')
    })

    it('falls back to users.tier when non-demo', () => {
      const user = userFixture({ tier: 'auto', flow_data: {} })
      expect(getRequestedTier(user)).toBe('auto')
    })

    it('returns null when no tier picked', () => {
      const user = userFixture({ tier: 'demo', flow_data: {} })
      expect(getRequestedTier(user)).toBeNull()
    })

    it("does NOT treat default tier='demo' as a picked tier", () => {
      // tier='demo' is the column default for brand-new users.
      // Without something in flow_data, we can't tell whether the
      // user picked Demo or just hasn't picked anything yet.
      const user = userFixture({ tier: 'demo', flow_data: {} })
      expect(getRequestedTier(user)).toBeNull()
    })

    it("treats explicit flow_data.requestedTier='demo' as picked", () => {
      const user = userFixture({ tier: 'demo', flow_data: { requestedTier: 'demo' } })
      expect(getRequestedTier(user)).toBe('demo')
    })

    it('reads the durable requested_tier column (migration 019)', () => {
      const user = userFixture({ tier: 'demo', requested_tier: 'demo', flow_data: {} })
      expect(getRequestedTier(user)).toBe('demo')
    })

    it('durable demo intent survives a flow_data wipe that drops requestedTier', () => {
      // This is the exact bug: flow_data.requestedTier got clobbered, but
      // the durable column keeps the user gated at IQ_ACCOUNT_GATE instead
      // of de-gating them to WELCOME and killing the create-account button.
      const user = userFixture({
        tier: 'demo',
        account_mode: 'demo',
        requested_tier: 'demo',
        flow_data: { somethingElse: true },
      })
      expect(getRequestedTier(user)).toBe('demo')
    })

    it('prefers the durable column over a conflicting flow_data value', () => {
      const user = userFixture({
        tier: 'demo',
        requested_tier: 'pro',
        flow_data: { requestedTier: 'auto' },
      })
      expect(getRequestedTier(user)).toBe('pro')
    })
  })

  describe('isIqAccountConfirmed', () => {
    it('true when column set', () => {
      const user = userFixture({ iq_account_confirmed_at: new Date() })
      expect(isIqAccountConfirmed(user)).toBe(true)
    })

    it('true when flow_data flag set (postback-race tolerance)', () => {
      const user = userFixture({ flow_data: { iqAccountConfirmed: true } })
      expect(isIqAccountConfirmed(user)).toBe(true)
    })

    it('false when neither set', () => {
      const user = userFixture()
      expect(isIqAccountConfirmed(user)).toBe(false)
    })
  })

  describe('requiresDeposit', () => {
    it('true for auto tier', () => {
      const user = userFixture({ flow_data: { requestedTier: 'auto' } })
      expect(requiresDeposit(user)).toBe(true)
    })

    it('true for pro tier', () => {
      const user = userFixture({ tier: 'pro' })
      expect(requiresDeposit(user)).toBe(true)
    })

    it('false for demo path', () => {
      const user = userFixture({ flow_data: { requestedTier: 'demo' } })
      expect(requiresDeposit(user)).toBe(false)
    })

    it('true when account_mode is live (failsafe)', () => {
      const user = userFixture({ account_mode: 'live' })
      expect(requiresDeposit(user)).toBe(true)
    })

    it('false when no tier picked and account_mode is demo', () => {
      const user = userFixture()
      expect(requiresDeposit(user)).toBe(false)
    })
  })

  describe('deriveAchievementLevel', () => {
    it('STARTED for an all-nulls fresh row', () => {
      const user = userFixture()
      expect(deriveAchievementLevel(user)).toBe(AchievementLevel.STARTED)
    })

    it('CHANNEL_JOINED after channel_joined_at set', () => {
      const user = userFixture({ channel_joined_at: new Date() })
      expect(deriveAchievementLevel(user)).toBe(AchievementLevel.CHANNEL_JOINED)
    })

    it('IQ_ACCOUNT_CONFIRMED when column set', () => {
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
      })
      expect(deriveAchievementLevel(user)).toBe(AchievementLevel.IQ_ACCOUNT_CONFIRMED)
    })

    it('IQ_ACCOUNT_CONFIRMED via flow_data flag (postback-race)', () => {
      const user = userFixture({
        channel_joined_at: new Date(),
        flow_data: { iqAccountConfirmed: true },
      })
      expect(deriveAchievementLevel(user)).toBe(AchievementLevel.IQ_ACCOUNT_CONFIRMED)
    })

    it('HAS_VALID_SESSION when iq_session_token set', () => {
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        iq_session_token: 'encrypted',
      })
      expect(deriveAchievementLevel(user)).toBe(AchievementLevel.HAS_VALID_SESSION)
    })

    it('AGREEMENT_ACCEPTED when agreement_accepted true', () => {
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        iq_session_token: 'encrypted',
        agreement_accepted: true,
      })
      expect(deriveAchievementLevel(user)).toBe(AchievementLevel.AGREEMENT_ACCEPTED)
    })

    it('DEPOSITED when first_deposit_at set', () => {
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        iq_session_token: 'encrypted',
        agreement_accepted: true,
        first_deposit_at: new Date(),
      })
      expect(deriveAchievementLevel(user)).toBe(AchievementLevel.DEPOSITED)
    })

    it('LOCKED_OUT overrides any other achievement', () => {
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        iq_session_token: 'encrypted',
        agreement_accepted: true,
        first_deposit_at: new Date(),
        lockout_reason: 'non_partner',
      })
      expect(deriveAchievementLevel(user)).toBe(AchievementLevel.LOCKED_OUT)
    })

    it('session-expired-but-deposited user still reports DEPOSITED', () => {
      // Token cleared after SDK auth-failed, but first_deposit_at
      // remains. derivedLevel reflects history; whereShouldUserBe
      // handles the "blocked right now" question.
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        iq_session_token: null,
        agreement_accepted: true,
        first_deposit_at: new Date(),
      })
      expect(deriveAchievementLevel(user)).toBe(AchievementLevel.DEPOSITED)
    })
  })

  describe('whereShouldUserBe', () => {
    it('CHANNEL_GATE for an all-nulls fresh row', () => {
      const user = userFixture()
      expect(whereShouldUserBe(user)).toBe('CHANNEL_GATE')
    })

    it('NON_PARTNER_REJECT short-circuits regardless of other flags', () => {
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        iq_session_token: 'encrypted',
        agreement_accepted: true,
        first_deposit_at: new Date(),
        lockout_reason: 'non_partner',
      })
      expect(whereShouldUserBe(user)).toBe('NON_PARTNER_REJECT')
    })

    it('WELCOME after channel joined but no tier picked', () => {
      const user = userFixture({ channel_joined_at: new Date() })
      expect(whereShouldUserBe(user)).toBe('WELCOME')
    })

    it('IQ_ACCOUNT_GATE after tier picked but not confirmed', () => {
      const user = userFixture({
        channel_joined_at: new Date(),
        flow_data: { requestedTier: 'auto' },
      })
      expect(whereShouldUserBe(user)).toBe('IQ_ACCOUNT_GATE')
    })

    it('postback-race: flow_data.iqAccountConfirmed bypasses the IQ_ACCOUNT gate', () => {
      // User tapped "I've signed up" but Affstore postback hasn't
      // landed. Without this tolerance, they'd be bounced back to
      // IQ_ACCOUNT_GATE — the "register twice" bug from Evgeny.
      const user = userFixture({
        channel_joined_at: new Date(),
        flow_data: { requestedTier: 'auto', iqAccountConfirmed: true },
      })
      expect(whereShouldUserBe(user)).toBe('LOGIN_EMAIL')
    })

    it('LOGIN_EMAIL after IQ account confirmed but no session', () => {
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        flow_data: { requestedTier: 'auto' },
      })
      expect(whereShouldUserBe(user)).toBe('LOGIN_EMAIL')
    })

    it('AGREEMENT after login succeeds but no agreement', () => {
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        iq_session_token: 'encrypted',
        flow_data: { requestedTier: 'auto' },
      })
      expect(whereShouldUserBe(user)).toBe('AGREEMENT')
    })

    it('DEPOSIT_GATE after agreement on auto/pro tier', () => {
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        iq_session_token: 'encrypted',
        agreement_accepted: true,
        flow_data: { requestedTier: 'auto' },
      })
      expect(whereShouldUserBe(user)).toBe('DEPOSIT_GATE')
    })

    it('HOME for demo path after agreement (no deposit required)', () => {
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        iq_session_token: 'encrypted',
        agreement_accepted: true,
        flow_data: { requestedTier: 'demo' },
      })
      expect(whereShouldUserBe(user)).toBe('HOME')
    })

    it('HOME for fully onboarded live user', () => {
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        iq_session_token: 'encrypted',
        agreement_accepted: true,
        first_deposit_at: new Date(),
        tier: 'auto',
        account_mode: 'live',
        flow_data: { requestedTier: 'auto' },
      })
      expect(whereShouldUserBe(user)).toBe('HOME')
    })

    it('session-expired deposited user routes to LOGIN_EMAIL, NOT through agreement/deposit again', () => {
      // The Evgeny scenario: deposit and agreement already done,
      // session expired (token cleared by SDK auth-failed catch).
      // New routing sends them to LOGIN_EMAIL only; after re-login
      // the remaining achievements skip past AGREEMENT and
      // DEPOSIT_GATE straight to HOME.
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        iq_session_token: null, // wiped by clearIqSession
        agreement_accepted: true,
        first_deposit_at: new Date(),
        tier: 'auto',
        flow_data: { requestedTier: 'auto' },
      })
      expect(whereShouldUserBe(user)).toBe('LOGIN_EMAIL')
    })

    it('after re-login, deposited user lands at HOME (no AGREEMENT or DEPOSIT_GATE re-prompt)', () => {
      // Same user as above, after they type their password and
      // login succeeds — iq_session_token gets re-populated.
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        iq_session_token: 'fresh-encrypted',
        agreement_accepted: true,
        first_deposit_at: new Date(),
        tier: 'auto',
        flow_data: { requestedTier: 'auto' },
      })
      expect(whereShouldUserBe(user)).toBe('HOME')
    })

    it('account_mode=live with no first_deposit_at still routes to DEPOSIT_GATE (failsafe)', () => {
      // Defensive: if somehow a user ended up with account_mode=live
      // but no recorded deposit, treat them as still needing one.
      const user = userFixture({
        channel_joined_at: new Date(),
        iq_account_confirmed_at: new Date(),
        iq_session_token: 'encrypted',
        agreement_accepted: true,
        account_mode: 'live',
        first_deposit_at: null,
      })
      expect(whereShouldUserBe(user)).toBe('DEPOSIT_GATE')
    })
  })
})
