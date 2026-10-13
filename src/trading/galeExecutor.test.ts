import { describe, expect, it, jest } from '@jest/globals'
import { FakeTradingClient } from './fakeClient.js'
import { executeGale } from './galeExecutor.js'

const fakeMessageHandle = () => ({
  appendLine: jest.fn(async () => {}),
  replaceLastLine: jest.fn(async () => {}),
})

describe('executeGale', () => {
  it('returns win on step 1 if first trade wins', async () => {
    const client = new FakeTradingClient({ outcomes: ['win'] })
    await client.login('a', 'b')
    const result = await executeGale({
      client,
      baseStake: 20,
      pair: 'EURUSD-OTC',
      direction: 'call',
      timeframe: '1m',
      tradeNum: 1,
      accountMode: 'demo',
      message: fakeMessageHandle(),
      systemPaused: async () => false,
      persistStep: jest.fn(async () => {}),
      sleep: async () => {},
    })
    expect(result.outcome).toBe('win')
    if (result.outcome !== 'win') {
      throw new Error('expected win result')
    }
    expect(result.winStep).toBe(1)
    expect(result.netProfit).toBeCloseTo(18.4, 2)
  })

  it('returns win on step 3 after 2 losses', async () => {
    const client = new FakeTradingClient({ outcomes: ['loss', 'loss', 'win'] })
    await client.login('a', 'b')
    const result = await executeGale({
      client,
      baseStake: 20,
      pair: 'X',
      direction: 'call',
      timeframe: '1m',
      tradeNum: 1,
      accountMode: 'demo',
      message: fakeMessageHandle(),
      systemPaused: async () => false,
      persistStep: jest.fn(async () => {}),
      sleep: async () => {},
    })
    expect(result.outcome).toBe('win')
    if (result.outcome !== 'win') {
      throw new Error('expected win result')
    }
    expect(result.winStep).toBe(3)
    expect(result.netProfit).toBeGreaterThan(0)
  })

  it('returns loss after all 6 steps lose', async () => {
    const client = new FakeTradingClient({
      outcomes: ['loss', 'loss', 'loss', 'loss', 'loss', 'loss'],
    })
    await client.login('a', 'b')
    const result = await executeGale({
      client,
      baseStake: 20,
      pair: 'X',
      direction: 'call',
      timeframe: '1m',
      tradeNum: 1,
      accountMode: 'demo',
      message: fakeMessageHandle(),
      systemPaused: async () => false,
      persistStep: jest.fn(async () => {}),
      sleep: async () => {},
    })
    expect(result.outcome).toBe('loss')
    if (result.outcome !== 'loss') {
      throw new Error('expected loss result')
    }
    expect(result.cumulativeLoss).toBeGreaterThan(0)
  })

  it('aborts on system pause', async () => {
    const client = new FakeTradingClient({ outcomes: ['win'] })
    await client.login('a', 'b')
    const result = await executeGale({
      client,
      baseStake: 20,
      pair: 'X',
      direction: 'call',
      timeframe: '1m',
      tradeNum: 1,
      accountMode: 'demo',
      message: fakeMessageHandle(),
      systemPaused: async () => true,
      persistStep: jest.fn(async () => {}),
      sleep: async () => {},
    })
    expect(result.outcome).toBe('aborted')
    if (result.outcome !== 'aborted') {
      throw new Error('expected aborted result')
    }
    expect(result.reason).toBe('system_paused')
  })

  it('aborts on insufficient balance', async () => {
    const client = new FakeTradingClient({
      outcomes: ['loss', 'loss', 'loss'],
      initialBalance: { demo: 50, live: 50 },
    })
    await client.login('a', 'b')
    const result = await executeGale({
      client,
      baseStake: 20,
      pair: 'X',
      direction: 'call',
      timeframe: '1m',
      tradeNum: 1,
      accountMode: 'demo',
      message: fakeMessageHandle(),
      systemPaused: async () => false,
      persistStep: jest.fn(async () => {}),
      sleep: async () => {},
    })
    expect(result.outcome).toBe('aborted')
    if (result.outcome !== 'aborted') {
      throw new Error('expected aborted result')
    }
    expect(result.reason).toBe('insufficient_balance')
  })

  it('persists each step before SDK call', async () => {
    const client = new FakeTradingClient({ outcomes: ['win'] })
    await client.login('a', 'b')
    const persistStep = jest.fn(async () => {})
    await executeGale({
      client,
      baseStake: 20,
      pair: 'X',
      direction: 'call',
      timeframe: '1m',
      tradeNum: 1,
      accountMode: 'demo',
      message: fakeMessageHandle(),
      systemPaused: async () => false,
      persistStep,
      sleep: async () => {},
    })
    expect(persistStep).toHaveBeenCalled()
    const [firstCall] = persistStep.mock.calls as unknown as Array<[Record<string, unknown>]>
    expect(firstCall?.[0]).toMatchObject({
      step: 1,
      stake: 20,
      iqTradeId: '',
      outcome: 'pending',
    })
  })
})
