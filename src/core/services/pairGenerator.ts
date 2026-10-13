export type Pair = { code: string; flag: string; label: string }
export type PairWithRate = Pair & { winRate: number }

// Tickers must match the broker's Blitz facade exactly (verified via
// scripts/discover-iq-options.ts). Notably:
// - BTC/USD on Blitz is exposed as `BTCUSD-OTC-op`, not `BTCUSD-OTC`.
// - USDARS-OTC is NOT available on Blitz, so it's not in the pool. EURGBP-OTC
//   takes its slot — popular OTC cross, always present on Blitz.
export const PAIR_POOL: readonly Pair[] = [
  { code: 'EURUSD-OTC', flag: 'EU', label: 'EUR/USD OTC' },
  { code: 'GBPUSD-OTC', flag: 'GB', label: 'GBP/USD OTC' },
  { code: 'USDBRL-OTC', flag: 'BR', label: 'USD/BRL OTC' },
  { code: 'EURGBP-OTC', flag: 'EUGB', label: 'EUR/GBP OTC' },
  { code: 'AUDUSD-OTC', flag: 'AU', label: 'AUD/USD OTC' },
  { code: 'BTCUSD-OTC-op', flag: 'BTC', label: 'BTC/USD OTC' },
  { code: 'USDJPY-OTC', flag: 'JP', label: 'USD/JPY OTC' },
  { code: 'USDCAD-OTC', flag: 'CA', label: 'USD/CAD OTC' },
  { code: 'NZDUSD-OTC', flag: 'NZ', label: 'NZD/USD OTC' },
] as const

export function generatePairSelection(count = 4): PairWithRate[] {
  const shuffled = [...PAIR_POOL].sort(() => Math.random() - 0.5)
  const picked = shuffled.slice(0, count)
  const withRates = picked.map((pair) => ({
    ...pair,
    winRate: 60 + Math.floor(Math.random() * 31),
  }))

  withRates.sort((a, b) => b.winRate - a.winRate)
  return withRates
}
