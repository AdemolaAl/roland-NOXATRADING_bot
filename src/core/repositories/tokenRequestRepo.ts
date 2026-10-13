import type { Pool } from 'pg'
import type { Tier } from '../services/tokenCode.js'

export type TokenRequestRow = {
  id: string
  user_telegram_id: string
  requested_tier: Tier
  iq_user_id: string | null
  reason: string | null
  status: 'pending' | 'approved' | 'rejected'
  approved_by_admin_id: string | null
  issued_token_id: string | null
  rejection_reason: string | null
  created_at: Date
  resolved_at: Date | null
}

export class TokenRequestRepository {
  constructor(private readonly pool: Pool) {}

  async create(params: {
    userTelegramId: bigint
    requestedTier: Tier
    iqUserId?: string
    reason?: string
  }): Promise<TokenRequestRow> {
    const result = await this.pool.query<TokenRequestRow>(
      `INSERT INTO token_requests (user_telegram_id, requested_tier, iq_user_id, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        params.userTelegramId.toString(),
        params.requestedTier,
        params.iqUserId ?? null,
        params.reason ?? null,
      ],
    )
    return result.rows[0]!
  }

  async listPending(): Promise<TokenRequestRow[]> {
    const result = await this.pool.query<TokenRequestRow>(
      "SELECT * FROM token_requests WHERE status = 'pending' ORDER BY created_at ASC",
    )
    return result.rows
  }

  async approve(id: string, adminId: bigint, tokenId: string): Promise<void> {
    await this.pool.query(
      `UPDATE token_requests
       SET status = 'approved', approved_by_admin_id = $2, issued_token_id = $3, resolved_at = now()
       WHERE id = $1`,
      [id, adminId.toString(), tokenId],
    )
  }

  // Auto-approval path used when the affstore lead-verifier passes the
  // request without any admin involvement. approved_by_admin_id stays
  // NULL and auto_approved=true so analytics can distinguish these from
  // human approvals.
  async approveAuto(id: string, tokenId: string): Promise<void> {
    await this.pool.query(
      `UPDATE token_requests
       SET status = 'approved', approved_by_admin_id = NULL,
           issued_token_id = $2, auto_approved = true, resolved_at = now()
       WHERE id = $1`,
      [id, tokenId],
    )
  }

  async reject(id: string, adminId: bigint, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE token_requests
       SET status = 'rejected', approved_by_admin_id = $2, rejection_reason = $3, resolved_at = now()
       WHERE id = $1`,
      [id, adminId.toString(), reason],
    )
  }

  // Bulk-reject every pending request a single user has filed. Used
  // when a user is promoted to admin so their leftover requests don't
  // sit in the queue alongside real users'. Returns the number of
  // requests that were actually cancelled (0 if there were none).
  async cancelAllPendingForUser(
    userTelegramId: bigint,
    byAdminId: bigint,
    reason: string,
  ): Promise<number> {
    const result = await this.pool.query(
      `UPDATE token_requests
          SET status = 'rejected',
              approved_by_admin_id = $2,
              rejection_reason = $3,
              resolved_at = now()
        WHERE user_telegram_id = $1
          AND status = 'pending'`,
      [userTelegramId.toString(), byAdminId.toString(), reason],
    )
    return result.rowCount ?? 0
  }

  async findById(id: string): Promise<TokenRequestRow | null> {
    const result = await this.pool.query<TokenRequestRow>(
      'SELECT * FROM token_requests WHERE id = $1',
      [id],
    )
    return result.rows[0] ?? null
  }
}
