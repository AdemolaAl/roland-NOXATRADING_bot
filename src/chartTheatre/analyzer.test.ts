import { describe, expect, it } from '@jest/globals'
import { analyzeChartFake } from './analyzer.js'

describe('analyzeChartFake', () => {
  it('returns valid direction', async () => {
    const result = await analyzeChartFake({
      send: async () => ({ messageId: 1 }),
      sleep: async () => {},
      edit: async () => {},
    })
    expect(['call', 'put']).toContain(result.direction)
  })

  it('confidence is 72-89', async () => {
    for (let index = 0; index < 20; index += 1) {
      const result = await analyzeChartFake({
        send: async () => ({ messageId: 1 }),
        sleep: async () => {},
        edit: async () => {},
      })
      expect(result.confidence).toBeGreaterThanOrEqual(72)
      expect(result.confidence).toBeLessThanOrEqual(89)
    }
  })

  it('reasoning is non-empty string', async () => {
    const result = await analyzeChartFake({
      send: async () => ({ messageId: 1 }),
      sleep: async () => {},
      edit: async () => {},
    })
    expect(typeof result.reasoning).toBe('string')
    expect(result.reasoning.length).toBeGreaterThan(10)
  })

  it('suggestedTimeframe is valid', async () => {
    const result = await analyzeChartFake({
      send: async () => ({ messageId: 1 }),
      sleep: async () => {},
      edit: async () => {},
    })
    expect(['30s', '1m', '2m']).toContain(result.suggestedTimeframe)
  })
})
