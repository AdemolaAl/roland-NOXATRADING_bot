import type { Tier } from './tokenCode.js'

export type FullTier = Tier | 'demo'

export const MIN_BALANCE_AUTO = 50
export const MIN_BALANCE_PRO = 500

const RANK: Record<FullTier, number> = {
  demo: 0,
  auto: 1,
  pro: 2,
}

export function requiredBalanceFor(tier: FullTier): number {
  if (tier === 'pro') {
    return MIN_BALANCE_PRO
  }

  if (tier === 'auto') {
    return MIN_BALANCE_AUTO
  }

  return 0
}

export function canUpgradeTo(current: FullTier, target: FullTier, balance: number): boolean {
  if (RANK[target] <= RANK[current]) {
    return false
  }

  return balance >= requiredBalanceFor(target)
}

export function downgradeAfterRevoke(current: FullTier, revokedTier: Tier): FullTier {
  if (revokedTier === 'auto') {
    return 'demo'
  }

  if (revokedTier === 'pro') {
    return current === 'pro' ? 'auto' : current
  }

  return current
}
