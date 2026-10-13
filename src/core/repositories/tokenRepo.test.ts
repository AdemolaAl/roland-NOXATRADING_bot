import { afterAll, beforeEach, describe, expect, it } from '@jest/globals'
import { testPool, resetDb } from '../../../tests/fixtures/testDb.js'
import { TokenRequestRepository } from './tokenRequestRepo.js'
import { TokenRepository } from './tokenRepo.js'
import { UserRepository } from './userRepo.js'

describe('Token repositories', () => {
  const users = new UserRepository(testPool)
  const tokens = new TokenRepository(testPool)
  const requests = new TokenRequestRepository(testPool)

  beforeEach(async () => {
    await resetDb()
    await users.createIfMissing(123n, 'alice')
  })

  afterAll(async () => {
    await testPool.end()
  })

  it('create and findByCode work', async () => {
    const token = await tokens.create({
      code: 'NXT-AUTO-ABC123',
      tier: 'auto',
      boundIqUserId: 'iq-1',
      issuedByAdminId: 900n,
    })
    const found = await tokens.findByCode(token.code)
    expect(found!.bound_iq_user_id).toBe('iq-1')
  })

  it('markRedeemed persists telegram and timestamp', async () => {
    const token = await tokens.create({
      code: 'NXT-AUTO-ABC123',
      tier: 'auto',
      boundIqUserId: 'iq-1',
      issuedByAdminId: 900n,
    })
    await tokens.markRedeemed(token.id, 123n)
    const found = await tokens.findByCode(token.code)
    expect(found!.issued_to_telegram_id).toBe('123')
    expect(found!.redeemed_at).not.toBeNull()
  })

  it('revoke sets revocation metadata', async () => {
    const token = await tokens.create({
      code: 'NXT-PRO-ABC123',
      tier: 'pro',
      boundIqUserId: 'iq-2',
      issuedByAdminId: 900n,
    })
    await tokens.revoke(token.id, 901n, 'bad actor')
    const found = await tokens.findByCode(token.code)
    expect(found!.revoked_by_admin_id).toBe('901')
    expect(found!.revoke_reason).toBe('bad actor')
  })

  it('listAll returns paginated results', async () => {
    await tokens.create({
      code: 'NXT-AUTO-ONE111',
      tier: 'auto',
      boundIqUserId: 'iq-1',
      issuedByAdminId: 900n,
    })
    await tokens.create({
      code: 'NXT-PRO-TWO222',
      tier: 'pro',
      boundIqUserId: 'iq-2',
      issuedByAdminId: 900n,
    })
    const listed = await tokens.listAll({ limit: 1 })
    expect(listed).toHaveLength(1)
  })

  it('findActiveForIqUser excludes redeemed and revoked tokens', async () => {
    const active = await tokens.create({
      code: 'NXT-AUTO-ACTIVE1',
      tier: 'auto',
      boundIqUserId: 'iq-1',
      issuedByAdminId: 900n,
    })
    const redeemed = await tokens.create({
      code: 'NXT-AUTO-USED111',
      tier: 'auto',
      boundIqUserId: 'iq-1',
      issuedByAdminId: 900n,
    })
    const revoked = await tokens.create({
      code: 'NXT-AUTO-REVOKE',
      tier: 'auto',
      boundIqUserId: 'iq-1',
      issuedByAdminId: 900n,
    })
    await tokens.markRedeemed(redeemed.id, 123n)
    await tokens.revoke(revoked.id, 900n, 'nope')
    const found = await tokens.findActiveForIqUser('iq-1')
    expect(found.map((row) => row.id)).toEqual([active.id])
  })

  it('token requests can create, list, approve, and find', async () => {
    const request = await requests.create({
      userTelegramId: 123n,
      requestedTier: 'auto',
      iqUserId: 'iq-1',
      reason: 'ready',
    })
    const pending = await requests.listPending()
    expect(pending).toHaveLength(1)
    const token = await tokens.create({
      code: 'NXT-AUTO-TOKEN1',
      tier: 'auto',
      boundIqUserId: 'iq-1',
      issuedByAdminId: 900n,
    })
    await requests.approve(request.id, 900n, token.id)
    const found = await requests.findById(request.id)
    expect(found!.status).toBe('approved')
    expect(found!.issued_token_id).toBe(token.id)
  })

  it('token requests can be rejected', async () => {
    const request = await requests.create({
      userTelegramId: 123n,
      requestedTier: 'pro',
    })
    await requests.reject(request.id, 900n, 'insufficient balance')
    const found = await requests.findById(request.id)
    expect(found!.status).toBe('rejected')
    expect(found!.rejection_reason).toBe('insufficient balance')
  })
})
