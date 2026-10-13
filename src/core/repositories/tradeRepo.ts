import type { Pool } from 'pg'

export type TradeDirection = 'call' | 'put'
export type TradeOutcome = 'win' | 'loss' | 'aborted'
export type Timeframe = '30s' | '1m' | '2m' | '5m'
export type AccountMode = 'demo' | 'live'

export type GaleStep = {
  step: number
  stake: number
  iq_trade_id?: string
  outcome?: TradeOutcome
  return?: number
  error?: string
}

export type TradeRow = {
  id: string
  user_telegram_id: string
  trade_num: number
  pair_code: string
  pair_flag: string
  direction: TradeDirection
  timeframe: Timeframe
  account_mode: AccountMode
  base_stake: string
  gale_steps: GaleStep[]
  final_outcome: TradeOutcome | null
  win_step: number | null
  net_result: string | null
  pro_session_id: string | null
  started_at: Date
  ended_at: Date | null
}

export type TradeAggregate = {
  total_trades: number
  total_staked: string
  net_pnl: string
}

export class TradeRepository {
  constructor(private readonly pool: Pool) {}

  async create(params: {
    userTelegramId: bigint
    tradeNum: number
    pairCode: string
    pairFlag: string
    direction: TradeDirection
    timeframe: Timeframe
    accountMode: AccountMode
    baseStake: number
    proSessionId?: string
  }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO trades (
         user_telegram_id, trade_num, pair_code, pair_flag, direction, timeframe,
         account_mode, base_stake, pro_session_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        params.userTelegramId.toString(),
        params.tradeNum,
        params.pairCode,
        params.pairFlag,
        params.direction,
        params.timeframe,
        params.accountMode,
        params.baseStake,
        params.proSessionId ?? null,
      ],
    )
    return result.rows[0]!.id
  }

  async appendStep(tradeId: string, step: GaleStep): Promise<void> {
    await this.pool.query(
      `UPDATE trades
       SET gale_steps = COALESCE(gale_steps, '[]'::jsonb) || $2::jsonb
       WHERE id = $1`,
      [tradeId, JSON.stringify([step])],
    )
  }

  async complete(
    tradeId: string,
    outcome: TradeOutcome,
    winStep: number | null,
    netResult: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE trades
       SET final_outcome = $2, win_step = $3, net_result = $4, ended_at = now()
       WHERE id = $1`,
      [tradeId, outcome, winStep, netResult],
    )
  }

  async findById(id: string): Promise<TradeRow | null> {
    const result = await this.pool.query<TradeRow>('SELECT * FROM trades WHERE id = $1', [id])
    return result.rows[0] ?? null
  }

  async findRecentByUser(telegramId: bigint, limit: number): Promise<TradeRow[]> {
    const result = await this.pool.query<TradeRow>(
      'SELECT * FROM trades WHERE user_telegram_id = $1 ORDER BY started_at DESC LIMIT $2',
      [telegramId.toString(), limit],
    )
    return result.rows
  }

  async findInFlightByUser(telegramId: bigint): Promise<TradeRow[]> {
    const result = await this.pool.query<TradeRow>(
      'SELECT * FROM trades WHERE user_telegram_id = $1 AND ended_at IS NULL ORDER BY started_at ASC',
      [telegramId.toString()],
    )
    return result.rows
  }

  async findProSession(proSessionId: string): Promise<TradeRow[]> {
    const result = await this.pool.query<TradeRow>(
      'SELECT * FROM trades WHERE pro_session_id = $1 ORDER BY started_at ASC',
      [proSessionId],
    )
    return result.rows
  }

  async topByVolumeLast30d(limit: number): Promise<Array<{ user_telegram_id: string; total_volume: string }>> {
    const result = await this.pool.query<{ user_telegram_id: string; total_volume: string }>(
      `SELECT user_telegram_id, COALESCE(SUM(base_stake), 0)::text AS total_volume
       FROM trades
       WHERE started_at > NOW() - INTERVAL '30 days'
       GROUP BY user_telegram_id
       ORDER BY SUM(base_stake) DESC, user_telegram_id ASC
       LIMIT $1`,
      [limit],
    )
    return result.rows
  }

  async aggregatesForUser(telegramId: bigint): Promise<TradeAggregate> {
    // to_char with 'FM999999990.00' guarantees a stable two-decimal string
    // ('119.00', '-11.60') regardless of trailing-zero trimming. Casting
    // numeric directly to ::text drops trailing zeros and gives '119' or
    // '-11.6', which broke both the unit test and demoConversion.scene's
    // unformatted display ("$-11.6" instead of "$-11.60").
    const result = await this.pool.query<TradeAggregate>(
      `SELECT
         COUNT(*)::int AS total_trades,
         to_char(
           COALESCE(
             SUM(
               COALESCE(
                 (
                   SELECT SUM((step->>'stake')::numeric)
                   FROM jsonb_array_elements(COALESCE(trades.gale_steps, '[]'::jsonb)) AS step
                 ),
                 base_stake
               )
             ),
             0
           ),
           'FM999999990.00'
         ) AS total_staked,
         to_char(COALESCE(SUM(net_result), 0), 'FM999999990.00') AS net_pnl
       FROM trades
       WHERE user_telegram_id = $1`,
      [telegramId.toString()],
    )
    return result.rows[0]!
  }
}
