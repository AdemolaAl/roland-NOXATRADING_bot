import { describe, expect, it } from '@jest/globals'
import { buildSignupUrl, isNoxClickId, mintClickId } from './iqSignup.js'

describe('iqSignup', () => {
  describe('mintClickId', () => {
    it('returns a NOX-prefixed 19-char id', () => {
      const id = mintClickId()
      expect(id).toMatch(/^NOX[0-9A-F]{16}$/)
    })
    it('returns a fresh id every call', () => {
      const a = mintClickId()
      const b = mintClickId()
      expect(a).not.toBe(b)
    })
  })

  describe('isNoxClickId', () => {
    it('recognises minted ids', () => {
      expect(isNoxClickId(mintClickId())).toBe(true)
    })
    it('rejects other prefixes', () => {
      expect(isNoxClickId('VTR123456789ABCDEF0')).toBe(false)
      expect(isNoxClickId('random')).toBe(false)
      expect(isNoxClickId('')).toBe(false)
      expect(isNoxClickId(null as unknown as string)).toBe(false)
    })
    it('rejects ids with non-hex characters', () => {
      expect(isNoxClickId('NOX????????????????')).toBe(false)
      expect(isNoxClickId('NOXabcdef1234567890')).toBe(false) // lowercase rejected
    })
  })

  describe('buildSignupUrl', () => {
    it('embeds aff=743768, afftrack=RolandxNOXA, and clickid', () => {
      const url = buildSignupUrl('NOXABCDEF1234567890')
      expect(url).toContain('https://iqbroker.com/lp/regframe-01-light-nosocials/en/?')
      expect(url).toContain('aff=743768')
      expect(url).toContain('afftrack=RolandxNOXA')
      expect(url).toContain('aff_model=revenue')
      expect(url).toContain('clickid=NOXABCDEF1234567890')
    })
    it('throws on malformed clickId', () => {
      expect(() => buildSignupUrl('')).toThrow(/invalid clickId/)
      expect(() => buildSignupUrl('NOTNOX')).toThrow(/invalid clickId/)
    })
  })
})
