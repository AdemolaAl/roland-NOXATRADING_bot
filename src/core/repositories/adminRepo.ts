import type { Pool } from 'pg'
import { loadEnv } from '../../infra/env.js'

export type AdminRole = 'super_admin' | 'admin'

export type AdminRow = {
  telegram_id: string
  username: string | null
  display_name: string
  role: AdminRole
  added_by: string | null
  added_at: Date
  last_active_at: Date
  removed_at: Date | null
}

export class AdminRepository {
  constructor(private readonly pool: Pool) {}

  async findById(telegramId: bigint): Promise<AdminRow | null> {
    const result = await this.pool.query<AdminRow>(
      'SELECT * FROM admins WHERE telegram_id = $1',
      [telegramId.toString()],
    )
    return result.rows[0] ?? null
  }

  async listActive(): Promise<AdminRow[]> {
    const result = await this.pool.query<AdminRow>(
      'SELECT * FROM admins WHERE removed_at IS NULL ORDER BY added_at ASC',
    )
    return result.rows
  }

  async add(params: {
    telegramId: bigint
    username?: string
    displayName: string
    role?: AdminRole
    addedBy?: bigint
  }): Promise<AdminRow> {
    const result = await this.pool.query<AdminRow>(
      `INSERT INTO admins (telegram_id, username, display_name, role, added_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (telegram_id) DO UPDATE
         SET username = EXCLUDED.username,
             display_name = EXCLUDED.display_name,
             role = EXCLUDED.role,
             removed_at = NULL
       RETURNING *`,
      [
        params.telegramId.toString(),
        params.username ?? null,
        params.displayName,
        params.role ?? 'admin',
        params.addedBy?.toString() ?? null,
      ],
    )
    return result.rows[0]!
  }

  async softRemove(telegramId: bigint, byAdminId: bigint): Promise<void> {
    await this.pool.query(
      'UPDATE admins SET removed_at = now(), last_active_at = now(), added_by = $2 WHERE telegram_id = $1',
      [telegramId.toString(), byAdminId.toString()],
    )
  }

  async touchLastActive(telegramId: bigint): Promise<void> {
    await this.pool.query('UPDATE admins SET last_active_at = now() WHERE telegram_id = $1', [
      telegramId.toString(),
    ])
  }

  async seedFromEnv(): Promise<AdminRow[]> {
    const env = loadEnv()
    const superAdminIds = env.SUPER_ADMIN_TELEGRAM_ID
    const adminIds = env.ADMIN_TELEGRAM_IDS.filter((id) => !superAdminIds.includes(id))
    const seeded: AdminRow[] = []

    for (const telegramId of superAdminIds) {
      seeded.push(
        await this.add({
          telegramId,
          displayName: 'Super Admin',
          role: 'super_admin',
        }),
      )
    }

    for (const telegramId of adminIds) {
      seeded.push(
        await this.add({
          telegramId,
          displayName: 'Admin',
          role: 'admin',
        }),
      )
    }

    return seeded
  }
}
