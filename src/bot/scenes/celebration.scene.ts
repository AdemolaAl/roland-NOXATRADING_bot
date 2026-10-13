import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { ensureUser, getUserFlowData, transitionAfterEvent } from './_bridge.js'
import { replyWithHandoffImage } from '../media.js'
import { tradeRepo } from '../../core/repositories/index.js'
import { pause, typing } from './_uxHelpers.js'

export const celebrationScene = new Scenes.BaseScene<BotContext>('CELEBRATION')
export const celebrationProScene = new Scenes.BaseScene<BotContext>('CELEBRATION_PRO')

celebrationScene.enter(async (ctx) => {
  const flow = await getUserFlowData(ctx)
  const user = await ensureUser(ctx)
  const result = flow.lastTradeResult as
    | { outcome?: string; netProfit?: number; cumulativeLoss?: number; winStep?: number }
    | undefined

  await typing(ctx, 700)

  if (result?.outcome === 'win') {
    const profit = Number(result.netProfit ?? 0)
    const winStep = result.winStep ?? 1
    const isRecovery = winStep > 1
    const stepLabel = result.winStep ? ` on step ${result.winStep}/6` : ''
    // Pick image to match win type — see _sceneHelpers.renderCelebrationWin
    // for the same branching rationale. 19-profit-confirmed.jpg reads
    // "PROFIT. CONFIRMED. Your account just grew." for clean first-step
    // wins; 20-win-locked.jpg reads "PROFIT. Signal confirmed · Trade
    // closed · Win locked" for recovery wins.
    await replyWithHandoffImage(
      ctx,
      isRecovery ? '20-win-locked.jpg' : '19-profit-confirmed.jpg',
      [
        `🏆 *+$${profit.toFixed(2)}* added to your balance.`,
        '',
        `Won${stepLabel}.`,
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
    // Tiny session-stats line for that "your-wins-are-stacking" feel.
    const stats = await tradeRepo.aggregatesForUser(BigInt(user.telegram_id))
    await pause(500)
    await ctx.reply(
      [
        '_Session_',
        `📊  Trades: *${stats.total_trades}*  ·  Net: *${Number(stats.net_pnl) >= 0 ? '+' : ''}$${Number(stats.net_pnl).toFixed(2)}*`,
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
  } else {
    const loss = Number(result?.cumulativeLoss ?? 0)
    await ctx.reply(
      [
        '🛑 *Trade closed*',
        '',
        `Net: *-$${loss.toFixed(2)}*`,
        '',
        'Pick another pair and run it back 👇',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
  }

  await pause(450)
  await transitionAfterEvent(ctx, { type: 'CELEBRATION_DONE' })
})

celebrationProScene.enter(async (ctx) => {
  const flow = await getUserFlowData(ctx)
  const result = flow.lastTradeResult as
    | { totalProfit?: number; positions?: Array<{ outcome?: string; netProfit?: number; cumulativeLoss?: number }> }
    | undefined

  const total = Number(result?.totalProfit ?? 0)
  const wins = result?.positions?.filter((p) => p.outcome === 'win').length ?? 0
  const losses = result?.positions?.filter((p) => p.outcome === 'loss').length ?? 0

  await typing(ctx, 700)
  await replyWithHandoffImage(
    ctx,
    '16-upsell-pro.jpg',
    [
      '⚡ *PRO batch complete*',
      '',
      `Net across 3 positions: *${total >= 0 ? '+' : ''}$${total.toFixed(2)}*`,
      `🏆  Wins: *${wins}*    💥  Losses: *${losses}*`,
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
  await pause(500)
  await transitionAfterEvent(ctx, { type: 'CELEBRATION_DONE' })
})
