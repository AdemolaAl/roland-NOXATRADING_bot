import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

function keyBuffer(hexKey: string): Buffer {
  if (hexKey.length !== 64) {
    throw new Error('Encryption key must be 32 bytes hex (64 chars)')
  }

  return Buffer.from(hexKey, 'hex')
}

export function encryptString(plaintext: string, hexKey: string): string {
  const key = keyBuffer(hexKey)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

export function decryptString(ciphertext: string, hexKey: string): string {
  const key = keyBuffer(hexKey)
  const buffer = Buffer.from(ciphertext, 'base64')
  const iv = buffer.subarray(0, IV_LEN)
  const tag = buffer.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const encrypted = buffer.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALGO, key, iv)

  decipher.setAuthTag(tag)

  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return plaintext.toString('utf8')
}
