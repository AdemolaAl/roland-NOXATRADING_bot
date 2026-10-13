import { ProxyAgent } from 'undici'
import { getLogger } from '../infra/logger.js'

// Sticky per-user proxy pool for the IQ credential POST. Each telegramId is
// hashed to a fixed pool index, so a given IQ account always authenticates
// from the same egress IP — which both spreads accounts across IPs (defeating
// IQ's many-accounts-per-IP fraud signal) and looks consistent per account.
//
// Disabled by default: with IQ_PROXY_URLS unset/empty, agentFor returns
// undefined and the caller logs in directly. That is the dev default and the
// production rollback lever.

type Pool = {
  urls: string[]
  agents: Array<ProxyAgent | undefined> // lazily filled, one per url
}

let pool: Pool | null = null
let initialized = false

function parsePool(): Pool | null {
  const raw = process.env.IQ_PROXY_URLS ?? ''
  const urls = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (urls.length === 0) return null
  return { urls, agents: new Array(urls.length).fill(undefined) }
}

function getPool(): Pool | null {
  if (!initialized) {
    pool = parsePool()
    initialized = true
    if (pool) {
      getLogger().info({ event: 'iq_proxy_pool_init', size: pool.urls.length }, 'IQ proxy pool enabled')
    }
  }
  return pool
}

// FNV-1a over the telegramId's decimal string. Deterministic, well-spread,
// and stable across restarts so a user keeps the same exit IP.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function indexFor(telegramId: bigint, size: number): number {
  return fnv1a(telegramId.toString()) % size
}

function agentAt(p: Pool, index: number): ProxyAgent {
  let agent = p.agents[index]
  if (!agent) {
    agent = new ProxyAgent(p.urls[index]!)
    p.agents[index] = agent
  }
  return agent
}

// The proxy this user always authenticates through. undefined when disabled.
export function agentFor(telegramId: bigint): ProxyAgent | undefined {
  const p = getPool()
  if (!p) return undefined
  return agentAt(p, indexFor(telegramId, p.urls.length))
}

// A DIFFERENT proxy, for the single retry after a proxy-connect failure.
// undefined when disabled or when the pool has only one proxy (no distinct
// fallback exists).
export function fallbackAgentFor(telegramId: bigint): ProxyAgent | undefined {
  const p = getPool()
  if (!p || p.urls.length < 2) return undefined
  const primary = indexFor(telegramId, p.urls.length)
  return agentAt(p, (primary + 1) % p.urls.length)
}

// The pool index a user maps to (for logging/triage). undefined when disabled.
export function proxyIndexFor(telegramId: bigint): number | undefined {
  const p = getPool()
  if (!p) return undefined
  return indexFor(telegramId, p.urls.length)
}

// The fallback pool index (primary + 1). undefined when disabled or size < 2.
export function fallbackIndexFor(telegramId: bigint): number | undefined {
  const p = getPool()
  if (!p || p.urls.length < 2) return undefined
  return (indexFor(telegramId, p.urls.length) + 1) % p.urls.length
}

// True only for failures where the request never reached IQ (proxy unreachable
// / DNS / connect timeout), so retrying a different proxy cannot double-POST
// credentials. Deliberately conservative: ECONNRESET (possible mid-flight) and
// bad-auth 407 (cause.code 0 — a global credential error the fallback shares)
// are NOT retriable.
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT',
  'UND_ERR_CONNECT_TIMEOUT',
])

export function isProxyConnectError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const cause = (err as { cause?: { code?: unknown } }).cause
  const code = cause?.code
  return typeof code === 'string' && CONNECT_CODES.has(code)
}

// Test-only: drop memoized pool so a test can change IQ_PROXY_URLS and re-read.
export function resetPoolForTest(): void {
  pool = null
  initialized = false
}
