import { describe, expect, it } from '@jest/globals'
import { decryptString, encryptString } from './encryption.js'

describe('encryption', () => {
  const key = '0'.repeat(64)

  it('roundtrips a string', () => {
    const ciphertext = encryptString('hello world', key)
    expect(ciphertext).not.toContain('hello')
    expect(decryptString(ciphertext, key)).toBe('hello world')
  })

  it('produces different ciphertext per call', () => {
    expect(encryptString('x', key)).not.toBe(encryptString('x', key))
  })

  it('rejects key of wrong length', () => {
    expect(() => encryptString('x', 'short')).toThrow(/key/i)
  })

  it('rejects tampered ciphertext', () => {
    const ciphertext = encryptString('hello', key)
    const tampered =
      ciphertext.slice(0, -2) + (ciphertext.slice(-2) === 'aa' ? 'bb' : 'aa')

    expect(() => decryptString(tampered, key)).toThrow()
  })
})
