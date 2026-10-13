import { describe, expect, it } from '@jest/globals'
import { testPool, resetDb } from '../fixtures/testDb.js'
import { TokenRequestRepository } from '../../src/core/repositories/tokenRequestRepo.js'
import { TokenRepository } from '../../src/core/repositories/tokenRepo.js'
import { UserRepository } from '../../src/core/repositories/userRepo.js'
import { generateTokenCode } from '../../src/core/services/tokenCode.js'

describe('token request lifecycle', () => {
  it('submits, approves, redeems, and upgrades tier state', async () => {
    await resetDb()
    const users = new UserRepository(testPool)
    const requests = new TokenRequestRepository(testPool)
    const tokens = new TokenRepository(testPool)
    await users.createIfMissing(123n, 'alice')

    const request = await requests.create({
      userTelegramId: 123n,
      requestedTier: 'auto',
      iqUserId: 'iq-1',
      reason: 'ready',
    })

    const token = await tokens.create({
      code: generateTokenCode('auto'),
      tier: 'auto',
      boundIqUserId: 'iq-1',
      issuedByAdminId: 1n,
    })

    await requests.approve(request.id, 1n, token.id)
    await tokens.markRedeemed(token.id, 123n)
    await users.setTier(123n, 'auto')

    expect((await requests.findById(request.id))!.status).toBe('approved')
    expect((await tokens.findByCode(token.code))!.issued_to_telegram_id).toBe('123')
    expect((await users.findById(123n))!.tier).toBe('auto')
  })
})
