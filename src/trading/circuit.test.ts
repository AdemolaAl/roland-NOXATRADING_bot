import { describe, expect, it } from '@jest/globals'
import { wrapWithCircuit } from './circuit.js'
import type { PlaceBinaryParams, TradingClient } from './client.js'

class FailingClient implements TradingClient {
  async login(): Promise<any> {
    throw new Error('unused')
  }
  async resumeSession(): Promise<void> {}
  async logout(): Promise<void> {}
  async getBalance(): Promise<number> {
    return 0
  }
  async setAccountMode(): Promise<void> {}
  getUserId(): string {
    return 'x'
  }
  getPartnerCode(): string | null {
    return null
  }
  async placeBinary(_params: PlaceBinaryParams): Promise<{ iqTradeId: string }> {
    throw new Error('boom')
  }
  async awaitResult(): Promise<any> {
    throw new Error('boom')
  }
}

describe('wrapWithCircuit', () => {
  it('breaker opens after repeated failures', async () => {
    const wrapped = wrapWithCircuit(new FailingClient())

    for (let index = 0; index < 5; index += 1) {
      await expect(
        wrapped.placeBinary({
          pair: 'EURUSD-OTC',
          direction: 'call',
          stake: 20,
          expirationSeconds: 60,
        }),
      ).rejects.toThrow()
    }

    await expect(
      wrapped.placeBinary({
        pair: 'EURUSD-OTC',
        direction: 'call',
        stake: 20,
        expirationSeconds: 60,
      }),
    ).rejects.toThrow()
  })
})
