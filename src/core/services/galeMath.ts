export const MAX_GALE_STEPS = 6
export const GALE_MULTIPLIER = 2.3
export const payoutMultiplier = 1.92

export function stakeForStep(baseStake: number, step: number): number {
  if (step < 1 || step > MAX_GALE_STEPS) {
    throw new Error(`step out of range: ${step}`)
  }

  return baseStake * Math.pow(GALE_MULTIPLIER, step - 1)
}

export function totalLossAfterSteps(baseStake: number, stepsLost: number): number {
  let total = 0

  for (let step = 1; step <= stepsLost; step += 1) {
    total += stakeForStep(baseStake, step)
  }

  return total
}

export function profitOnWin(baseStake: number, winningStep: number): number {
  const stake = stakeForStep(baseStake, winningStep)
  const grossReturn = stake * payoutMultiplier
  const cumulativeLoss = totalLossAfterSteps(baseStake, winningStep - 1)

  return grossReturn - stake - cumulativeLoss
}
