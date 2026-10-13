import type { Pool } from 'pg'

export type ClickAttributionRow = {
  click_id: string
  telegram_id: string
  tier_intent: string
  created_at: Date
  matched_at: Date | null
  matched_trader_id: string | null
  matched_via: string | null
}

export class ClickAttributionRepository {
  constructor(private readonly pool: Pool) {}

  async insert(input: {
    clickId: string
    telegramId: bigint
    tierIntent: 'auto' | 'pro' | 'unknown'
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO click_attributions (click_id, telegram_id, tier_intent)
       VALUES ($1, $2, $3)
       ON CONFLICT (click_id) DO NOTHING`,
      [input.clickId, input.telegramId.toString(), input.tierIntent],
    )
  }

  async findByClickId(clickId: string): Promise<ClickAttributionRow | null> {
    const result = await this.pool.query<ClickAttributionRow>(
      'SELECT * FROM click_attributions WHERE click_id = $1',
      [clickId],
    )
    return result.rows[0] ?? null
  }

  // First-come-first-served match. Returns true iff this call actually
  // claimed the row (matched_at was NULL before). Concurrent calls for
  // the same clickId all see exactly one true return — Postgres
  // UPDATE...WHERE is atomic per row. Used by attributePostback to
  // dedupe duplicate registration postbacks.
  async markMatched(input: {
    clickId: string
    traderId: string
    via: 's2s' | 'manual' | 'channel'
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE click_attributions
         SET matched_at = now(),
             matched_trader_id = $2,
             matched_via = $3
       WHERE click_id = $1
         AND matched_at IS NULL`,
      [input.clickId, input.traderId, input.via],
    )
    return (result.rowCount ?? 0) > 0
  }
}
