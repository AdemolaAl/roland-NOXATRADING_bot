import { describe, expect, it } from '@jest/globals'
import { createLogger, redactedFields, withCorrelation } from './logger.js'

describe('logger', () => {
  it('exposes Pino-compatible logger', () => {
    const log = createLogger()
    expect(typeof log.info).toBe('function')
  })

  it('redacts sensitive fields', () => {
    expect(redactedFields).toContain('iq_password')
    expect(redactedFields).toContain('iq_session_token')
    expect(redactedFields).toContain('password')
    expect(redactedFields).toContain('authorization')
  })

  it('withCorrelation binds correlationId to child', () => {
    const log = createLogger()
    const child = withCorrelation(log, 'abc123')
    expect(child.bindings().correlationId).toBe('abc123')
  })
})
