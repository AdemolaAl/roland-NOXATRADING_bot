import type { Pool } from 'pg'

export type AuditRow = {
  id: string
  admin_telegram_id: string
  action_type: string
  target_type: string | null
  target_id: string | null
  payload: Record<string, unknown>
  created_at: Date
}

type ListOpts = {
  adminTelegramId?: bigint
  actionType?: string
  from?: Date
  to?: Date
}

export class AuditLogRepository {
  constructor(private readonly pool: Pool) {}

  async record(params: {
    adminTelegramId: bigint
    actionType: string
    targetType?: string
    targetId?: string
    payload?: Record<string, unknown>
  }): Promise<AuditRow> {
    const result = await this.pool.query<AuditRow>(
      `INSERT INTO audit_log (admin_telegram_id, action_type, target_type, target_id, payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        params.adminTelegramId.toString(),
        params.actionType,
        params.targetType ?? null,
        params.targetId ?? null,
        params.payload ?? {},
      ],
    )
    return result.rows[0]!
  }

  async listRecent(limit: number, opts: ListOpts = {}): Promise<AuditRow[]> {
    const { clause, params } = buildAuditWhere(opts)
    const result = await this.pool.query<AuditRow>(
      `SELECT * FROM audit_log ${clause} ORDER BY created_at DESC LIMIT $${params.length + 1}`,
      [...params, limit],
    )
    return result.rows
  }

  async exportRange(from: Date, to: Date): Promise<AuditRow[]> {
    const result = await this.pool.query<AuditRow>(
      'SELECT * FROM audit_log WHERE created_at BETWEEN $1 AND $2 ORDER BY created_at ASC',
      [from, to],
    )
    return result.rows
  }

  async count(opts: ListOpts = {}): Promise<number> {
    const { clause, params } = buildAuditWhere(opts)
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_log ${clause}`,
      params,
    )
    return Number(result.rows[0]!.count)
  }
}

function buildAuditWhere(opts: ListOpts): { clause: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.adminTelegramId) {
    params.push(opts.adminTelegramId.toString())
    conditions.push(`admin_telegram_id = $${params.length}`)
  }

  if (opts.actionType) {
    params.push(opts.actionType)
    conditions.push(`action_type = $${params.length}`)
  }

  if (opts.from) {
    params.push(opts.from)
    conditions.push(`created_at >= $${params.length}`)
  }

  if (opts.to) {
    params.push(opts.to)
    conditions.push(`created_at <= $${params.length}`)
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}
