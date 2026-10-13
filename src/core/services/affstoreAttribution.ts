import { clickAttributionRepo, userRepo } from '../repositories/index.js'
import { isNoxClickId } from './iqSignup.js'

export type AttributionInput = {
  clickId: string
  traderId: string
  eventType: string
}

export type AttributionResult =
  | { matched: true; telegramId: bigint; tierIntent: 'auto' | 'pro' | 'unknown' }
  | {
      matched: false
      telegramId?: bigint
      reason:
        | 'not_nox_click'
        | 'wrong_event_type'
        | 'unknown_click_id'
        | 'already_matched'
        | 'user_already_confirmed'
    }

// Postback → telegram_id matching. Called from the affstore webhook
// handler on every postback receipt. Short-circuits cheaply for
// postbacks that aren't ours (sibling promoters) or aren't registrations
// (FTD/redeposit attribute via trader_id later, not clickid).
export async function attributePostback(
  input: AttributionInput,
  source: 's2s' | 'manual' | 'channel',
): Promise<AttributionResult> {
  if (!isNoxClickId(input.clickId)) {
    return { matched: false, reason: 'not_nox_click' }
  }
  if (input.eventType !== 'registration') {
    return { matched: false, reason: 'wrong_event_type' }
  }

  const row = await clickAttributionRepo.findByClickId(input.clickId)
  if (!row) {
    return { matched: false, reason: 'unknown_click_id' }
  }

  const wonRace = await clickAttributionRepo.markMatched({
    clickId: input.clickId,
    traderId: input.traderId,
    via: source,
  })
  if (!wonRace) {
    return { matched: false, reason: 'already_matched' }
  }

  const telegramId = BigInt(row.telegram_id)
  const firstConfirm = await userRepo.markIqAccountConfirmed(
    telegramId,
    input.traderId,
    input.clickId,
  )
  if (!firstConfirm) {
    return { matched: false, telegramId, reason: 'user_already_confirmed' }
  }

  const tierIntent =
    row.tier_intent === 'auto' || row.tier_intent === 'pro' ? row.tier_intent : 'unknown'
  return { matched: true, telegramId, tierIntent }
}
