import { getLogger } from './logger.js'

// The public IPv4 the bot's outbound HTTP/WS traffic exits Railway through.
// Railway NATs through a shared pool, so this is what IQ Option's WAF sees on
// every connection from us — the IP to give IQ support if we need a whitelist
// or to diagnose per-IP rate-limit / block events. We cache it at boot
// instead of probing on every error path because:
//   1. error paths are already slow (the user is waiting on a failed login),
//      adding another HTTP round-trip would make it worse
//   2. the egress IP rarely changes between Railway deploys; a periodic
//      refresh covers the case where it does
//   3. when IQ is unreachable, external echo services may also be unreachable
//      (correlated outage) — better to have a stale cached value than nothing
let cached: string | null = null
let refreshTimer: NodeJS.Timeout | null = null

// One hour. Shorter than that and we burn API calls for no reason; longer and
// a Railway-side IP rotation goes undetected for too long.
const REFRESH_INTERVAL_MS = 60 * 60 * 1000

// Five seconds is enough for either echo service under normal conditions and
// short enough that boot isn't held up if both are down. The probe runs in
// the background anyway.
const PROBE_TIMEOUT_MS = 5_000

async function probeOnce(): Promise<string | null> {
  try {
    // Race two independent echo services so a single one being down doesn't
    // make us blind. Promise.any resolves with whichever succeeds first.
    const text = await Promise.any([
      fetch('https://api.ipify.org', { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).then((r) => r.text()),
      fetch('https://ifconfig.me/ip', { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).then((r) => r.text()),
    ])
    const ip = text.trim()
    // Cheap sanity check — both services return a bare IP, not HTML. Reject
    // anything that doesn't look IP-ish so we don't cache an error page.
    if (!/^[0-9a-fA-F:.]+$/.test(ip) || ip.length > 45) return null
    return ip
  } catch {
    return null
  }
}

async function refresh(): Promise<void> {
  const ip = await probeOnce()
  if (!ip) {
    // Don't overwrite a known-good value with null on a transient echo
    // failure. If we've never had a value, leave it null — every log line
    // will say egressIp: null which itself signals "boot probe failed."
    return
  }
  const changed = cached !== null && cached !== ip
  cached = ip
  if (changed) {
    getLogger().warn(
      { event: 'egress_ip_changed', egressIp: ip },
      'egress IP changed — Railway rotated us or moved the service',
    )
  } else {
    getLogger().info({ event: 'egress_ip_refreshed', egressIp: ip }, 'egress IP refreshed')
  }
}

// Fire-and-forget. Safe to call multiple times — re-arming the timer is a
// no-op if one is already running.
export function warmEgressIp(): void {
  void refresh()
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      void refresh()
    }, REFRESH_INTERVAL_MS)
    refreshTimer.unref?.()
  }
}

// Synchronous read. Returns null until the first probe completes (~1 second
// after boot). Every log site that uses this should treat null as a valid
// value, not skip the log.
export function getEgressIp(): string | null {
  return cached
}

// For tests and graceful shutdown — stop the refresh timer so the process
// can exit cleanly.
export function shutdownEgressIp(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}
