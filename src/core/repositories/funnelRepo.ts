import type { Pool } from 'pg'

export type FunnelEventType =
  | 'started'
  | 'iq_connected'
  | 'demo_tested'
  | 'auto_upgraded'
  | 'pro_upsell_hit'
  | 'pro_upgraded'

export type FunnelRow = {
  eventType: FunnelEventType
  count: number
}

const FUNNEL_EVENTS: readonly FunnelEventType[] = [
  'started',
  'iq_connected',
  'demo_tested',
  'auto_upgraded',
  'pro_upsell_hit',
  'pro_upgraded',
] as const

export class FunnelRepository {
  constructor(private readonly pool: Pool) {}

  async record(
    telegramId: bigint,
    eventType: FunnelEventType,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO funnel_events (user_telegram_id, event_type, payload) VALUES ($1, $2, $3)',
      [telegramId.toString(), eventType, payload ?? null],
    )
  }

  async funnelLast7d(): Promise<FunnelRow[]> {
    const result = await this.pool.query<{ event_type: FunnelEventType; count: string }>(
      `SELECT event_type, COUNT(*)::text AS count
       FROM funnel_events
       WHERE created_at > NOW() - INTERVAL '7 days'
       GROUP BY event_type`,
    )

    const counts = new Map(result.rows.map((row) => [row.event_type, Number(row.count)]))
    return FUNNEL_EVENTS.map((eventType) => ({
      eventType,
      count: counts.get(eventType) ?? 0,
    }))
  }

  async countByEvent(eventType: FunnelEventType, range: { from: Date; to: Date }): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM funnel_events
       WHERE event_type = $1 AND created_at BETWEEN $2 AND $3`,
      [eventType, range.from, range.to],
    )
    return Number(result.rows[0]!.count)
  }
}
