import type { Pool } from 'pg'
import type { Tier } from '../services/tokenCode.js'

export type UnlockTokenRow = {
  id: string
  code: string
  tier: Tier
  bound_iq_user_id: string
  // null for auto-issued tokens (affstore lead-verifier path); set to
  // the issuing admin's Telegram ID for manual approvals.
  issued_by_admin_id: string | null
  issued_to_telegram_id: string | null
  redeemed_at: Date | null
  revoked_at: Date | null
  revoked_by_admin_id: string | null
  revoke_reason: string | null
  created_at: Date
}

export class TokenRepository {
  constructor(private readonly pool: Pool) {}

  async create(params: {
    code: string
    tier: Tier
    boundIqUserId: string
    issuedByAdminId: bigint | null
  }): Promise<UnlockTokenRow> {
    const result = await this.pool.query<UnlockTokenRow>(
      `INSERT INTO unlock_tokens (code, tier, bound_iq_user_id, issued_by_admin_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        params.code,
        params.tier,
        params.boundIqUserId,
        params.issuedByAdminId === null ? null : params.issuedByAdminId.toString(),
      ],
    )
    return result.rows[0]!
  }

  async findByCode(code: string): Promise<UnlockTokenRow | null> {
    const result = await this.pool.query<UnlockTokenRow>(
      'SELECT * FROM unlock_tokens WHERE code = $1',
      [code],
    )
    return result.rows[0] ?? null
  }

  async markRedeemed(id: string, telegramId: bigint): Promise<void> {
    await this.pool.query(
      'UPDATE unlock_tokens SET issued_to_telegram_id = $2, redeemed_at = now() WHERE id = $1',
      [id, telegramId.toString()],
    )
  }

  async revoke(id: string, adminId: bigint, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE unlock_tokens
       SET revoked_at = now(), revoked_by_admin_id = $2, revoke_reason = $3
       WHERE id = $1`,
      [id, adminId.toString(), reason],
    )
  }

  async listAll(opts: { limit: number; offset?: number }): Promise<UnlockTokenRow[]> {
    const result = await this.pool.query<UnlockTokenRow>(
      'SELECT * FROM unlock_tokens ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [opts.limit, opts.offset ?? 0],
    )
    return result.rows
  }

  async findActiveForIqUser(iqUserId: string): Promise<UnlockTokenRow[]> {
    const result = await this.pool.query<UnlockTokenRow>(
      `SELECT * FROM unlock_tokens
       WHERE bound_iq_user_id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [iqUserId],
    )
    return result.rows
  }
}
