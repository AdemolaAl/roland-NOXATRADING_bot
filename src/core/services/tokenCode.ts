import { randomBytes } from 'node:crypto'

export type Tier = 'auto' | 'pro'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LEN = 6
const FORMAT = /^NXT-(AUTO|PRO)-[A-Z0-9]{6}$/

export function generateTokenCode(tier: Tier): string {
  const bytes = randomBytes(CODE_LEN)
  let code = ''

  for (let index = 0; index < CODE_LEN; index += 1) {
    code += ALPHABET[bytes[index]! % ALPHABET.length]
  }

  return `NXT-${tier.toUpperCase()}-${code}`
}

export function parseTokenCode(code: string): { tier: Tier } | null {
  const match = FORMAT.exec(code)

  if (!match) {
    return null
  }

  return {
    tier: match[1]!.toLowerCase() as Tier,
  }
}

export function isValidTokenFormat(code: string): boolean {
  return FORMAT.test(code)
}
