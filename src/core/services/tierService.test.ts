import { describe, expect, it } from '@jest/globals'
import {
  canUpgradeTo,
  downgradeAfterRevoke,
  MIN_BALANCE_AUTO,
  MIN_BALANCE_PRO,
  requiredBalanceFor,
} from './tierService.js'

describe('tierService', () => {
  it('exposes constants', () => {
    expect(MIN_BALANCE_AUTO).toBe(50)
    expect(MIN_BALANCE_PRO).toBe(500)
  })

  it('demo → auto requires $50', () => {
    expect(canUpgradeTo('demo', 'auto', 49)).toBe(false)
    expect(canUpgradeTo('demo', 'auto', 50)).toBe(true)
  })

  it('any → pro requires $500', () => {
    expect(canUpgradeTo('demo', 'pro', 499)).toBe(false)
    expect(canUpgradeTo('demo', 'pro', 500)).toBe(true)
    expect(canUpgradeTo('auto', 'pro', 500)).toBe(true)
  })

  it('cannot downgrade via canUpgradeTo', () => {
    expect(canUpgradeTo('pro', 'auto', 1000)).toBe(false)
  })

  it('revoking PRO drops PRO user to auto', () => {
    expect(downgradeAfterRevoke('pro', 'pro')).toBe('auto')
  })

  it('revoking AUTO drops AUTO user to demo', () => {
    expect(downgradeAfterRevoke('auto', 'auto')).toBe('demo')
  })

  it('revoking AUTO when user is PRO drops to demo', () => {
    expect(downgradeAfterRevoke('pro', 'auto')).toBe('demo')
  })

  it('requiredBalanceFor returns minimums', () => {
    expect(requiredBalanceFor('demo')).toBe(0)
    expect(requiredBalanceFor('auto')).toBe(50)
    expect(requiredBalanceFor('pro')).toBe(500)
  })
})
