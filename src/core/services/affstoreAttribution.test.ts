import { describe, expect, it, jest, beforeEach } from '@jest/globals'

const findByClickId = jest.fn<(clickId: string) => Promise<unknown>>()
const markMatched = jest.fn<(input: { clickId: string; traderId: string; via: string }) => Promise<boolean>>()
const markIqAccountConfirmed = jest.fn<(t: bigint, trader: string, link: string | null) => Promise<boolean>>()

jest.unstable_mockModule('../repositories/index.js', () => ({
  clickAttributionRepo: { findByClickId, markMatched },
  userRepo: { markIqAccountConfirmed },
}))

const { attributePostback } = await import('./affstoreAttribution.js')

describe('attributePostback', () => {
  beforeEach(() => {
    findByClickId.mockReset()
    markMatched.mockReset()
    markIqAccountConfirmed.mockReset()
  })

  it('skips non-NOX clickids', async () => {
    const r = await attributePostback({ clickId: 'VTRDEADBEEFDEADBEEF', traderId: 'T', eventType: 'registration' }, 's2s')
    expect(r).toEqual({ matched: false, reason: 'not_nox_click' })
    expect(findByClickId).not.toHaveBeenCalled()
  })

  it('skips non-registration events', async () => {
    const r = await attributePostback({ clickId: 'NOX0000000000000001', traderId: 'T', eventType: 'ftd' }, 's2s')
    expect(r).toEqual({ matched: false, reason: 'wrong_event_type' })
    expect(findByClickId).not.toHaveBeenCalled()
  })

  it('returns unknown_click_id when row missing', async () => {
    findByClickId.mockResolvedValue(null)
    const r = await attributePostback({ clickId: 'NOX0000000000000002', traderId: 'T', eventType: 'registration' }, 's2s')
    expect(r).toEqual({ matched: false, reason: 'unknown_click_id' })
  })

  it('returns already_matched when markMatched loses the race', async () => {
    findByClickId.mockResolvedValue({ click_id: 'NOX0000000000000003', telegram_id: '42', tier_intent: 'auto' })
    markMatched.mockResolvedValue(false)
    const r = await attributePostback({ clickId: 'NOX0000000000000003', traderId: 'T', eventType: 'registration' }, 's2s')
    expect(r).toEqual({ matched: false, reason: 'already_matched' })
    expect(markIqAccountConfirmed).not.toHaveBeenCalled()
  })

  it('returns user_already_confirmed when markIqAccountConfirmed returns false', async () => {
    findByClickId.mockResolvedValue({ click_id: 'NOX0000000000000004', telegram_id: '42', tier_intent: 'pro' })
    markMatched.mockResolvedValue(true)
    markIqAccountConfirmed.mockResolvedValue(false)
    const r = await attributePostback({ clickId: 'NOX0000000000000004', traderId: 'T', eventType: 'registration' }, 's2s')
    expect(r).toEqual({ matched: false, telegramId: 42n, reason: 'user_already_confirmed' })
  })

  it('returns matched on the happy path', async () => {
    findByClickId.mockResolvedValue({ click_id: 'NOX0000000000000005', telegram_id: '42', tier_intent: 'auto' })
    markMatched.mockResolvedValue(true)
    markIqAccountConfirmed.mockResolvedValue(true)
    const r = await attributePostback({ clickId: 'NOX0000000000000005', traderId: 'T', eventType: 'registration' }, 's2s')
    expect(r).toEqual({ matched: true, telegramId: 42n, tierIntent: 'auto' })
    expect(markMatched).toHaveBeenCalledWith({ clickId: 'NOX0000000000000005', traderId: 'T', via: 's2s' })
    expect(markIqAccountConfirmed).toHaveBeenCalledWith(42n, 'T', 'NOX0000000000000005')
  })

  it('coerces unexpected tier_intent values to unknown', async () => {
    findByClickId.mockResolvedValue({ click_id: 'NOX0000000000000006', telegram_id: '42', tier_intent: 'vip' })
    markMatched.mockResolvedValue(true)
    markIqAccountConfirmed.mockResolvedValue(true)
    const r = await attributePostback({ clickId: 'NOX0000000000000006', traderId: 'T', eventType: 'registration' }, 's2s')
    expect(r).toEqual({ matched: true, telegramId: 42n, tierIntent: 'unknown' })
  })

  it('coerces explicit "unknown" tier_intent to unknown', async () => {
    findByClickId.mockResolvedValue({ click_id: 'NOX0000000000000007', telegram_id: '42', tier_intent: 'unknown' })
    markMatched.mockResolvedValue(true)
    markIqAccountConfirmed.mockResolvedValue(true)
    const r = await attributePostback({ clickId: 'NOX0000000000000007', traderId: 'T', eventType: 'registration' }, 's2s')
    expect(r).toEqual({ matched: true, telegramId: 42n, tierIntent: 'unknown' })
  })
})
