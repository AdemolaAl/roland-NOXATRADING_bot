import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { restartOnboardingKeyboard } from '../keyboards/inline.js'
import { transitionAfterEvent } from './_bridge.js'
import { typing } from './_uxHelpers.js'
import { userRepo } from '../../core/repositories/index.js'

export const nonPartnerRejectScene = new Scenes.BaseScene<BotContext>('NON_PARTNER_REJECT')

nonPartnerRejectScene.enter(async (ctx) => {
  // Persist the lockout so the new routing function sees this user
  // as terminal regardless of which scene they end up in next.
  // Idempotent at the repo layer.
  if (ctx.from) {
    await userRepo.markLockout(BigInt(ctx.from.id), 'non_partner').catch((err) => {
      ctx.logger?.warn(
        { err, event: 'lockout_mark_failed', telegramId: ctx.from!.id.toString() },
        'failed to mark lockout_reason=non_partner',
      )
    })
  }
  await typing(ctx, 500)
  await ctx.reply(
    [
      "❌ *That IQ Option account isn't under our partner flow.*",
      '',
      'Create a fresh IQ Option account through the bot signup flow, then continue from there.',
    ].join('\n'),
    { parse_mode: 'Markdown', ...restartOnboardingKeyboard() },
  )
})

nonPartnerRejectScene.action('NPR_RESTART', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  // RESTART is the user's escape hatch. Clear the lockout column so
  // achievement-based routing lets them through (their underlying
  // achievement columns are still set — iq_account_confirmed_at etc.
  // — so they may need admin action to actually re-do signup with a
  // fresh trader_id; the deeper journey reset is admin tooling in
  // Phase 4. This change at least unblocks WELCOME → IQ_ACCOUNT_GATE
  // navigation.
  if (ctx.from) {
    await userRepo.clearLockout(BigInt(ctx.from.id)).catch(() => {})
  }
  await transitionAfterEvent(ctx, { type: 'NPR_RESTART' }, {
    flowDataPatch: {},
    replaceFlowData: true,
  })
})
