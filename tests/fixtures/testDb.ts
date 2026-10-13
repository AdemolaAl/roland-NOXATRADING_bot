import { Pool } from 'pg'

const url =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/noxatrading_test'

export const testPool = new Pool({ connectionString: url })

export async function resetDb(): Promise<void> {
  await testPool.query(
    'TRUNCATE users, trades, unlock_tokens, token_requests, admins, audit_log, broadcasts, funnel_events RESTART IDENTITY CASCADE',
  )
  await testPool.query('DELETE FROM system_state WHERE id = 1')
  await testPool.query(
    'INSERT INTO system_state (id, paused_all, paused_auto, paused_pro) VALUES (1, false, false, false) ON CONFLICT (id) DO NOTHING',
  )
}
