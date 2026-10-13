import pg from 'pg'
import { loadEnv } from './env.js'
import { getLogger } from './logger.js'

const { Pool } = pg

let pool: pg.Pool | null = null
let poolStatsTimer: NodeJS.Timeout | null = null

const POOL_STATS_INTERVAL_MS = 30_000

export function getPool(): pg.Pool {
  if (pool) {
    return pool
  }

  const env = loadEnv()

  pool = new Pool({
    connectionString: env.DATABASE_URL,
    // 10 was tuned for low traffic. Under viral load every Telegram update
    // needs 1-2 connections (activity middleware + scene rehydrate + the
    // handler itself), and pg-boss shares this same pool for its queue
    // ops. With 100+ concurrent updates a pool of 10 serializes everything
    // and Telegram callbacks age out before answerCbQuery can fire.
    // Railway's Postgres handles 50 comfortably; bump it.
    max: 50,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })

  pool.on('error', (err) => {
    getLogger().error({ err, event: 'pg_pool_error' }, 'Postgres pool error')
  })

  // Periodic snapshot of pool occupancy. waitingCount > 0 means handlers
  // are blocked waiting for a connection — that's the signal that the
  // pool size or a slow query is starving the bot.
  if (!poolStatsTimer) {
    poolStatsTimer = setInterval(() => {
      const p = pool
      if (!p) return
      const waitingCount = p.waitingCount
      const log = getLogger()
      const payload = {
        event: 'pg_pool_stats',
        total: p.totalCount,
        idle: p.idleCount,
        waitingCount,
      }
      if (waitingCount > 0) {
        log.warn(payload, 'pg pool has waiters')
      } else {
        log.debug(payload, 'pg pool stats')
      }
    }, POOL_STATS_INTERVAL_MS)
    poolStatsTimer.unref?.()
  }

  return pool
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const startedAt = Date.now()
  const result = await getPool().query<T>(text, params as never)
  const elapsedMs = Date.now() - startedAt

  if (elapsedMs > 500) {
    getLogger().warn({ event: 'slow_query', ms: elapsedMs, text }, 'slow query')
  }

  return result
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect()

  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function closePool(): Promise<void> {
  if (poolStatsTimer) {
    clearInterval(poolStatsTimer)
    poolStatsTimer = null
  }
  if (!pool) {
    return
  }

  await pool.end()
  pool = null
}
