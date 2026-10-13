import { afterAll, beforeEach, describe, expect, it } from '@jest/globals'
import { testPool, resetDb } from '../../../tests/fixtures/testDb.js'
import { TradeRepository } from './tradeRepo.js'
import { UserRepository } from './userRepo.js'

describe('TradeRepository', () => {
  const users = new UserRepository(testPool)
  const repo = new TradeRepository(testPool)

  beforeEach(async () => {
    await resetDb()
    await users.createIfMissing(123n, 'alice')
    await users.createIfMissing(456n, 'bob')
  })

  afterAll(async () => {
    await testPool.end()
  })

  it('create inserts and findById loads trade', async () => {
    const id = await repo.create({
      userTelegramId: 123n,
      tradeNum: 1,
      pairCode: 'EURUSD-OTC',
      pairFlag: 'EU',
      direction: 'call',
      timeframe: '1m',
      accountMode: 'demo',
      baseStake: 20,
    })
    const trade = await repo.findById(id)
    expect(trade!.pair_code).toBe('EURUSD-OTC')
  })

  it('appendStep stores gale steps', async () => {
    const id = await repo.create({
      userTelegramId: 123n,
      tradeNum: 1,
      pairCode: 'EURUSD-OTC',
      pairFlag: 'EU',
      direction: 'call',
      timeframe: '1m',
      accountMode: 'demo',
      baseStake: 20,
    })
    await repo.appendStep(id, { step: 1, stake: 20 })
    const trade = await repo.findById(id)
    expect(trade!.gale_steps).toEqual([{ step: 1, stake: 20 }])
  })

  it('complete marks outcome and ended_at', async () => {
    const id = await repo.create({
      userTelegramId: 123n,
      tradeNum: 1,
      pairCode: 'EURUSD-OTC',
      pairFlag: 'EU',
      direction: 'call',
      timeframe: '1m',
      accountMode: 'demo',
      baseStake: 20,
    })
    await repo.complete(id, 'win', 1, 18.4)
    const trade = await repo.findById(id)
    expect(trade!.final_outcome).toBe('win')
    expect(trade!.ended_at).not.toBeNull()
  })

  it('findRecentByUser returns most recent trades first with limit', async () => {
    for (let tradeNum = 1; tradeNum <= 3; tradeNum += 1) {
      await repo.create({
        userTelegramId: 123n,
        tradeNum,
        pairCode: `PAIR-${tradeNum}`,
        pairFlag: 'EU',
        direction: 'call',
        timeframe: '1m',
        accountMode: 'demo',
        baseStake: 20,
      })
    }
    const recent = await repo.findRecentByUser(123n, 2)
    expect(recent).toHaveLength(2)
  })

  it('findInFlightByUser returns only trades without ended_at', async () => {
    const activeId = await repo.create({
      userTelegramId: 123n,
      tradeNum: 1,
      pairCode: 'EURUSD-OTC',
      pairFlag: 'EU',
      direction: 'call',
      timeframe: '1m',
      accountMode: 'demo',
      baseStake: 20,
    })
    const closedId = await repo.create({
      userTelegramId: 123n,
      tradeNum: 2,
      pairCode: 'GBPUSD-OTC',
      pairFlag: 'GB',
      direction: 'put',
      timeframe: '1m',
      accountMode: 'demo',
      baseStake: 20,
    })
    await repo.complete(closedId, 'loss', null, -20)
    const active = await repo.findInFlightByUser(123n)
    expect(active.map((trade) => trade.id)).toEqual([activeId])
  })

  it('findProSession returns grouped trades', async () => {
    const sessionId = '11111111-1111-1111-1111-111111111111'
    await repo.create({
      userTelegramId: 123n,
      tradeNum: 1,
      pairCode: 'EURUSD-OTC',
      pairFlag: 'EU',
      direction: 'call',
      timeframe: '1m',
      accountMode: 'live',
      baseStake: 50,
      proSessionId: sessionId,
    })
    await repo.create({
      userTelegramId: 123n,
      tradeNum: 2,
      pairCode: 'GBPUSD-OTC',
      pairFlag: 'GB',
      direction: 'put',
      timeframe: '1m',
      accountMode: 'live',
      baseStake: 50,
      proSessionId: sessionId,
    })
    const trades = await repo.findProSession(sessionId)
    expect(trades).toHaveLength(2)
  })

  it('topByVolumeLast30d orders by base stake volume', async () => {
    await repo.create({
      userTelegramId: 123n,
      tradeNum: 1,
      pairCode: 'EURUSD-OTC',
      pairFlag: 'EU',
      direction: 'call',
      timeframe: '1m',
      accountMode: 'live',
      baseStake: 100,
    })
    await repo.create({
      userTelegramId: 456n,
      tradeNum: 1,
      pairCode: 'GBPUSD-OTC',
      pairFlag: 'GB',
      direction: 'put',
      timeframe: '1m',
      accountMode: 'live',
      baseStake: 50,
    })
    const leaders = await repo.topByVolumeLast30d(5)
    expect(leaders[0]!.user_telegram_id).toBe('123')
  })

  it('aggregatesForUser returns counts, total staked, and pnl', async () => {
    const first = await repo.create({
      userTelegramId: 123n,
      tradeNum: 1,
      pairCode: 'EURUSD-OTC',
      pairFlag: 'EU',
      direction: 'call',
      timeframe: '1m',
      accountMode: 'live',
      baseStake: 20,
    })
    await repo.appendStep(first, { step: 1, stake: 20 })
    const second = await repo.create({
      userTelegramId: 123n,
      tradeNum: 2,
      pairCode: 'GBPUSD-OTC',
      pairFlag: 'GB',
      direction: 'put',
      timeframe: '1m',
      accountMode: 'live',
      baseStake: 30,
    })
    await repo.appendStep(second, { step: 1, stake: 30 })
    await repo.appendStep(second, { step: 2, stake: 69 })
    await repo.complete(first, 'win', 1, 18.4)
    await repo.complete(second, 'loss', null, -30)
    const stats = await repo.aggregatesForUser(123n)
    expect(stats.total_trades).toBe(2)
    expect(stats.total_staked).toBe('119.00')
    expect(stats.net_pnl).toBe('-11.60')
  })
})
