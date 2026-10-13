import { describe, expect, it } from '@jest/globals'
import { FakeTradingClient } from './fakeClient.js'

describe('FakeTradingClient', () => {
  it('login succeeds with default config', async () => {
    const client = new FakeTradingClient()
    const result = await client.login('a@b', 'pw')
    expect(result.iqUserId).toMatch(/^FAKE-/)
    expect(result.partnerCode).toBe('aff=743768')
  })

  it('places binary and returns scripted outcome', async () => {
    const client = new FakeTradingClient({ outcomes: ['win'] })
    await client.login('a', 'b')
    const { iqTradeId } = await client.placeBinary({
      pair: 'EURUSD-OTC',
      direction: 'call',
      stake: 20,
      expirationSeconds: 60,
    })
    const result = await client.awaitResult(iqTradeId, 5000)
    expect(result.outcome).toBe('win')
    expect(result.payout).toBeCloseTo(20 * 1.92, 2)
  })

  it('cycles through scripted outcomes', async () => {
    const client = new FakeTradingClient({ outcomes: ['loss', 'loss', 'win'] })
    await client.login('a', 'b')
    const outcomes: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const { iqTradeId } = await client.placeBinary({
        pair: 'X',
        direction: 'call',
        stake: 10,
        expirationSeconds: 60,
      })
      outcomes.push((await client.awaitResult(iqTradeId, 5000)).outcome)
    }
    expect(outcomes).toEqual(['loss', 'loss', 'win'])
  })

  it('getBalance returns configured value', async () => {
    const client = new FakeTradingClient({
      initialBalance: { demo: 10_000, live: 250 },
    })
    await client.login('a', 'b')
    expect(await client.getBalance('demo')).toBe(10_000)
    expect(await client.getBalance('live')).toBe(250)
  })
})
