import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { tradeRepo } from '../../core/repositories/index.js'
import { postTradeKeyboard } from '../keyboards/inline.js'
import { ensureUser, transitionAfterEvent } from './_bridge.js'
import { replyWithMoneyGbtImage } from '../media.js'
import { pause, typing } from './_uxHelpers.js'

export const postTradeMenuScene = new Scenes.BaseScene<BotContext>('POST_TRADE_MENU')
export const statsViewScene = new Scenes.BaseScene<BotContext>('STATS_VIEW')
export const idleScene = new Scenes.BaseScene<BotContext>('IDLE')

postTradeMenuScene.enter(async (ctx) => {
  await typing(ctx, 450)
  await ctx.reply(
    [
      '*Ready for the next trade?*',
      '',
      '👇  Take another signal, view stats, or pause for now.',
    ].join('\n'),
    { parse_mode: 'Markdown', ...postTradeKeyboard() },
  )
})

statsViewScene.enter(async (ctx) => {
  const user = await ensureUser(ctx)
  const stats = await tradeRepo.aggregatesForUser(BigInt(user.telegram_id))
  const net = Number(stats.net_pnl)
  const sign = net >= 0 ? '+' : ''
  await typing(ctx, 500)
  await ctx.reply(
    [
      '📊  *SESSION STATS*',
      '',
      `Trades:  *${stats.total_trades}*`,
      `Total staked:  *$${Number(stats.total_staked).toFixed(2)}*`,
      `Net result:  *${sign}$${net.toFixed(2)}*`,
      '',
      'Keep the streak going 👇',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
  await pause(400)
  await ctx.scene.enter('POST_TRADE_MENU')
})

idleScene.enter(async (ctx) => {
  await typing(ctx, 350)
  await replyWithMoneyGbtImage(
    ctx,
    '13-watching.jpg',
    [
      '*Bot is still watching.* 24/7.',
      '',
      "8 markets. Every second. Never sleeps.",
      "When a setup hits 80%+, I'll let you know.",
      '',
      'Send /start when ready 👇',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
})
