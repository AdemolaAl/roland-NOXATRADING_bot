import type { Pool } from 'pg'

export type SystemStateRow = {
  id: number
  paused_all: boolean
  paused_auto: boolean
  paused_pro: boolean
  updated_by: string | null
  updated_at: Date
}

export type PauseField = 'paused_all' | 'paused_auto' | 'paused_pro'

const FIELD_MAP: Record<PauseField, PauseField> = {
  paused_all: 'paused_all',
  paused_auto: 'paused_auto',
  paused_pro: 'paused_pro',
}

export class SystemStateRepository {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<SystemStateRow> {
    const result = await this.pool.query<SystemStateRow>('SELECT * FROM system_state WHERE id = 1')
    return result.rows[0]!
  }

  async setPaused(field: PauseField, value: boolean, byAdminId: bigint): Promise<SystemStateRow> {
    const column = FIELD_MAP[field]
    const result = await this.pool.query<SystemStateRow>(
      `UPDATE system_state
       SET ${column} = $1, updated_by = $2, updated_at = now()
       WHERE id = 1
       RETURNING *`,
      [value, byAdminId.toString()],
    )
    return result.rows[0]!
  }
}
