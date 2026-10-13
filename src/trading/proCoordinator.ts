import type { GaleParams, GaleResult } from './galeExecutor.js'
import { executeGale } from './galeExecutor.js'

export type ProPosition = Pick<GaleParams, 'pair' | 'direction' | 'baseStake' | 'message'>

export type ProBatchResult = {
  positions: GaleResult[]
  totalProfit: number
  proSessionId: string
}

export async function executeProBatch(
  shared: Omit<GaleParams, 'pair' | 'direction' | 'baseStake' | 'message' | 'tradeNum'>,
  positions: ProPosition[],
  proSessionId: string,
  baseTradeNum: number,
): Promise<ProBatchResult> {
  if (positions.length !== 3) {
    throw new Error('PRO requires exactly 3 positions')
  }

  const results = await Promise.all(
    positions.map((position, index) =>
      executeGale({
        ...shared,
        pair: position.pair,
        direction: position.direction,
        baseStake: position.baseStake,
        message: position.message,
        tradeNum: baseTradeNum + index,
      }),
    ),
  )

  const totalProfit = results.reduce((accumulator, result) => {
    if (result.outcome === 'win') {
      return accumulator + result.netProfit
    }

    return accumulator - result.cumulativeLoss
  }, 0)

  return {
    positions: results,
    totalProfit,
    proSessionId,
  }
}
