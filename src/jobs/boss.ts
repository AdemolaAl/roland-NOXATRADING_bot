import { PgBoss } from 'pg-boss'
import { loadEnv } from '../infra/env.js'
import { getLogger } from '../infra/logger.js'

let boss: PgBoss | null = null
const REQUIRED_QUEUES = ['inactivity-ping', 'broadcast-send', 'deposit-poll'] as const

export async function getBoss(): Promise<PgBoss> {
  if (boss) {
    return boss
  }

  const env = loadEnv()
  boss = new PgBoss({ connectionString: env.DATABASE_URL })
  boss.on('error', (err) => getLogger().error({ err, event: 'boss_error' }, 'pg-boss error'))
  await boss.start()
  for (const queue of REQUIRED_QUEUES) {
    await boss.createQueue(queue)
  }
  getLogger().debug({ event: 'boss_started' }, 'pg-boss started')
  return boss
}

export async function maybeGetBoss(): Promise<PgBoss | null> {
  return boss
}

export async function closeBoss(): Promise<void> {
  if (!boss) {
    return
  }

  await boss.stop()
  boss = null
}
