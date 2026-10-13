import type { Pool } from 'pg'
import type { FullTier } from '../services/tierService.js'

export type UserRow = {
  telegram_id: string
  telegram_username: string | null
  telegram_first_name: string | null
  iq_user_id: string | null
  iq_email: string | null
  iq_session_token: string | null
  iq_session_expires_at: Date | null
  // AES-GCM encryption (SESSION_ENCRYPTION_KEY) of the user's IQ
  // password. Captured at successful login so the bot can silently
  // re-authenticate when the SDK reports auth-failed mid-session.
  // Wiped via clearIqCredentials when a silent re-auth confirms the
  // password is stale (user changed it externally / account suspended).
  iq_password_encrypted: string | null
  iq_balance_cached: string | null
  iq_balance_cached_at: Date | null
  iq_trader_id: string | null
  iq_account_confirmed_at: Date | null
  iq_promoter_link: string | null
  partner_code_verified: boolean
  tier: FullTier
  // Durable record of the tier the user picked at WELCOME
  // (PICKED_DEMO/AUTO/PRO). Unlike flow_data.requestedTier this survives
  // flow_data overwrites, so getRequestedTier()/whereShouldUserBe() can't
  // lose demo intent and de-gate the user. See migration 019.
  requested_tier: FullTier | null
  account_mode: 'demo' | 'live'
  agreement_accepted: boolean
  timeframe: '30s' | '1m' | '2m' | '5m' | null
  base_stake: string | null
  live_win_count: number
  status: 'active' | 'paused' | 'suspended' | 'force_demo'
  suspension_reason: string | null
  flow_stage: string
  flow_data: Record<string, unknown>
  nudge_count: number
  nudges_paused_at: Date | null
  last_nudge_message_id: number | null
  bot_blocked_at: Date | null
  // Achievement flags driving the new routing model. Monotonic by
  // design — set when a gate is crossed, cleared only via admin reset.
  // See src/core/services/userJourney.ts for the derivation function.
  channel_joined_at: Date | null
  first_deposit_at: Date | null
  lockout_reason: string | null
  created_at: Date
  updated_at: Date
  last_activity: Date
}

export class UserRepository {
  constructor(private readonly pool: Pool) {}

  async findById(telegramId: bigint): Promise<UserRow | null> {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegramId.toString()],
    )
    return result.rows[0] ?? null
  }

  async findByUsername(username: string): Promise<UserRow[]> {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM users WHERE telegram_username = $1 ORDER BY created_at DESC',
      [username],
    )
    return result.rows
  }

  async findByIqUserId(iqUserId: string): Promise<UserRow[]> {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM users WHERE iq_user_id = $1 ORDER BY created_at DESC',
      [iqUserId],
    )
    return result.rows
  }

  async findByIqTraderId(iqTraderId: string): Promise<UserRow[]> {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM users WHERE iq_trader_id = $1 ORDER BY created_at DESC',
      [iqTraderId],
    )
    return result.rows
  }

  // One-way confirmation: sets iq_trader_id, iq_account_confirmed_at,
  // and iq_promoter_link only if they haven't been set already. Returns
  // true iff this call was the first confirmation — used by the
  // signup-confirmed notifier to fire the post-registration DM exactly
  // once even when Affstore retries the webhook. COALESCE protects
  // against a second postback (same trader, different clickid) from
  // overwriting the original attribution.
  async markIqAccountConfirmed(
    telegramId: bigint,
    traderId: string,
    promoterLink: string | null,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE users
         SET iq_trader_id            = COALESCE(iq_trader_id, $2),
             iq_account_confirmed_at = COALESCE(iq_account_confirmed_at, now()),
             iq_promoter_link        = COALESCE(iq_promoter_link, $3),
             updated_at              = now()
       WHERE telegram_id = $1
         AND iq_account_confirmed_at IS NULL`,
      [telegramId.toString(), traderId, promoterLink],
    )
    return (result.rowCount ?? 0) > 0
  }

  async findByEmail(email: string): Promise<UserRow[]> {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM users WHERE iq_email = $1 ORDER BY created_at DESC',
      [email],
    )
    return result.rows
  }

  async listRecent(opts: { limit: number; offset?: number }): Promise<UserRow[]> {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM users ORDER BY created_at DESC, telegram_id DESC LIMIT $1 OFFSET $2',
      [opts.limit, opts.offset ?? 0],
    )
    return result.rows
  }

  async countAll(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM users',
    )
    return Number(result.rows[0]!.count)
  }

  // Returns { user, created } where created=true iff this call actually
  // inserted the row (vs UPDATE on conflict). xmax=0 in the RETURNING row
  // is the canonical Postgres trick to distinguish INSERT from
  // ON-CONFLICT-UPDATE in a single statement — no extra SELECT needed.
  // Callers that need to fire one-time onboarding side effects (funnel
  // events, channel-gate seeding) read the `created` flag.
  async createIfMissing(
    telegramId: bigint,
    username?: string,
    firstName?: string,
  ): Promise<{ user: UserRow; created: boolean }> {
    const result = await this.pool.query<UserRow & { _is_new: boolean }>(
      `INSERT INTO users (telegram_id, telegram_username, telegram_first_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id) DO UPDATE SET
         telegram_username = COALESCE(EXCLUDED.telegram_username, users.telegram_username),
         telegram_first_name = COALESCE(EXCLUDED.telegram_first_name, users.telegram_first_name),
         updated_at = now()
       RETURNING *, (xmax = 0) AS _is_new`,
      [telegramId.toString(), username ?? null, firstName ?? null],
    )
    const row = result.rows[0]!
    const { _is_new, ...user } = row
    return { user: user as UserRow, created: _is_new === true }
  }

  async updateFlowStage(
    telegramId: bigint,
    stage: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      'UPDATE users SET flow_stage = $1, flow_data = $2, updated_at = now() WHERE telegram_id = $3',
      [stage, data, telegramId.toString()],
    )
  }

  async touchActivity(telegramId: bigint): Promise<void> {
    await this.pool.query(
      'UPDATE users SET last_activity = now(), updated_at = now() WHERE telegram_id = $1',
      [telegramId.toString()],
    )
  }

  // Hot-path coalesced write fired once per inbound Telegram update from
  // activityMw. Replaces three separate UPDATEs (touchActivity +
  // resetNudgeState columns) with one round-trip to free pool slots for
  // the actual handler.
  async touchActivityAndResetNudge(telegramId: bigint): Promise<void> {
    await this.pool.query(
      `UPDATE users
       SET last_activity = now(),
           nudge_count = 0,
           nudges_paused_at = NULL,
           last_nudge_message_id = NULL,
           bot_blocked_at = NULL,
           updated_at = now()
       WHERE telegram_id = $1`,
      [telegramId.toString()],
    )
  }

  // Batched state-machine write fired once per XState transition. Replaces
  // up to four serial UPDATEs (setTier + setAccountMode + setAgreementAccepted
  // + updateFlowStage) with a single statement that only touches the columns
  // present in the patch. flow_stage and flow_data are always set because
  // every transition advances the persisted flow position.
  async updateStateAndFlow(
    telegramId: bigint,
    patch: {
      tier?: FullTier
      requestedTier?: FullTier
      accountMode?: 'demo' | 'live'
      agreementAccepted?: boolean
      flowStage: string
      flowData: Record<string, unknown>
    },
  ): Promise<UserRow> {
    const sets: string[] = ['flow_stage = $2', 'flow_data = $3', 'updated_at = now()']
    const params: unknown[] = [telegramId.toString(), patch.flowStage, patch.flowData]
    let nextIdx = 4
    if (patch.tier !== undefined) {
      sets.push(`tier = $${nextIdx++}`)
      params.push(patch.tier)
    }
    if (patch.requestedTier !== undefined) {
      sets.push(`requested_tier = $${nextIdx++}`)
      params.push(patch.requestedTier)
    }
    if (patch.accountMode !== undefined) {
      sets.push(`account_mode = $${nextIdx++}`)
      params.push(patch.accountMode)
    }
    if (patch.agreementAccepted !== undefined) {
      sets.push(`agreement_accepted = $${nextIdx++}`)
      params.push(patch.agreementAccepted)
    }
    const result = await this.pool.query<UserRow>(
      `UPDATE users SET ${sets.join(', ')} WHERE telegram_id = $1 RETURNING *`,
      params,
    )
    return result.rows[0]!
  }

  async setTier(telegramId: bigint, tier: FullTier): Promise<void> {
    await this.pool.query('UPDATE users SET tier = $1, updated_at = now() WHERE telegram_id = $2', [
      tier,
      telegramId.toString(),
    ])
  }

  async setAccountMode(telegramId: bigint, mode: 'demo' | 'live'): Promise<void> {
    await this.pool.query(
      'UPDATE users SET account_mode = $1, updated_at = now() WHERE telegram_id = $2',
      [mode, telegramId.toString()],
    )
  }

  async setStatus(telegramId: bigint, status: UserRow['status'], reason?: string): Promise<void> {
    await this.pool.query(
      'UPDATE users SET status = $1, suspension_reason = $2, updated_at = now() WHERE telegram_id = $3',
      [status, reason ?? null, telegramId.toString()],
    )
  }

  async setIqSession(
    telegramId: bigint,
    params: {
      iqUserId: string
      email: string
      encryptedToken: string
      expiresAt: Date
      balance: number
      partnerCodeVerified: boolean
      // Optional: pass when the caller has the password in hand
      // (manual login flow). Omit during silent re-auth refresh so
      // the existing column value is preserved (COALESCE guard
      // below). Never set this to a value other than the freshly
      // encrypted password.
      encryptedPassword?: string
    },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE users SET
         iq_user_id = $1,
         iq_email = $2,
         iq_session_token = $3,
         iq_session_expires_at = $4,
         iq_balance_cached = $5,
         iq_balance_cached_at = now(),
         partner_code_verified = $6,
         iq_password_encrypted = COALESCE($8, iq_password_encrypted),
         updated_at = now()
       WHERE telegram_id = $7`,
      [
        params.iqUserId,
        params.email,
        params.encryptedToken,
        params.expiresAt,
        params.balance,
        params.partnerCodeVerified,
        telegramId.toString(),
        params.encryptedPassword ?? null,
      ],
    )
  }

  async incrementLiveWinCount(telegramId: bigint): Promise<number> {
    const result = await this.pool.query<{ live_win_count: number }>(
      'UPDATE users SET live_win_count = live_win_count + 1, updated_at = now() WHERE telegram_id = $1 RETURNING live_win_count',
      [telegramId.toString()],
    )
    return result.rows[0]!.live_win_count
  }

  async resetLiveWinCount(telegramId: bigint): Promise<void> {
    await this.pool.query(
      'UPDATE users SET live_win_count = 0, updated_at = now() WHERE telegram_id = $1',
      [telegramId.toString()],
    )
  }

  async setAgreementAccepted(telegramId: bigint, accepted: boolean): Promise<void> {
    await this.pool.query(
      'UPDATE users SET agreement_accepted = $1, updated_at = now() WHERE telegram_id = $2',
      [accepted, telegramId.toString()],
    )
  }

  async setTimeframe(telegramId: bigint, timeframe: '30s' | '1m' | '2m' | '5m'): Promise<void> {
    await this.pool.query('UPDATE users SET timeframe = $1, updated_at = now() WHERE telegram_id = $2', [
      timeframe,
      telegramId.toString(),
    ])
  }

  async setBaseStake(telegramId: bigint, stake: number): Promise<void> {
    await this.pool.query(
      'UPDATE users SET base_stake = $1, updated_at = now() WHERE telegram_id = $2',
      [stake, telegramId.toString()],
    )
  }

  async setCachedBalance(telegramId: bigint, balance: number): Promise<void> {
    await this.pool.query(
      `UPDATE users SET iq_balance_cached = $1, iq_balance_cached_at = now()
       WHERE telegram_id = $2`,
      [balance, telegramId.toString()],
    )
  }

  async incrementNudgeCount(telegramId: bigint): Promise<number> {
    const result = await this.pool.query<{ nudge_count: number }>(
      'UPDATE users SET nudge_count = nudge_count + 1 WHERE telegram_id = $1 RETURNING nudge_count',
      [telegramId.toString()],
    )
    return result.rows[0]?.nudge_count ?? 0
  }

  async resetNudgeState(telegramId: bigint): Promise<void> {
    // Reset escalation count, un-pause, and forget the last-nudge message id
    // so the next cycle starts clean and won't try to delete a message the
    // user has already moved past.
    await this.pool.query(
      `UPDATE users
       SET nudge_count = 0, nudges_paused_at = NULL, last_nudge_message_id = NULL
       WHERE telegram_id = $1`,
      [telegramId.toString()],
    )
  }

  async pauseNudges(telegramId: bigint): Promise<void> {
    await this.pool.query(
      'UPDATE users SET nudges_paused_at = now() WHERE telegram_id = $1',
      [telegramId.toString()],
    )
  }

  async setLastNudgeMessageId(telegramId: bigint, messageId: number | null): Promise<void> {
    await this.pool.query(
      'UPDATE users SET last_nudge_message_id = $1 WHERE telegram_id = $2',
      [messageId, telegramId.toString()],
    )
  }

  // Flag a user as unreachable after Telegram returns 403/400 chat-not-found.
  // Idempotent via COALESCE — repeated failures keep the original detection
  // time so we can later measure how long users stay blocked.
  async markBotBlocked(telegramId: bigint): Promise<void> {
    await this.pool.query(
      'UPDATE users SET bot_blocked_at = COALESCE(bot_blocked_at, now()), updated_at = now() WHERE telegram_id = $1',
      [telegramId.toString()],
    )
  }

  // Achievement-flag writers used by the routing refactor. All
  // COALESCE-protected so repeated firings (e.g. retried postbacks,
  // re-entering a gate) preserve the original timestamp instead of
  // overwriting it. The returned boolean tells the caller whether
  // this was the first time the flag was set, which lets jobs avoid
  // logging "advanced past gate" events on every retry.

  async markChannelJoined(telegramId: bigint): Promise<boolean> {
    // Conditional UPDATE: only matches rows where the column is
    // still NULL. Returns one row on first-set, zero rows on repeat
    // calls. This is the same "monotonic with idempotent re-fire"
    // shape used by markIqAccountConfirmed.
    const result = await this.pool.query(
      `UPDATE users
       SET channel_joined_at = now(),
           updated_at = now()
       WHERE telegram_id = $1
         AND channel_joined_at IS NULL`,
      [telegramId.toString()],
    )
    return (result.rowCount ?? 0) > 0
  }

  async markFirstDeposit(
    telegramId: bigint,
    source: 'postback' | 'balance_poll' | 'manual_confirm',
  ): Promise<boolean> {
    // `source` isn't persisted (would need a separate column or
    // event log); it's accepted so callers can log "set by X" without
    // computing the source twice. If a future audit shows we need to
    // know the source per-row, add a first_deposit_source column.
    void source
    const result = await this.pool.query(
      `UPDATE users
       SET first_deposit_at = now(),
           updated_at = now()
       WHERE telegram_id = $1
         AND first_deposit_at IS NULL`,
      [telegramId.toString()],
    )
    return (result.rowCount ?? 0) > 0
  }

  async markLockout(
    telegramId: bigint,
    reason: 'non_partner' | 'support_handoff',
  ): Promise<boolean> {
    // Not COALESCE-protected on the reason itself — if a user
    // transitions between lockout reasons (e.g. non_partner →
    // support_handoff escalation) the latest reason wins. The
    // achievement model only cares whether *some* lockout is set,
    // but escalations should be observable in the column.
    const result = await this.pool.query(
      `UPDATE users
       SET lockout_reason = $2,
           updated_at = now()
       WHERE telegram_id = $1
         AND (lockout_reason IS NULL OR lockout_reason <> $2)`,
      [telegramId.toString(), reason],
    )
    return (result.rowCount ?? 0) > 0
  }

  async clearLockout(telegramId: bigint): Promise<void> {
    // Admin escape hatch. Clearing flips the user back into the
    // achievement-derived routing path; if their other flags are
    // intact they resume where they left off.
    await this.pool.query(
      'UPDATE users SET lockout_reason = NULL, updated_at = now() WHERE telegram_id = $1',
      [telegramId.toString()],
    )
  }

  // Full journey reset for support escalations. Wipes every
  // achievement column + iq account state + flow_data so the user
  // is treated as brand-new on their next /start. Used by
  // /admin_reset_journey when SQL on flow_stage no longer works
  // (the achievement-routing refactor stopped reading flow_stage
  // for routing decisions, so admin SQL needs to touch the right
  // columns now).
  //
  // Note: iq_user_id / iq_email / iq_trader_id are preserved so the
  // admin still has the historical IQ identity for audit purposes;
  // they're not consulted by routing. If a true "delete user"
  // operation is needed, use hardDelete.
  async resetJourney(telegramId: bigint): Promise<void> {
    await this.pool.query(
      `UPDATE users SET
         channel_joined_at = NULL,
         iq_account_confirmed_at = NULL,
         iq_session_token = NULL,
         iq_session_expires_at = NULL,
         iq_password_encrypted = NULL,
         agreement_accepted = false,
         first_deposit_at = NULL,
         lockout_reason = NULL,
         tier = 'demo',
         requested_tier = NULL,
         account_mode = 'demo',
         flow_stage = 'WELCOME',
         flow_data = '{}'::jsonb,
         updated_at = now()
       WHERE telegram_id = $1`,
      [telegramId.toString()],
    )
  }

  // Wipe the stored IQ password after a silent re-auth attempt
  // confirms it's stale (IQ returned "authentication is failed"
  // on the HTTP login, meaning the user changed their password
  // externally or the account was suspended). Leaves session
  // fields alone — those get cleared separately via clearIqSession.
  // Called only from attemptSilentReAuth in _sceneHelpers.ts.
  async clearIqCredentials(telegramId: bigint): Promise<void> {
    await this.pool.query(
      `UPDATE users SET
         iq_password_encrypted = NULL,
         updated_at = now()
       WHERE telegram_id = $1`,
      [telegramId.toString()],
    )
  }

  // Wipe the cached IQ Option session token after the SDK reports
  // "authentication is failed" mid-session. The next user action will route
  // them back through LOGIN_EMAIL since iq_session_token is now NULL.
  async clearIqSession(telegramId: bigint): Promise<void> {
    await this.pool.query(
      `UPDATE users SET
         iq_session_token = NULL,
         iq_session_expires_at = NULL,
         updated_at = now()
       WHERE telegram_id = $1`,
      [telegramId.toString()],
    )
  }

  async hardDelete(telegramId: bigint): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM token_requests WHERE user_telegram_id = $1', [telegramId.toString()])
      await client.query('DELETE FROM trades WHERE user_telegram_id = $1', [telegramId.toString()])
      await client.query('DELETE FROM funnel_events WHERE user_telegram_id = $1', [telegramId.toString()])
      // click_attributions has a NOT NULL FK to users(telegram_id) with no
      // cascade — must be deleted before the users row or the DELETE below
      // raises a foreign-key violation and rolls back the whole purge for
      // any user who ever arrived via a tracked signup link.
      await client.query('DELETE FROM click_attributions WHERE telegram_id = $1', [telegramId.toString()])
      await client.query('DELETE FROM users WHERE telegram_id = $1', [telegramId.toString()])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
}
