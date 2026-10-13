import { describe, expect, it } from '@jest/globals'
import { testPool, resetDb } from '../fixtures/testDb.js'
import { TradeRepository } from '../../src/core/repositories/tradeRepo.js'
import { UserRepository } from '../../src/core/repositories/userRepo.js'

describe('crash recovery persistence shape', () => {
  it('persists pending gale steps with iq trade ids for recovery', async () => {
    await resetDb()
    const users = new UserRepository(testPool)
    const trades = new TradeRepository(testPool)
    await users.createIfMissing(123n, 'alice')
    const tradeId = await trades.create({
      userTelegramId: 123n,
      tradeNum: 1,
      pairCode: 'EURUSD-OTC',
      pairFlag: 'EU',
      direction: 'call',
      timeframe: '1m',
      accountMode: 'demo',
      baseStake: 20,
    })
    await trades.appendStep(tradeId, {
      step: 1,
      stake: 20,
      iq_trade_id: 'broker-123',
    })
    const trade = await trades.findById(tradeId)
    expect(trade!.gale_steps[0]).toEqual({ step: 1, stake: 20, iq_trade_id: 'broker-123' })
  })
})
