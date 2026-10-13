import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { accountTypeKeyboard } from '../keyboards/inline.js'
import { ensureUser, getUserFlowData, setFlowData, transitionAfterEvent } from './_bridge.js'
import { replyWithHandoffImage, replyWithMoneyGbtImage } from '../media.js'
import { pause, typing } from './_uxHelpers.js'
import { getCachedBalanceForUser, refreshUserBalanceInBackground } from './_sceneHelpers.js'

export const accountTypeScene = new Scenes.BaseScene<BotContext>('ACCOUNT_TYPE')

accountTypeScene.enter(async (ctx) => {
  const user = await ensureUser(ctx)
  const flow = await getUserFlowData(ctx)
  const desiredAccountMode =
    flow.desiredAccountMode === 'live' || flow.desiredAccountMode === 'demo'
      ? flow.desiredAccountMode
      : null

  if (desiredAccountMode) {
    const nextFlow = { ...flow }
    delete nextFlow.desiredAccountMode
    await setFlowData(ctx, nextFlow)

    await pause(250)
    await typing(ctx, 400)
    const telegramId = BigInt(user.telegram_id)
    const balance = await getCachedBalanceForUser(telegramId)
    const sent = await replyWithMoneyGbtImage(
      ctx,
      desiredAccountMode === 'demo' ? '02-demo-active.jpg' : '01-bot-live.jpg',
      desiredAccountMode === 'demo'
        ? `🧪 *Demo* account active.\nBalance: *$${balance.toFixed(2)}*`
        : `🟢 *LIVE* account connected.\nBalance: *$${balance.toFixed(2)}*`,
      { parse_mode: 'Markdown' },
    )
    refreshUserBalanceInBackground(telegramId, desiredAccountMode, async (freshBalance) => {
      if (!sent || Math.abs(freshBalance - balance) < 0.01) return
      await ctx.telegram
        .editMessageCaption(
          sent.chat.id,
          sent.message_id,
          undefined,
          desiredAccountMode === 'demo'
            ? `🧪 *Demo* account active.\nBalance: *$${freshBalance.toFixed(2)}*`
            : `🟢 *LIVE* account connected.\nBalance: *$${freshBalance.toFixed(2)}*`,
          { parse_mode: 'Markdown' },
        )
        .catch(() => {})
    })
    await transitionAfterEvent(ctx, { type: 'ACCOUNT_TYPE_PICKED', mode: desiredAccountMode })
    return
  }

  const showLive = user.tier !== 'demo' && user.status !== 'force_demo'
  const caption = showLive
    ? [
        '*How do you want to trade?*',
        '',
        '🧪  *Demo* — paper money, test the flow risk-free.',
        '💸  *Live* — your real IQ Option balance, real wins.',
        '',
        'You can switch anytime.',
      ]
    : [
        '*Starting in Demo mode*',
        '',
        '🧪  *Demo* — paper money, test the flow risk-free.',
        '',
        'Live trading unlocks once you have an active token.',
      ]
  await typing(ctx, 450)
  await replyWithHandoffImage(
    ctx,
    '08-demo-vs-live.jpg',
    caption.join('\n'),
    {
      parse_mode: 'Markdown',
      ...accountTypeKeyboard(showLive),
    },
  )
})

accountTypeScene.action('ACCOUNT_DEMO', async (ctx) => {
  await ctx.answerCbQuery('Demo mode 🧪')
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  const user = await ensureUser(ctx)
  await pause(300)
  await typing(ctx, 400)
  const telegramId = BigInt(user.telegram_id)
  const balance = await getCachedBalanceForUser(telegramId)
  const sent = await replyWithMoneyGbtImage(
    ctx,
    '02-demo-active.jpg',
    `🧪 *Demo* account active.\nBalance: *$${balance.toFixed(2)}*`,
    { parse_mode: 'Markdown' },
  )
  refreshUserBalanceInBackground(telegramId, 'demo', async (freshBalance) => {
    if (!sent || Math.abs(freshBalance - balance) < 0.01) return
    await ctx.telegram
      .editMessageCaption(
        sent.chat.id,
        sent.message_id,
        undefined,
        `🧪 *Demo* account active.\nBalance: *$${freshBalance.toFixed(2)}*`,
        { parse_mode: 'Markdown' },
      )
      .catch(() => {})
  })
  await transitionAfterEvent(ctx, { type: 'ACCOUNT_TYPE_PICKED', mode: 'demo' })
})

accountTypeScene.action('ACCOUNT_LIVE', async (ctx) => {
  await ctx.answerCbQuery('Live mode 💸')
  const user = await ensureUser(ctx)
  if (user.tier === 'demo' || user.status === 'force_demo') {
    await ctx.reply('Live trading is not available for this account tier yet.')
    return
  }
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  await pause(300)
  await typing(ctx, 400)
  const telegramId = BigInt(user.telegram_id)
  const live = await getCachedBalanceForUser(telegramId)
  const sent = await replyWithMoneyGbtImage(
    ctx,
    '01-bot-live.jpg',
    `🟢 *LIVE* account connected.\nBalance: *$${live.toFixed(2)}*`,
    { parse_mode: 'Markdown' },
  )
  refreshUserBalanceInBackground(telegramId, 'live', async (freshBalance) => {
    if (!sent || Math.abs(freshBalance - live) < 0.01) return
    await ctx.telegram
      .editMessageCaption(
        sent.chat.id,
        sent.message_id,
        undefined,
        `🟢 *LIVE* account connected.\nBalance: *$${freshBalance.toFixed(2)}*`,
        { parse_mode: 'Markdown' },
      )
      .catch(() => {})
  })
  await transitionAfterEvent(ctx, { type: 'ACCOUNT_TYPE_PICKED', mode: 'live' })
})
