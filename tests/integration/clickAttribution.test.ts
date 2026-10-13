import { beforeEach, describe, expect, it } from '@jest/globals'
import { resetDb, testPool } from '../fixtures/testDb.js'
import { ClickAttributionRepository } from '../../src/core/repositories/clickAttributionRepo.js'
import { UserRepository } from '../../src/core/repositories/userRepo.js'
import { IqPostbackRepository } from '../../src/core/repositories/iqPostbackRepo.js'

describe('ClickAttributionRepository', () => {
  let repo: ClickAttributionRepository
  let users: UserRepository

  beforeEach(async () => {
    await resetDb()
    repo = new ClickAttributionRepository(testPool)
    users = new UserRepository(testPool)
    await users.createIfMissing(42n, 'alice')
  })

  it('inserts and finds back by clickId', async () => {
    await repo.insert({ clickId: 'NOX0000000000000001', telegramId: 42n, tierIntent: 'auto' })
    const row = await repo.findByClickId('NOX0000000000000001')
    expect(row).not.toBeNull()
    expect(row!.telegram_id).toBe('42')
    expect(row!.tier_intent).toBe('auto')
    expect(row!.matched_at).toBeNull()
  })

  it('returns null for unknown clickId', async () => {
    const row = await repo.findByClickId('NOXNOTHING000000000')
    expect(row).toBeNull()
  })

  it('markMatched returns true exactly once', async () => {
    await repo.insert({ clickId: 'NOX0000000000000002', telegramId: 42n, tierIntent: 'pro' })

    const first = await repo.markMatched({ clickId: 'NOX0000000000000002', traderId: 'TRADER-1', via: 's2s' })
    const second = await repo.markMatched({ clickId: 'NOX0000000000000002', traderId: 'TRADER-2', via: 's2s' })

    expect(first).toBe(true)
    expect(second).toBe(false)

    const row = await repo.findByClickId('NOX0000000000000002')
    expect(row!.matched_trader_id).toBe('TRADER-1')
    expect(row!.matched_via).toBe('s2s')
    expect(row!.matched_at).not.toBeNull()
  })

  it('markMatched returns false for unknown clickId', async () => {
    const result = await repo.markMatched({ clickId: 'NOXNOTHING000000000', traderId: 'X', via: 's2s' })
    expect(result).toBe(false)
  })

  it('markMatched is safe under concurrent calls', async () => {
    await repo.insert({ clickId: 'NOX0000000000000003', telegramId: 42n, tierIntent: 'auto' })
    const [a, b] = await Promise.all([
      repo.markMatched({ clickId: 'NOX0000000000000003', traderId: 'T1', via: 's2s' }),
      repo.markMatched({ clickId: 'NOX0000000000000003', traderId: 'T2', via: 's2s' }),
    ])
    // Exactly one caller wins, the other sees rowCount=0 → false.
    expect(a !== b).toBe(true)
    const row = await repo.findByClickId('NOX0000000000000003')
    expect(row!.matched_at).not.toBeNull()
    // Whichever caller won, the row reflects their traderId.
    expect(['T1', 'T2']).toContain(row!.matched_trader_id)
  })
})

describe('UserRepository.markIqAccountConfirmed', () => {
  let users: UserRepository

  beforeEach(async () => {
    await resetDb()
    users = new UserRepository(testPool)
    await users.createIfMissing(7n, 'bob')
  })

  it('sets all three columns on first call and returns true', async () => {
    const ok = await users.markIqAccountConfirmed(7n, 'TRADER-7', 'NOXCLICK1234567890')
    expect(ok).toBe(true)
    const row = await users.findById(7n)
    expect(row!.iq_trader_id).toBe('TRADER-7')
    expect(row!.iq_account_confirmed_at).not.toBeNull()
    expect(row!.iq_promoter_link).toBe('NOXCLICK1234567890')
  })

  it('returns false on second call and does not overwrite', async () => {
    await users.markIqAccountConfirmed(7n, 'TRADER-7', 'CLICK-A')
    const second = await users.markIqAccountConfirmed(7n, 'TRADER-OTHER', 'CLICK-B')
    expect(second).toBe(false)
    const row = await users.findById(7n)
    expect(row!.iq_trader_id).toBe('TRADER-7')
    expect(row!.iq_promoter_link).toBe('CLICK-A')
  })
})

describe('IqPostbackRepository S2S helpers', () => {
  let postbacks: IqPostbackRepository

  beforeEach(async () => {
    await resetDb()
    await testPool.query('TRUNCATE iq_postbacks, click_attributions RESTART IDENTITY CASCADE')
    postbacks = new IqPostbackRepository(testPool)
  })

  it('insertS2S persists with clickid + source + idempotency key', async () => {
    await postbacks.insertS2S({
      traderId: 'T1',
      eventType: 'registration',
      rawEvent: 'registration',
      amount: null,
      countryCode: 'NG',
      afftrack: 'RolandxNOXA',
      clickid: 'NOX0000000000000010',
      rawText: '?clickid=NOX0000000000000010&trader_id=T1',
      idempotencyKey: 'event-1',
    })
    const profile = await postbacks.lookupByTraderId('T1')
    expect(profile.inFunnel).toBe(true)
    expect(profile.afftracks).toContain('RolandxNOXA')
  })

  it('insertS2S deduplicates on repeat idempotency_key', async () => {
    const input = {
      traderId: 'T2',
      eventType: 'ftd',
      rawEvent: 'ftd',
      amount: 50,
      countryCode: 'NG',
      afftrack: 'RolandxNOXA',
      clickid: null,
      rawText: 'dup',
      idempotencyKey: 'event-dup',
    }
    await postbacks.insertS2S(input)
    await postbacks.insertS2S(input)
    const profile = await postbacks.lookupByTraderId('T2')
    expect(profile.depositCount).toBe(1)
    expect(profile.depositTotal).toBe(50)
  })

  it('hasFtdForTrader is false initially and true after first FTD', async () => {
    expect(await postbacks.hasFtdForTrader('T3')).toBe(false)
    await postbacks.insertS2S({
      traderId: 'T3',
      eventType: 'ftd',
      rawEvent: 'ftd',
      amount: 100,
      countryCode: null,
      afftrack: 'RolandxNOXA',
      clickid: null,
      rawText: 'first',
      idempotencyKey: 'event-T3-1',
    })
    expect(await postbacks.hasFtdForTrader('T3')).toBe(true)
  })
})
