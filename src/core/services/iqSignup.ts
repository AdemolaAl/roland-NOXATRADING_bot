import { randomBytes } from 'node:crypto'

// Click-id format: 'NOX' + 16 uppercase hex chars (8 random bytes).
// 'NOX' prefix disambiguates from sibling Uplivon promoters that share
// the same Affstore postback fan-out (vetra uses 'VTR'). The
// affstoreAttribution service uses isNoxClickId() to short-circuit on
// other promoters' postbacks before doing a DB lookup.
const CLICK_ID_PREFIX = 'NOX'
const CLICK_ID_HEX_LEN = 16

export function mintClickId(): string {
  const random = randomBytes(CLICK_ID_HEX_LEN / 2).toString('hex').toUpperCase()
  return `${CLICK_ID_PREFIX}${random}`
}

const CLICK_ID_RE = /^NOX[0-9A-F]{16}$/

export function isNoxClickId(value: unknown): boolean {
  return typeof value === 'string' && CLICK_ID_RE.test(value)
}

// Roland's afftrack — Affstore sub-promoter label. Postbacks our bot
// auto-approves carry this value in the 'afftrack' field. Sibling
// Uplivon-family promoters carry 'policee', 'VetraXpolycarp', etc.
export const ROLAND_AFFTRACK = 'RolandxNOXA'

// IQ Option signup URL builder. The aff=743768 partner id and the
// afftrack are fixed for Roland; only clickid changes per render.
export function buildSignupUrl(clickId: string): string {
  if (!isNoxClickId(clickId)) {
    throw new Error(`buildSignupUrl: invalid clickId ${JSON.stringify(clickId)}`)
  }
  const params = new URLSearchParams({
    aff: '743768',
    aff_model: 'revenue',
    afftrack: ROLAND_AFFTRACK,
    clickid: clickId,
  })
  return `https://iqbroker.com/lp/regframe-01-light-nosocials/en/?${params.toString()}`
}
