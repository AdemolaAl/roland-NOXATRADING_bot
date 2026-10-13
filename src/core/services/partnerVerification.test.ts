import { describe, expect, it } from '@jest/globals'
import { isPartnerVerified } from './partnerVerification.js'

describe('isPartnerVerified', () => {
  it('accepts the explicit IQ partner code', () => {
    expect(
      isPartnerVerified({
        iqUserId: '192348237',
        partnerCode: 'aff=743768',
        confirmedTraderId: null,
        confirmedAt: null,
        promoterLink: null,
      }),
    ).toBe(true)
  })

  it('accepts a confirmed Affstore trader for the same IQ account', () => {
    expect(
      isPartnerVerified({
        iqUserId: '192348237',
        partnerCode: null,
        confirmedTraderId: '192348237',
        confirmedAt: new Date('2026-05-14T00:57:06.147Z'),
        promoterLink: 'NOXA193ED1306A7E160A',
      }),
    ).toBe(true)
  })

  it('rejects a confirmed Affstore trader for a different IQ account', () => {
    expect(
      isPartnerVerified({
        iqUserId: '999999999',
        partnerCode: null,
        confirmedTraderId: '192348237',
        confirmedAt: new Date('2026-05-14T00:57:06.147Z'),
        promoterLink: 'NOXA193ED1306A7E160A',
      }),
    ).toBe(false)
  })

  it('rejects when there is no usable partner evidence', () => {
    expect(
      isPartnerVerified({
        iqUserId: '192348237',
        partnerCode: null,
        confirmedTraderId: '192348237',
        confirmedAt: null,
        promoterLink: null,
      }),
    ).toBe(false)
  })
})

