import { describe, expect, it, jest } from '@jest/globals'
import { FakeTradingClient } from './fakeClient.js'
import { executeProBatch } from './proCoordinator.js'

const message = () => ({
  appendLine: jest.fn(async () => {}),
  replaceLastLine: jest.fn(async () => {}),
})

describe('executeProBatch', () => {
  const positions = [
    { pair: 'EURUSD-OTC', direction: 'call' as const, baseStake: 20, message: message() },
    { pair: 'GBPUSD-OTC', direction: 'put' as const, baseStake: 20, message: message() },
    { pair: 'AUDUSD-OTC', direction: 'call' as const, baseStake: 20, message: message() },
  ]

  const shared = async (client: FakeTradingClient) => ({
    client,
    timeframe: '1m' as const,
    accountMode: 'demo' as const,
    systemPaused: async () => false,
    persistStep: jest.fn(async () => {}),
    sleep: async () => {},
  })

  it('handles all 3 wins', async () => {
    const client = new FakeTradingClient({ outcomes: ['win', 'win', 'win'] })
    await client.login('a', 'b')
    const result = await executeProBatch(await shared(client), positions, 'session-1', 1)
    expect(result.positions.every((position) => position.outcome === 'win')).toBe(true)
    expect(result.totalProfit).toBeGreaterThan(0)
  })

  it('handles mixed results', async () => {
    const client = new FakeTradingClient({ outcomes: ['win', 'loss', 'win'] })
    await client.login('a', 'b')
    const result = await executeProBatch(await shared(client), positions, 'session-2', 1)
    expect(result.positions).toHaveLength(3)
  })

  it('handles all 3 losses', async () => {
    const client = new FakeTradingClient({
      outcomes: ['loss', 'loss', 'loss', 'loss', 'loss', 'loss'],
      initialBalance: { demo: 10_000, live: 10_000 },
    })
    await client.login('a', 'b')
    const result = await executeProBatch(await shared(client), positions, 'session-3', 1)
    expect(result.positions.every((position) => position.outcome === 'loss')).toBe(true)
    expect(result.totalProfit).toBeLessThan(0)
  })

  it('runs positions in parallel', async () => {
    const client = new FakeTradingClient({
      outcomes: ['win', 'win', 'win'],
      resultDelayMs: 50,
    })
    await client.login('a', 'b')
    const startedAt = Date.now()
    await executeProBatch(await shared(client), positions, 'session-4', 1)
    const elapsedMs = Date.now() - startedAt
    expect(elapsedMs).toBeLessThan(140)
  })
})
