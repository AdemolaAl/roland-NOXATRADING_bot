import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { agreementKeyboard } from '../keyboards/inline.js'
import { ensureUser, getUserFlowData, transitionAfterEvent } from './_bridge.js'
import { pause, typing } from './_uxHelpers.js'
import { whereShouldUserBe } from '../../core/services/userJourney.js'
import { getLogger } from '../../infra/logger.js'

export const agreementScene = new Scenes.BaseScene<BotContext>('AGREEMENT')

agreementScene.enter(async (ctx) => {
  // Skip the agreement screen if the user has already accepted —
  // their column carries true forever. Without this short-circuit a
  // session-expired-but-deposited user re-logging in would be
  // forced to re-tap "Agree" before reaching HOME, the bug Evgeny
  // also reported.
  const user = await ensureUser(ctx)
  const target = whereShouldUserBe(user)
  if (target !== 'AGREEMENT') {
    getLogger().info(
      { event: 'gate_redirect', from: 'AGREEMENT', to: target, telegramId: user.telegram_id },
      'AGREEMENT redirected by achievement state',
    )
    await ctx.scene.enter(target)
    return
  }
  await typing(ctx, 550)
  await ctx.reply(
    [
      '*Before you trade — agree to the terms* 👇',
      '',
      'NOXATRADING places trades using a recovery method (up to 6 steps).',
      'Past performance is not a guarantee.',
      'Trading involves risk.',
    ].join('\n'),
    { parse_mode: 'Markdown', ...agreementKeyboard() },
  )
})

agreementScene.action('AGREEMENT_ACCEPTED', async (ctx) => {
  await ctx.answerCbQuery('Welcome aboard ⚡')
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  await pause(300)
  await typing(ctx, 400)
  await ctx.reply('✅ Agreement accepted.')
  const flow = await getUserFlowData(ctx)
  const requestedTier = String(flow.requestedTier ?? '')
  if (requestedTier === 'pro') {
    await transitionAfterEvent(ctx, { type: 'AGREEMENT_ACCEPTED_PRO' })
    return
  }
  if (requestedTier === 'auto') {
    await transitionAfterEvent(ctx, { type: 'AGREEMENT_ACCEPTED_AUTO' })
    return
  }
  await transitionAfterEvent(ctx, { type: 'AGREEMENT_ACCEPTED_DEMO' })
})

agreementScene.action('AGREEMENT_DECLINED', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  await typing(ctx, 400)
  await ctx.reply(
    [
      'No worries.',
      '',
      'You can come back anytime.',
      'The bot stays locked until you accept.',
    ].join('\n'),
  )
  await transitionAfterEvent(ctx, { type: 'AGREEMENT_DECLINED' })
})
