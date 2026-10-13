import { Markup, Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { transitionAfterEvent } from './_bridge.js'
import { typing } from './_uxHelpers.js'
import { userRepo } from '../../core/repositories/index.js'

const SUPPORT_HANDLE = '@rolandsupport1'
const SUPPORT_URL = 'https://t.me/rolandsupport1'

export const supportHandoffScene = new Scenes.BaseScene<BotContext>('SUPPORT_HANDOFF')

supportHandoffScene.enter(async (ctx) => {
  // Persist the lockout so the new routing function recognises this
  // user as terminal — they hit too many failed login attempts and
  // are blocked until support intervenes.
  if (ctx.from) {
    await userRepo.markLockout(BigInt(ctx.from.id), 'support_handoff').catch((err) => {
      ctx.logger?.warn(
        { err, event: 'lockout_mark_failed', telegramId: ctx.from!.id.toString() },
        'failed to mark lockout_reason=support_handoff',
      )
    })
  }
  await typing(ctx, 500)
  await ctx.reply(
    [
      '⚠️ *Too many failed login attempts.*',
      '',
      `Message support: ${SUPPORT_HANDLE}`,
      SUPPORT_URL,
      '',
      'Once support helps you fix the login details, restart the flow below.',
      '',
      'Or wipe your account entirely and start from scratch.',
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      // NPR_RESTART resumes the existing account; SELF_DELETE (global
      // bot.action) erases it after a Confirm/Cancel step.
      ...Markup.inlineKeyboard([
        [Markup.button.callback('↺  Start over', 'NPR_RESTART')],
        [Markup.button.callback('🗑  Delete account & start over', 'SELF_DELETE')],
      ]),
    },
  )
})

supportHandoffScene.action('NPR_RESTART', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  // Same escape-hatch reasoning as in nonPartnerReject.scene.ts:
  // clearLockout so achievement-based routing lets them retry the
  // login flow. Underlying iq_session_token was already cleared
  // upstream during the auth-failure path that led here.
  if (ctx.from) {
    await userRepo.clearLockout(BigInt(ctx.from.id)).catch(() => {})
  }
  await transitionAfterEvent(ctx, { type: 'NPR_RESTART' }, {
    flowDataPatch: {},
    replaceFlowData: true,
  })
})
