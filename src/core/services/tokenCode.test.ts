import { describe, expect, it } from '@jest/globals'
import { generateTokenCode, isValidTokenFormat, parseTokenCode } from './tokenCode.js'

describe('tokenCode', () => {
  it('generates AUTO token format', () => {
    expect(generateTokenCode('auto')).toMatch(/^NXT-AUTO-[A-Z0-9]{6}$/)
  })

  it('generates PRO token format', () => {
    expect(generateTokenCode('pro')).toMatch(/^NXT-PRO-[A-Z0-9]{6}$/)
  })

  it('parseTokenCode returns tier for valid codes', () => {
    expect(parseTokenCode('NXT-AUTO-X9K2QM')).toEqual({ tier: 'auto' })
    expect(parseTokenCode('NXT-PRO-ABCD12')).toEqual({ tier: 'pro' })
  })

  it('parseTokenCode returns null for malformed', () => {
    expect(parseTokenCode('xyz')).toBeNull()
    expect(parseTokenCode('NXT-MID-ABCDEF')).toBeNull()
  })

  it('isValidTokenFormat works', () => {
    expect(isValidTokenFormat('NXT-AUTO-X9K2QM')).toBe(true)
    expect(isValidTokenFormat('blah')).toBe(false)
  })
})
