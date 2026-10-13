import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { signupDoneKeyboard, signupHelpKeyboard } from '../keyboards/inline.js'
import { clickAttributionRepo, userRepo } from '../../core/repositories/index.js'
import { buildSignupUrl, mintClickId } from '../../core/services/iqSignup.js'
import { ensureUser, getUserFlowData, mergeFlowData, setFlowData, transitionAfterEvent } from './_bridge.js'
import { pause, typing } from './_uxHelpers.js'
import { invalidateCachedClient } from '../../trading/iqSessionCache.js'

export const iqSignupHelpScene = new Scenes.BaseScene<BotContext>('IQ_SIGNUP_HELP')

iqSignupHelpScene.enter(async (ctx) => {
  const user = await ensureUser(ctx)
  const flow = await getUserFlowData(ctx)

  // Reuse an existing clickid if the user re-entered the scene (e.g.
  // they tapped Back and then Create one free again). Otherwise mint
  // a fresh one so each render has its own attribution row.
  let clickId = typeof flow.currentClickId === 'string' ? flow.currentClickId : ''
  if (!clickId) {
    clickId = mintClickId()
    const requested = String(flow.requestedTier ?? '')
    const tierIntent: 'auto' | 'pro' | 'unknown' =
      requested === 'auto' || requested === 'pro' ? requested : 'unknown'
    await clickAttributionRepo.insert({
      clickId,
      telegramId: BigInt(user.telegram_id),
      tierIntent,
    })
    await setFlowData(ctx, { ...flow, currentClickId: clickId })
  }
  const signupUrl = buildSignupUrl(clickId)

  await typing(ctx, 900)
  await ctx.reply(
    [
      '⚠️ *Already have an IQ Option account?*',
      '',
      "You'll need to register a new one with a different email. Use the link above.",
      '',
      "Once you're done, come back and tap below 👇",
    ].join('\n'),
    { parse_mode: 'Markdown', ...signupHelpKeyboard(signupUrl) },
  )

  await pause(500)
  await typing(ctx, 700)
  await ctx.reply(
    [
      '📧 Use a fresh email — every NOXATRADING user needs a new account under our partner code.',
      'Takes about 2 minutes.',
      '',
      "Once you're signed up, I'll DM you as soon as I see the account come through.",
      '',
      "If you already have an IQ Option account on another email, that's fine. Just create one more for NOXATRADING.",
    ].join('\n'),
  )

  await pause(500)
  await typing(ctx, 500)
  await ctx.reply(
    'When that account is created, tap below 👇',
    signupDoneKeyboard(),
  )
})

iqSignupHelpScene.action('IQ_SIGNUP_DONE', async (ctx) => {
  await ctx.answerCbQuery('Perfect 👌')
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  // Wipe any stale IQ session/credentials carried over from a prior
  // signup attempt. The account they just created has its own iqUserId,
  // and if we let an old session resume, isPartnerVerified would see
  // iq_trader_id (postback for the new account) != iqUserId (from
  // resumed session of the old account) and bounce them into
  // NON_PARTNER_REJECT. Forcing them through LOGIN_EMAIL guarantees the
  // SDK session matches the postback-confirmed account.
  const user = await ensureUser(ctx)
  const telegramId = BigInt(user.telegram_id)
  await invalidateCachedClient(telegramId).catch(() => {})
  await userRepo.clearIqSession(telegramId).catch(() => {})
  await userRepo.clearIqCredentials(telegramId).catch(() => {})
  await mergeFlowData(ctx, { iqAccountConfirmed: true })
  await transitionAfterEvent(ctx, { type: 'IQ_SIGNUP_DONE' })
})
