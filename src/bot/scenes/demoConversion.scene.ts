import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { demoConversionKeyboard, proUpsellKeyboard } from '../keyboards/inline.js'
import { funnelRepo, tradeRepo } from '../../core/repositories/index.js'
import { ensureUser, getUserFlowData, setFlowData, transitionAfterEvent } from './_bridge.js'
import { replyWithHandoffImage, replyWithMoneyGbtImage } from '../media.js'
import { pause, typing } from './_uxHelpers.js'

async function replyWithSessionStats(ctx: BotContext) {
  const user = await ensureUser(ctx)
  const stats = await tradeRepo.aggregatesForUser(BigInt(user.telegram_id))
  await ctx.reply(
    [
      '📊 Session stats',
      `Trades: ${stats.total_trades}`,
      `Total staked: $${stats.total_staked}`,
      `Net P&L: $${stats.net_pnl}`,
    ].join('\n'),
  )
}

export const demoConversionScene = new Scenes.BaseScene<BotContext>('DEMO_CONVERSION')
export const proUpsellScene = new Scenes.BaseScene<BotContext>('PRO_UPSELL')

demoConversionScene.enter(async (ctx) => {
  const user = await ensureUser(ctx)
  const flow = user.flow_data ?? {}
  const lastResult = (flow as { lastTradeResult?: { netProfit?: number } }).lastTradeResult
  const profit = Number(lastResult?.netProfit ?? 0)

  await pause(500)
  await typing(ctx, 700)
  await ctx.reply(
    [
      `💸 You just made *+$${profit.toFixed(2)}*`,
      'In demo coins.',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
  await pause(400)
  await typing(ctx, 800)
  await replyWithMoneyGbtImage(
    ctx,
    '08-demo-vs-live.jpg',
    '*WHAT IF THIS WAS REAL?*',
    { parse_mode: 'Markdown' },
  )
  await pause(450)
  await typing(ctx, 700)
  await ctx.reply(
    [
      'While you read this…',
      '',
      `real NOXATRADING users just banked *+$${profit.toFixed(2)}* CASH from the exact same setup.`,
      '',
      'Every minute on demo = real profit lost.',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
  await pause(450)
  await typing(ctx, 700)
  await replyWithMoneyGbtImage(
    ctx,
    '04-go-live.jpg',
    '*Time to earn real money.*\nFund your IQ Option account, wins land in your bank, withdraw anytime.',
    { parse_mode: 'Markdown' },
  )
  await pause(400)
  await typing(ctx, 450)
  await ctx.reply('Switch to LIVE in 1 tap 👇', demoConversionKeyboard())
})

// Removing the keyboard after a one-shot choice prevents the user from
// tapping a competing button (e.g. STAY_DEMO right before SWITCH_TO_LIVE)
// once they've already made the decision and the scene has moved on.
async function clearKeyboard(ctx: BotContext) {
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
}

demoConversionScene.action('SWITCH_TO_LIVE', async (ctx) => {
  await ctx.answerCbQuery('Switching to LIVE 💰')
  await clearKeyboard(ctx)
  const user = await ensureUser(ctx)

  // Same celebration card for both paths — "Time to earn real money".
  await pause(300)
  await typing(ctx, 700)
  await replyWithMoneyGbtImage(
    ctx,
    '04-go-live.jpg',
    '*TIME TO EARN REAL MONEY* 💰\nFund your account · Wins land in your bank · Withdraw anytime',
    { parse_mode: 'Markdown' },
  )
  await pause(450)

  if (user.tier === 'demo' || user.status === 'force_demo') {
    await setFlowData(ctx, {
      ...(await getUserFlowData(ctx)),
      desiredAccountMode: 'live',
      requestedTier: 'auto',
    })
    await transitionAfterEvent(ctx, { type: 'SWITCH_TO_LIVE' })
    return
  }

  // AUTO / PRO user already has the unlock — flag the desired mode so the
  // ACCOUNT_TYPE scene auto-confirms LIVE instead of asking again.
  await setFlowData(ctx, {
    ...(await getUserFlowData(ctx)),
    desiredAccountMode: 'live',
  })
  await transitionAfterEvent(ctx, { type: 'SWITCH_TO_LIVE' })
})

demoConversionScene.action('STAY_DEMO', async (ctx) => {
  await ctx.answerCbQuery()
  await clearKeyboard(ctx)
  await transitionAfterEvent(ctx, { type: 'STAY_DEMO' })
})

// Inline stats — no scene change, so the user can still tap SWITCH_TO_LIVE
// or STAY_DEMO afterwards on the original message.
demoConversionScene.action('VIEW_STATS', async (ctx) => {
  await ctx.answerCbQuery()
  await replyWithSessionStats(ctx)
})

proUpsellScene.enter(async (ctx) => {
  const user = await ensureUser(ctx)
  await funnelRepo.record(BigInt(user.telegram_id), 'pro_upsell_hit')
  const flow = user.flow_data ?? {}
  const lastResult = (flow as { lastTradeResult?: { netProfit?: number } }).lastTradeResult
  const profit = Number(lastResult?.netProfit ?? 0)
  const tripled = profit * 3

  await pause(450)
  await typing(ctx, 700)
  await ctx.reply('Do you know you can get *3x results* with PRO mode?', {
    parse_mode: 'Markdown',
  })
  await pause(400)
  await typing(ctx, 800)
  await replyWithHandoffImage(ctx, '16-upsell-pro.jpg', '⚡ *NOXATRADING PRO*', {
    parse_mode: 'Markdown',
  })
  await pause(500)
  await typing(ctx, 750)
  await ctx.reply(
    [
      `That *$${profit.toFixed(2)}* you just made?`,
      '',
      `On PRO running 3 trades at once = *$${tripled.toFixed(2)}*.`,
      '',
      'Same skill. *3x* the money.',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
  await pause(400)
  await typing(ctx, 700)
  await replyWithHandoffImage(
    ctx,
    '16-upsell-pro.jpg',
    '*3 positions running in parallel*',
    { parse_mode: 'Markdown' },
  )
  await pause(500)
  await typing(ctx, 550)
  await ctx.reply(
    [
      'Plus drop any chart screenshot.',
      'Get instant AI analysis.',
    ].join('\n'),
  )
  await pause(400)
  await typing(ctx, 700)
  await replyWithHandoffImage(ctx, '09-scanning.jpg', '📈 *Instant chart AI*', {
    parse_mode: 'Markdown',
  })
  await pause(500)
  await typing(ctx, 450)
  await ctx.reply('Unlock PRO 👇', proUpsellKeyboard())
})

proUpsellScene.action('UNLOCK_PRO', async (ctx) => {
  await ctx.answerCbQuery()
  await clearKeyboard(ctx)
  await setFlowData(ctx, {
    ...(await getUserFlowData(ctx)),
    desiredAccountMode: 'live',
    requestedTier: 'pro',
  })
  await transitionAfterEvent(ctx, { type: 'UNLOCK_PRO' })
})

proUpsellScene.action('CONTINUE_AUTO', async (ctx) => {
  await ctx.answerCbQuery()
  await clearKeyboard(ctx)
  await transitionAfterEvent(ctx, { type: 'CONTINUE_AUTO' })
})

proUpsellScene.action('VIEW_STATS', async (ctx) => {
  await ctx.answerCbQuery()
  await replyWithSessionStats(ctx)
})
