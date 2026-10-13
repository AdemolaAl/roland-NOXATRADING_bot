import { describe, expect, it } from '@jest/globals'
import { generatePairSelection, PAIR_POOL } from './pairGenerator.js'

describe('pairGenerator', () => {
  it('PAIR_POOL has 9 pairs', () => {
    expect(PAIR_POOL).toHaveLength(9)
  })

  it('generatePairSelection returns 4 pairs', () => {
    const selection = generatePairSelection()
    expect(selection).toHaveLength(4)
  })

  it('all returned pairs are from PAIR_POOL', () => {
    const selection = generatePairSelection()

    for (const pair of selection) {
      expect(PAIR_POOL.find((candidate) => candidate.code === pair.code)).toBeDefined()
    }
  })

  it('returned pairs are unique', () => {
    const selection = generatePairSelection()
    const codes = new Set(selection.map((pair) => pair.code))
    expect(codes.size).toBe(4)
  })

  it('win-rates are 60-90 inclusive', () => {
    const selection = generatePairSelection()

    for (const pair of selection) {
      expect(pair.winRate).toBeGreaterThanOrEqual(60)
      expect(pair.winRate).toBeLessThanOrEqual(90)
    }
  })

  it('first pair has the highest win-rate', () => {
    const selection = generatePairSelection()

    for (let index = 1; index < selection.length; index += 1) {
      expect(selection[0]!.winRate).toBeGreaterThanOrEqual(selection[index]!.winRate)
    }
  })
})
