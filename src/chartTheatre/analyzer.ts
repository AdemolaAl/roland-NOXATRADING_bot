const REASONS_CALL = [
  'Strong bullish momentum on the 1m. Support holding at last swing low.',
  'RSI rebounding from oversold. Volume building on green candles.',
  'Breaking above the 20-EMA with conviction. Buyers in control.',
  'Higher lows forming. Bulls defending the trendline.',
  'Bullish engulfing on last close. Sellers exhausted.',
  'OTC pair showing accumulation pattern. Upside likely.',
  'Stochastic crossing up from oversold. Momentum shift confirmed.',
  'Volume profile favors buyers above this price level.',
  'Price compression resolving upward. Breakout in progress.',
  'Fibonacci 0.618 retracement holding. Bullish continuation expected.',
] as const

const REASONS_PUT = [
  'Rejection at resistance. Bears stepping in heavy.',
  'Lower highs printing. Trend turning down.',
  'RSI overbought + bearish divergence. Pullback incoming.',
  'Failed breakout above the 20-EMA. Sellers reclaiming control.',
  'Distribution pattern visible on volume. Smart money exiting.',
  'Bearish engulfing close. Buyers losing conviction.',
  'Price rejecting key Fibonacci level. Reversal likely.',
  'MACD crossing down with widening histogram. Bearish momentum.',
  'Lower-timeframe consolidation breaking down. Continuation lower.',
  'Order flow shifting bearish in the last 3 candles.',
] as const

const STAGES = [
  'Reading candles...',
  'Calculating support/resistance levels...',
  'Running volatility analysis...',
  'Cross-referencing OTC pair data...',
  'Finalizing signal...',
] as const

export type ChartCall = {
  direction: 'call' | 'put'
  confidence: number
  reasoning: string
  suggestedTimeframe: '30s' | '1m' | '2m'
}

export type AnalyzeContext = {
  send: (text: string) => Promise<{ messageId: number }>
  edit: (messageId: number, text: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
}

const pickRandom = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!

export async function analyzeChartFake(ctx: AnalyzeContext): Promise<ChartCall> {
  const status = await ctx.send(STAGES[0]!)
  for (let index = 1; index < STAGES.length; index += 1) {
    await ctx.sleep(900 + Math.random() * 600)
    await ctx.edit(status.messageId, STAGES[index]!)
  }
  await ctx.sleep(800)

  const direction: 'call' | 'put' = Math.random() < 0.5 ? 'call' : 'put'
  const confidence = 72 + Math.floor(Math.random() * 18)
  const reasoning = pickRandom(direction === 'call' ? REASONS_CALL : REASONS_PUT)
  const suggestedTimeframe = pickRandom(['30s', '1m', '2m'] as const)

  return { direction, confidence, reasoning, suggestedTimeframe }
}
