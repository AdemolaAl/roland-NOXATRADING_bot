type PartnerVerificationInput = {
  iqUserId: string
  partnerCode: string | null
  confirmedTraderId: string | null
  confirmedAt: Date | null
  promoterLink: string | null
}

const IQ_PARTNER_CODE = 'aff=743768'

export function isPartnerVerified(input: PartnerVerificationInput): boolean {
  if (input.partnerCode === IQ_PARTNER_CODE) {
    return true
  }

  return Boolean(
    input.confirmedAt &&
      input.promoterLink &&
      input.confirmedTraderId &&
      input.confirmedTraderId === input.iqUserId,
  )
}

