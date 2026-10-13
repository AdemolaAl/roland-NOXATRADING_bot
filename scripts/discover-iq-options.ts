// Discovery script: prints every active (pair) in each option facade —
// Blitz, Turbo, Binary — with its supported expiration durations in seconds.
//
// Run:  node --env-file=.env ./node_modules/.bin/tsx scripts/discover-iq-options.ts
//
// Reads IQ_SDK_WS_URL, IQ_SDK_HTTP_URL, IQ_SDK_PLATFORM_ID, IQ_TEST_EMAIL,
// IQ_TEST_PASSWORD from process.env. Filter to OTC pairs by default;
// pass `--all` as the first argument to see every active.

import { ClientSdk, SsidAuthMethod } from '@tradecodehub/client-sdk-js'

type FacadeName = 'BLITZ' | 'TURBO' | 'BINARY'
type Row = {
  facade: FacadeName
  ticker: string
  suspended: boolean
  expirations: number[] // seconds
}

function fmtSec(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing env var: ${name}`)
  return value
}

async function loginForSsid(httpUrl: string, email: string, password: string): Promise<string> {
  const response = await fetch(`${httpUrl}/v2/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'tradecodehub-client-sdk-js/1.3.0',
    },
    body: JSON.stringify({ identifier: email, password }),
  })
  const json = (await response.json()) as { code?: string; ssid?: string }
  if (!response.ok || json.code !== 'success' || !json.ssid) {
    throw new Error(`login_failed: status=${response.status} code=${json.code ?? 'unknown'}`)
  }
  return json.ssid
}

async function main(): Promise<void> {
  const showAll = process.argv.includes('--all')
  const wsUrl = requireEnv('IQ_SDK_WS_URL')
  const httpUrl = requireEnv('IQ_SDK_HTTP_URL')
  const platformId = Number(process.env.IQ_SDK_PLATFORM_ID ?? '82')
  const email = requireEnv('IQ_TEST_EMAIL')
  const password = requireEnv('IQ_TEST_PASSWORD')

  console.log(`[discover] logging in as ${email}…`)
  const ssid = await loginForSsid(httpUrl, email, password)
  const sdk = await ClientSdk.create(wsUrl, platformId, new SsidAuthMethod(ssid))
  console.log(`[discover] logged in (userId=${sdk.userProfile.userId})`)

  const rows: Row[] = []

  console.log('[discover] reading Blitz actives…')
  const blitz = await sdk.blitzOptions()
  for (const a of blitz.getActives()) {
    rows.push({
      facade: 'BLITZ',
      ticker: a.ticker,
      suspended: a.isSuspended,
      expirations: [...a.expirationTimes].sort((x, y) => x - y),
    })
  }

  console.log('[discover] reading Turbo actives…')
  const turbo = await sdk.turboOptions()
  for (const a of turbo.getActives()) {
    rows.push({
      facade: 'TURBO',
      ticker: a.ticker,
      suspended: a.isSuspended,
      expirations: [...a.expirationTimes].sort((x, y) => x - y),
    })
  }

  console.log('[discover] reading Binary actives…')
  const binary = await sdk.binaryOptions()
  for (const a of binary.getActives()) {
    rows.push({
      facade: 'BINARY',
      ticker: a.ticker,
      suspended: a.isSuspended,
      expirations: [...a.expirationTimes].sort((x, y) => x - y),
    })
  }

  const filtered = showAll ? rows : rows.filter((r) => r.ticker.includes('-OTC'))
  filtered.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.facade.localeCompare(b.facade))

  console.log('')
  console.log(`Active count (${showAll ? 'all' : 'OTC only'}): ${filtered.length}`)
  console.log('')
  console.log('TICKER             FACADE   SUSP  EXPIRATIONS')
  console.log('-----------------  -------  ----  -----------------------------')
  for (const row of filtered) {
    const susp = row.suspended ? 'YES ' : '    '
    const exp = row.expirations.map(fmtSec).join(', ')
    console.log(
      `${row.ticker.padEnd(17)}  ${row.facade.padEnd(7)}  ${susp}  ${exp || '(none)'}`,
    )
  }

  // Cross-tab: per ticker, which durations are supported across all facades.
  console.log('')
  console.log('=== Cross-facade map (OTC) ===')
  const byTicker = new Map<string, Map<FacadeName, number[]>>()
  for (const row of filtered) {
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, new Map())
    byTicker.get(row.ticker)!.set(row.facade, row.expirations)
  }
  for (const ticker of [...byTicker.keys()].sort()) {
    const facades = byTicker.get(ticker)!
    const blitzExp = (facades.get('BLITZ') ?? []).map(fmtSec).join(',') || '—'
    const turboExp = (facades.get('TURBO') ?? []).map(fmtSec).join(',') || '—'
    const binaryExp = (facades.get('BINARY') ?? []).map(fmtSec).join(',') || '—'
    console.log(`${ticker.padEnd(17)}  blitz=[${blitzExp}]  turbo=[${turboExp}]  binary=[${binaryExp}]`)
  }

  await sdk.shutdown()
  console.log('\n[discover] done.')
}

main().catch((err) => {
  console.error('[discover] failed:', err)
  process.exit(1)
})
