import CircuitBreaker from 'opossum'
import type { PlaceBinaryParams, TradeResult, TradingClient } from './client.js'

const options = {
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeout: 60_000,
  timeout: 60_000,
}

export function wrapWithCircuit(client: TradingClient): TradingClient {
  const placeBreaker = new CircuitBreaker(
    (params: PlaceBinaryParams) => client.placeBinary(params),
    options,
  )
  const awaitBreaker = new CircuitBreaker(
    (args: { id: string; timeout: number }) => client.awaitResult(args.id, args.timeout),
    options,
  )

  return {
    ...client,
    placeBinary: (params) => placeBreaker.fire(params) as Promise<{ iqTradeId: string }>,
    awaitResult: (id, timeoutMs) =>
      awaitBreaker.fire({ id, timeout: timeoutMs }) as Promise<TradeResult>,
  }
}
