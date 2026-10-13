import { adminRepo } from '../../core/repositories/index.js'
import { getLogger } from '../../infra/logger.js'

// In-memory admin lookup. The admins table is small (a handful of IDs) and
// changes rarely (only when a super-admin promotes/removes someone via the
// admin panel). Doing adminRepo.findById on every Telegram update was a
// per-update Postgres SELECT for ~3 IDs that almost never change — pure
// hot-path waste.
//
// Refresh cadence: 60s. Stale-while-error semantics: if a refresh fails
// (DB blip), we keep serving the previous snapshot rather than empty/false.
// On first load failure the set is empty, which is the safe default
// (admin-gated routes will deny until refresh succeeds).

const REFRESH_MS = 60_000

let activeIds: Set<string> = new Set()
let timer: NodeJS.Timeout | null = null
let initialLoad: Promise<void> | null = null

async function refresh(): Promise<void> {
  try {
    const rows = await adminRepo.listActive()
    activeIds = new Set(rows.map((r) => r.telegram_id))
  } catch (err) {
    getLogger().warn({ err, event: 'admin_cache_refresh_failed' }, 'admin cache refresh failed; keeping previous snapshot')
  }
}

export async function ensureAdminCacheReady(): Promise<void> {
  if (initialLoad) return initialLoad
  initialLoad = refresh().then(() => {
    if (!timer) {
      timer = setInterval(() => {
        void refresh()
      }, REFRESH_MS)
      timer.unref?.()
    }
  })
  return initialLoad
}

// Synchronous lookup. Callers MUST have awaited `ensureAdminCacheReady()`
// at least once (we do it during boot in src/index.ts before bot.launch).
export function isAdminCached(telegramId: bigint): boolean {
  return activeIds.has(telegramId.toString())
}

// Test-only: bypass the timer, force refresh, reset state.
export async function _refreshAdminCacheNow(): Promise<void> {
  await refresh()
}

export function _resetAdminCacheForTests(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  activeIds = new Set()
  initialLoad = null
}
