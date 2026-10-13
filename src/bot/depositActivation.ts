import { verifyLeadForTier } from '../core/services/leadVerification.js'
import { userRepo } from '../core/repositories/index.js'
import { applyEventDetached } from './scenes/_bridge.js'
import { getLogger } from '../infra/logger.js'

type ActivationResult =
  | { kind: 'ignored' }
  | { kind: 'unknown_account' }
  | { kind: 'wrong_affiliate' }
  | { kind: 'below_min'; totalDeposits: number; deficit: number; minRequired: number }
  | { kind: 'confirmed'; nextStage: string; tier: 'auto' | 'pro'; totalDeposits: number }

export async function attemptDepositActivation(telegramId: bigint): Promise<ActivationResult> {
  const user = await userRepo.findById(telegramId)
  if (!user) return { kind: 'ignored' }

  const flow = (user.flow_data ?? {}) as Record<string, unknown>
  const requestedTier = String(flow.requestedTier ?? '')
  if (requestedTier !== 'auto' && requestedTier !== 'pro') {
    return { kind: 'ignored' }
  }

  const traderId = user.iq_trader_id ?? user.iq_user_id
  if (!traderId) {
    return { kind: 'unknown_account' }
  }

  const verification = await verifyLeadForTier(traderId, requestedTier)
  if (verification.kind === 'wrong_affiliate') {
    if ((user.flow_stage || '').toUpperCase() === 'DEPOSIT_GATE') {
      await userRepo.updateFlowStage(telegramId, 'NON_PARTNER_REJECT', flow)
    }
    return { kind: 'wrong_affiliate' }
  }

  if (verification.kind === 'below_min') {
    return {
      kind: 'below_min',
      totalDeposits: verification.totalDeposits,
      deficit: verification.deficit,
      minRequired: verification.minRequired,
    }
  }

  if (verification.kind !== 'verified') {
    return { kind: 'unknown_account' }
  }

  // Deposit confirmations are only allowed to advance the onboarding/upgrade
  // flow while the user is actively waiting in DEPOSIT_GATE.
  if ((user.flow_stage || '').toUpperCase() !== 'DEPOSIT_GATE') {
    return { kind: 'ignored' }
  }

  const nextEvent =
    requestedTier === 'pro'
      ? { type: 'DEPOSIT_CONFIRMED_PRO' as const }
      : { type: 'DEPOSIT_CONFIRMED_AUTO' as const }

  // Achievement flag write before the state-machine transition.
  // verifyLeadForTier has already confirmed an FTD exists for this
  // trader via iq_postbacks; treat that as authoritative for the
  // achievement column. Idempotent at the repo layer.
  const wasFirstSet = await userRepo
    .markFirstDeposit(telegramId, 'manual_confirm')
    .catch(() => false)
  if (wasFirstSet) {
    getLogger().info(
      {
        event: 'first_deposit_recorded',
        source: 'manual_confirm',
        telegramId: telegramId.toString(),
        traderId,
        totalDeposits: verification.totalDeposits,
      },
      'first deposit recorded from manual confirm',
    )
  }

  const result = await applyEventDetached(telegramId, nextEvent, {
    flowDataPatch: {
      desiredAccountMode: 'live',
      depositConfirmedAt: new Date().toISOString(),
      loginAttempts: 0,
    },
  })

  return {
    kind: 'confirmed',
    nextStage: result.nextStage,
    tier: requestedTier,
    totalDeposits: verification.totalDeposits,
  }
}
