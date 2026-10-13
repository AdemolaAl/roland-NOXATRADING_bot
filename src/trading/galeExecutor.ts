import {
  MAX_GALE_STEPS,
  profitOnWin,
  stakeForStep,
  totalLossAfterSteps,
} from '../core/services/galeMath.js'
import type { Direction, TradingClient } from './client.js'

export type GaleStepRecord = {
  step: number
  stake: number
  iqTradeId: string
  outcome: 'win' | 'loss' | 'pending'
  netReturn: number
  error?: string
}

export type Timeframe = '30s' | '1m' | '2m' | '5m'

export type GaleParams = {
  client: TradingClient
  baseStake: number
  pair: string
  direction: Direction
  timeframe: Timeframe
  tradeNum: number
  accountMode: 'demo' | 'live'
  message: {
    appendLine: (line: string) => Promise<void>
    replaceLastLine: (line: string) => Promise<void>
  }
  systemPaused: () => Promise<boolean>
  persistStep: (step: GaleStepRecord) => Promise<void>
  sleep: (ms: number) => Promise<void>
}

export type GaleResult =
  | { outcome: 'win'; winStep: number; netProfit: number; iqTradeIds: string[] }
  | { outcome: 'loss'; cumulativeLoss: number; iqTradeIds: string[] }
  | {
      outcome: 'aborted'
      reason: 'system_paused' | 'insufficient_balance' | 'sdk_error'
      cumulativeLoss: number
      iqTradeIds: string[]
      error?: string
    }

const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '30s': 30,
  '1m': 60,
  '2m': 120,
  '5m': 300,
}

const fmt = (n: number) => `$${n.toFixed(2)}`

export async function executeGale(params: GaleParams): Promise<GaleResult> {
  const iqTradeIds: string[] = []

  for (let step = 1; step <= MAX_GALE_STEPS; step += 1) {
    if (await params.systemPaused()) {
      return {
        outcome: 'aborted',
        reason: 'system_paused',
        cumulativeLoss: totalLossAfterSteps(params.baseStake, step - 1),
        iqTradeIds,
      }
    }

    const stake = stakeForStep(params.baseStake, step)
    const balance = await params.client.getBalance(params.accountMode)

    if (balance < stake) {
      return {
        outcome: 'aborted',
        reason: 'insufficient_balance',
        cumulativeLoss: totalLossAfterSteps(params.baseStake, step - 1),
        iqTradeIds,
      }
    }

    await params.persistStep({
      step,
      stake,
      iqTradeId: '',
      outcome: 'pending',
      netReturn: 0,
    })

    let placed: { iqTradeId: string }

    try {
      placed = await params.client.placeBinary({
        pair: params.pair,
        direction: params.direction,
        stake,
        expirationSeconds: TIMEFRAME_SECONDS[params.timeframe],
      })
    } catch (error) {
      return {
        outcome: 'aborted',
        reason: 'sdk_error',
        cumulativeLoss: totalLossAfterSteps(params.baseStake, step - 1),
        iqTradeIds,
        error: (error as Error).message,
      }
    }

    iqTradeIds.push(placed.iqTradeId)
    await params.persistStep({
      step,
      stake,
      iqTradeId: placed.iqTradeId,
      outcome: 'pending',
      netReturn: 0,
    })
    await params.message.appendLine(
      `⚡ Trade ${params.tradeNum}|Step ${step}|🟡 ${fmt(stake)} → in flight`,
    )

    try {
      const result = await params.client.awaitResult(
        placed.iqTradeId,
        TIMEFRAME_SECONDS[params.timeframe] * 1000 + 10_000,
      )

      if (result.outcome === 'win') {
        const netProfit = profitOnWin(params.baseStake, step)
        await params.persistStep({
          step,
          stake,
          iqTradeId: placed.iqTradeId,
          outcome: 'win',
          netReturn: netProfit,
        })
        await params.message.replaceLastLine(
          `⚡ Trade ${params.tradeNum}|Step ${step}|🟢 ${fmt(stake)} → +${fmt(netProfit)}`,
        )
        return { outcome: 'win', winStep: step, netProfit, iqTradeIds }
      }

      await params.persistStep({
        step,
        stake,
        iqTradeId: placed.iqTradeId,
        outcome: 'loss',
        netReturn: -stake,
      })
      await params.message.replaceLastLine(
        `⚡ Trade ${params.tradeNum}|Step ${step}|🔴 ${fmt(stake)} → -${fmt(stake)}`,
      )
      await params.sleep(1500)
    } catch (error) {
      await params.persistStep({
        step,
        stake,
        iqTradeId: placed.iqTradeId,
        outcome: 'loss',
        netReturn: -stake,
        error: (error as Error).message,
      })
      return {
        outcome: 'aborted',
        reason: 'sdk_error',
        cumulativeLoss: totalLossAfterSteps(params.baseStake, step),
        iqTradeIds,
        error: (error as Error).message,
      }
    }
  }

  return {
    outcome: 'loss',
    cumulativeLoss: totalLossAfterSteps(params.baseStake, MAX_GALE_STEPS),
    iqTradeIds,
  }
}
