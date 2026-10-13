import { getLogger } from '../infra/logger.js'
import { IqClient } from './iqClient.js'

type Entry = {
  client: IqClient
  lastUsed: number
  accountMode: 'demo' | 'live'
}

// Each cached entry holds a live IQ websocket. Idle entries get torn down
// after 30 min so we don't keep a per-user WS open for hours of inactivity.
// 500 is a hard ceiling that keeps memory bounded if we ever go viral; with
// ~200 active users today we're well under it. The sweep cadence (5 min)
// is short enough that idle eviction is timely without burning CPU.
const TTL_MS = 30 * 60 * 1000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000
const STATS_INTERVAL_MS = 60 * 1000
const MAX_ENTRIES = 500

const cache = new Map<bigint, Entry>()
const warming = new Map<bigint, Promise<IqClient>>()

let hits = 0
let misses = 0
let sweepTimer: NodeJS.Timeout | null = null
let statsTimer: NodeJS.Timeout | null = null

function ensureTimers(): void {
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      void sweep()
    }, SWEEP_INTERVAL_MS)
    sweepTimer.unref?.()
  }
  if (!statsTimer) {
    statsTimer = setInterval(logStats, STATS_INTERVAL_MS)
    statsTimer.unref?.()
  }
}

async function sweep(): Promise<void> {
  const cutoff = Date.now() - TTL_MS
  let evictedIdle = 0
  for (const [id, entry] of cache) {
    if (entry.lastUsed < cutoff) {
      cache.delete(id)
      evictedIdle += 1
      try {
        await entry.client.logout()
      } catch {
        // logout is best-effort; the SDK may already have dropped the WS
      }
    }
  }

  let evictedLru = 0
  while (cache.size > MAX_ENTRIES) {
    let oldestId: bigint | null = null
    let oldestTime = Infinity
    for (const [id, entry] of cache) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed
        oldestId = id
      }
    }
    if (oldestId === null) break
    const entry = cache.get(oldestId)
    cache.delete(oldestId)
    evictedLru += 1
    if (entry) {
      try {
        await entry.client.logout()
      } catch {
        // see above
      }
    }
  }

  if (evictedIdle > 0 || evictedLru > 0) {
    getLogger().debug(
      { event: 'iq_cache_sweep', evictedIdle, evictedLru, size: cache.size },
      'iq session cache swept',
    )
  }
}

function logStats(): void {
  getLogger().info(
    { event: 'iq_cache_stats', size: cache.size, hits, misses, warming: warming.size },
    'iq session cache stats',
  )
  hits = 0
  misses = 0
}

// Returns a live IqClient for this user. On a cache hit, no WS reconnect.
// On a miss, a fresh `resumeSession` runs and the result is cached. Two
// concurrent calls for the same user share the same in-flight resume
// promise so we never open two parallel WS for one user.
export async function getCachedClient(
  telegramId: bigint,
  accountMode: 'demo' | 'live',
  loadSessionToken: () => string | Promise<string>,
): Promise<IqClient> {
  ensureTimers()

  const existing = cache.get(telegramId)
  if (existing) {
    existing.lastUsed = Date.now()
    if (existing.accountMode !== accountMode) {
      await existing.client.setAccountMode(accountMode)
      existing.accountMode = accountMode
    }
    hits += 1
    return existing.client
  }

  const ongoing = warming.get(telegramId)
  if (ongoing) {
    const client = await ongoing
    const entry = cache.get(telegramId)
    if (entry && entry.accountMode !== accountMode) {
      await client.setAccountMode(accountMode)
      entry.accountMode = accountMode
    }
    return client
  }

  misses += 1
  const promise = (async () => {
    const token = await loadSessionToken()
    const client = new IqClient()
    await client.resumeSession(token)
    await client.setAccountMode(accountMode)
    cache.set(telegramId, {
      client,
      lastUsed: Date.now(),
      accountMode,
    })
    return client
  })()
  warming.set(telegramId, promise)
  try {
    return await promise
  } finally {
    warming.delete(telegramId)
  }
}

// Hand a freshly-built client (e.g. straight after first-time login) to the
// cache so the very next user action skips the resume entirely.
export function adoptClient(
  telegramId: bigint,
  client: IqClient,
  accountMode: 'demo' | 'live',
): void {
  ensureTimers()
  const previous = cache.get(telegramId)
  cache.set(telegramId, {
    client,
    lastUsed: Date.now(),
    accountMode,
  })
  if (previous && previous.client !== client) {
    previous.client.logout().catch(() => {})
  }
}

// Drop a cached client — call when an SDK error suggests the session is
// dead (auth revoked, WS torn down for good). The next getCachedClient
// will rebuild it from the stored token.
export async function invalidateCachedClient(telegramId: bigint): Promise<void> {
  const entry = cache.get(telegramId)
  if (!entry) return
  cache.delete(telegramId)
  try {
    await entry.client.logout()
  } catch {
    // see sweep()
  }
}

export function getIqCacheSize(): number {
  return cache.size
}

export async function shutdownIqCache(): Promise<void> {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  if (statsTimer) {
    clearInterval(statsTimer)
    statsTimer = null
  }
  const entries = Array.from(cache.values())
  cache.clear()
  warming.clear()
  await Promise.all(entries.map((entry) => entry.client.logout().catch(() => {})))
}
