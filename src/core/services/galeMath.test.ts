import { describe, expect, it } from '@jest/globals'
import {
  GALE_MULTIPLIER,
  MAX_GALE_STEPS,
  payoutMultiplier,
  profitOnWin,
  stakeForStep,
  totalLossAfterSteps,
} from './galeMath.js'

describe('galeMath', () => {
  it('exposes constants', () => {
    expect(MAX_GALE_STEPS).toBe(6)
    expect(GALE_MULTIPLIER).toBe(2.3)
    expect(payoutMultiplier).toBe(1.92)
  })

  it('stakeForStep follows base × 2.3^(step-1)', () => {
    expect(stakeForStep(20, 1)).toBe(20)
    expect(stakeForStep(20, 2)).toBeCloseTo(46, 2)
    expect(stakeForStep(20, 3)).toBeCloseTo(105.8, 2)
  })

  it('stakeForStep rejects out-of-range step', () => {
    expect(() => stakeForStep(20, 0)).toThrow()
    expect(() => stakeForStep(20, 7)).toThrow()
  })

  it('totalLossAfterSteps sums prior step stakes', () => {
    expect(totalLossAfterSteps(20, 0)).toBe(0)
    expect(totalLossAfterSteps(20, 2)).toBeCloseTo(66, 2)
    expect(totalLossAfterSteps(20, 3)).toBeCloseTo(171.8, 2)
  })

  it('profitOnWin = stake×1.92 − stake − cumulative losses', () => {
    expect(profitOnWin(20, 1)).toBeCloseTo(18.4, 2)
    expect(profitOnWin(20, 2)).toBeCloseTo(22.32, 1)
  })

  it('profitOnWin always positive', () => {
    for (let step = 1; step <= 6; step += 1) {
      expect(profitOnWin(20, step)).toBeGreaterThan(0)
    }
  })
})
