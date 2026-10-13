import { iqPostbackRepo } from '../repositories/index.js'
import { MIN_BALANCE_AUTO, MIN_BALANCE_PRO } from './tierService.js'
import type { Tier } from './tokenCode.js'
import { ROLAND_AFFTRACK as NOXATRADING_AFFTRACK } from './iqSignup.js'

// Re-export the canonical afftrack from iqSignup so partner-verification
// and the outgoing signup URL builder always agree. Diverged historically
// (this file used a stale 'roland' string while iqSignup minted URLs with
// 'RolandxNOXA'), causing every brand-new IQ signup to fail the afftrack
// check at DEPOSIT_DONE and land users in NON_PARTNER_REJECT. Postbacks
// carry exactly what the URL sent — there's no transformation in between
// — so anything other than a single shared constant guarantees future
// drift.
export const ROLAND_AFFTRACK = NOXATRADING_AFFTRACK

export type LeadVerification =
  // Signup recorded under our afftrack AND total deposits clear the
  // tier minimum. Caller auto-issues the token.
  | { kind: 'verified'; totalDeposits: number; minRequired: number }
  // Signup recorded under our afftrack BUT not enough deposited yet.
  // Caller replies with a friendly nudge, no admin notification.
  | { kind: 'below_min'; totalDeposits: number; minRequired: number; deficit: number }
  // No record of this trader at all in the funnel — they registered
  // before the bot joined the postback chat, or aren't ours. Caller
  // falls back to the manual admin approval flow.
  | { kind: 'unknown' }
  // Trader is in the funnel but tagged to a different sub-promoter.
  // Caller rejects.
  | { kind: 'wrong_affiliate'; afftracks: string[] }

export async function verifyLeadForTier(
  iqUserId: string,
  tier: Tier,
): Promise<LeadVerification> {
  const profile = await iqPostbackRepo.lookupByTraderId(iqUserId)
  if (!profile.inFunnel) {
    return { kind: 'unknown' }
  }

  const isOurs = profile.afftracks.includes(ROLAND_AFFTRACK)
  if (!isOurs) {
    return { kind: 'wrong_affiliate', afftracks: profile.afftracks }
  }

  const minRequired = tier === 'pro' ? MIN_BALANCE_PRO : MIN_BALANCE_AUTO
  if (profile.depositTotal >= minRequired) {
    return {
      kind: 'verified',
      totalDeposits: profile.depositTotal,
      minRequired,
    }
  }

  return {
    kind: 'below_min',
    totalDeposits: profile.depositTotal,
    minRequired,
    deficit: minRequired - profile.depositTotal,
  }
}
