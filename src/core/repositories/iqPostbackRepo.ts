import type { Pool } from 'pg'

export type IqPostbackProfile = {
  // Whether this trader_id appears at all in the affiliate funnel.
  inFunnel: boolean
  // Distinct afftrack values the trader has been seen under. Usually 1
  // (a trader belongs to one sub-promoter), but the schema allows
  // multiple in case Affstore re-attributes.
  afftracks: string[]
  // Boolean snapshots — registered ever / deposited ever.
  registered: boolean
  hasDeposited: boolean
  // Aggregates across all event rows for this trader.
  depositCount: number
  depositTotal: number
  registeredAt: Date | null
  lastDepositAt: Date | null
  countryCode: string | null
}

const EMPTY: IqPostbackProfile = {
  inFunnel: false,
  afftracks: [],
  registered: false,
  hasDeposited: false,
  depositCount: 0,
  depositTotal: 0,
  registeredAt: null,
  lastDepositAt: null,
  countryCode: null,
}

export class IqPostbackRepository {
  constructor(private readonly pool: Pool) {}

  // Persists a single parsed postback. ON CONFLICT no-ops on Telegram
  // retries — the partial UNIQUE index on (source_chat_id,
  // source_message_id) is the dedup key.
  async insertPostback(input: {
    traderId: string
    eventType: string
    rawEvent: string
    amount: number | null
    countryCode: string | null
    afftrack: string | null
    clickid: string | null
    rawText: string
    sourceChatId: number
    sourceMessageId: number
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO iq_postbacks
         (trader_id, event_type, raw_event, amount, country_code, afftrack,
          clickid, raw_text, source_chat_id, source_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (source_chat_id, source_message_id) DO NOTHING`,
      [
        input.traderId,
        input.eventType,
        input.rawEvent,
        input.amount,
        input.countryCode,
        input.afftrack,
        input.clickid,
        input.rawText,
        input.sourceChatId,
        input.sourceMessageId,
      ],
    )
  }

  // S2S insert path: keyed by Affstore's event_id (or a derived
  // composite) so retried deliveries no-op via the partial UNIQUE
  // index on s2s_idempotency_key. The channel path's insertPostback
  // dedupes on (source_chat_id, source_message_id) instead — the two
  // sources have different natural keys, hence two methods.
  async insertS2S(input: {
    traderId: string
    eventType: string
    rawEvent: string
    amount: number | null
    countryCode: string | null
    afftrack: string | null
    clickid: string | null
    rawText: string
    idempotencyKey: string
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO iq_postbacks
         (trader_id, event_type, raw_event, amount, country_code, afftrack,
          clickid, raw_text, source, s2s_idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 's2s', $9)
       ON CONFLICT (s2s_idempotency_key)
         WHERE s2s_idempotency_key IS NOT NULL
         DO NOTHING`,
      [
        input.traderId,
        input.eventType,
        input.rawEvent,
        input.amount,
        input.countryCode,
        input.afftrack,
        input.clickid,
        input.rawText,
        input.idempotencyKey,
      ],
    )
  }

  // FTD vs redeposit classification: Affstore fires 'ftd' on the first
  // deposit and 'redeposit' on subsequent ones. The webhook handler
  // determines which by asking "have I seen any FTD/redeposit row for
  // this trader yet?" — first one is FTD.
  async hasFtdForTrader(traderId: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM iq_postbacks
         WHERE trader_id = $1
           AND event_type IN ('ftd', 'redeposit')
       ) AS exists`,
      [traderId],
    )
    return result.rows[0]?.exists ?? false
  }

  // Aggregate everything we know about a single trader_id. Indexed by
  // trader_id → sub-millisecond. Designed to be the single call that
  // powers admin verification badges and the auto-approve verifier.
  async lookupByTraderId(traderId: string): Promise<IqPostbackProfile> {
    if (!traderId) return EMPTY
    const result = await this.pool.query<{
      afftracks: (string | null)[]
      registered: boolean
      has_deposited: boolean
      deposit_count: string
      deposit_total: string | null
      registered_at: Date | null
      last_deposit_at: Date | null
      country_code: string | null
    }>(
      `SELECT
         array_agg(DISTINCT afftrack) FILTER (WHERE afftrack IS NOT NULL) AS afftracks,
         BOOL_OR(event_type = 'registration')                              AS registered,
         BOOL_OR(event_type IN ('ftd', 'redeposit'))                       AS has_deposited,
         COUNT(*) FILTER (WHERE event_type IN ('ftd', 'redeposit'))::text  AS deposit_count,
         COALESCE(SUM(amount) FILTER (WHERE event_type IN ('ftd', 'redeposit')), 0)::text AS deposit_total,
         MIN(received_at) FILTER (WHERE event_type = 'registration')       AS registered_at,
         MAX(received_at) FILTER (WHERE event_type IN ('ftd', 'redeposit')) AS last_deposit_at,
         (array_agg(country_code ORDER BY received_at DESC) FILTER (WHERE country_code IS NOT NULL))[1] AS country_code
       FROM iq_postbacks
       WHERE trader_id = $1`,
      [traderId],
    )
    const row = result.rows[0]
    if (!row || (!row.registered && !row.has_deposited && Number(row.deposit_count) === 0)) {
      return EMPTY
    }
    return {
      inFunnel: true,
      afftracks: (row.afftracks ?? []).filter((a): a is string => typeof a === 'string'),
      registered: row.registered,
      hasDeposited: row.has_deposited,
      depositCount: Number(row.deposit_count),
      depositTotal: Number(row.deposit_total ?? 0),
      registeredAt: row.registered_at,
      lastDepositAt: row.last_deposit_at,
      countryCode: row.country_code,
    }
  }

  // Per-afftrack analytics roll-up for the admin glance ("which
  // sub-promoter is bringing in deposits today / this week"). Cheap
  // because both afftrack and event_type are indexed.
  async aggregateByAfftrack(opts: { since: Date }): Promise<
    Array<{
      afftrack: string
      registrations: number
      deposits: number
      depositTotal: number
      uniqueTraders: number
    }>
  > {
    const result = await this.pool.query<{
      afftrack: string
      registrations: string
      deposits: string
      deposit_total: string
      unique_traders: string
    }>(
      `SELECT
         COALESCE(afftrack, '(unknown)') AS afftrack,
         COUNT(*) FILTER (WHERE event_type = 'registration')::text  AS registrations,
         COUNT(*) FILTER (WHERE event_type IN ('ftd', 'redeposit'))::text AS deposits,
         COALESCE(SUM(amount) FILTER (WHERE event_type IN ('ftd', 'redeposit')), 0)::text AS deposit_total,
         COUNT(DISTINCT trader_id)::text AS unique_traders
       FROM iq_postbacks
       WHERE received_at >= $1
       GROUP BY afftrack
       ORDER BY deposit_total::numeric DESC NULLS LAST`,
      [opts.since],
    )
    return result.rows.map((r) => ({
      afftrack: r.afftrack,
      registrations: Number(r.registrations),
      deposits: Number(r.deposits),
      depositTotal: Number(r.deposit_total),
      uniqueTraders: Number(r.unique_traders),
    }))
  }
}
