import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { mainMenuKeyboard } from '../keyboards/reply.js'
import { ensureUser, transitionAfterEvent } from './_bridge.js'
import { getLogger } from '../../infra/logger.js'
import { pause, typing } from './_uxHelpers.js'
import { whereShouldUserBe } from '../../core/services/userJourney.js'

export const loginEmailScene = new Scenes.BaseScene<BotContext>('LOGIN_EMAIL')

async function promptEmail(ctx: BotContext) {
  await typing(ctx, 900)
  await ctx.reply(
    [
      '✅ Account detected.',
      '',
      "Now let's connect NOXATRADING to your account.",
      '',
      'Enter your *IQ Option login details* below 👇',
      '',
      "🔒 100% secure. We use IQ Option's official API — your details are encrypted and never seen by us.",
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
  await pause(500)
  await typing(ctx, 500)
  await ctx.reply('Drop your IQ Option email 👇', mainMenuKeyboard())
}

loginEmailScene.enter(async (ctx) => {
  const user = await ensureUser(ctx)
  const target = whereShouldUserBe(user)
  // Achievement-derived redirect. Replaces the old
  // `flow.iqAccountConfirmed` defensive bounce that produced the
  // "asked to register twice" bug — that check used a flow_data
  // flag that lagged behind the Affstore postback. The new function
  // accepts either signal (column OR flow_data) so a fast user
  // doesn't get punted back to the gate. Don't update flow_stage on
  // the redirect — let the destination scene's first user action do
  // it. (Avoids a race where two updates write conflicting stages.)
  if (target !== 'LOGIN_EMAIL') {
    getLogger().info(
      { event: 'gate_redirect', from: 'LOGIN_EMAIL', to: target, telegramId: user.telegram_id },
      'LOGIN_EMAIL redirected by achievement state',
    )
    await ctx.scene.enter(target)
    return
  }
  await promptEmail(ctx)
})

loginEmailScene.on('text', async (ctx) => {
  const user = await ensureUser(ctx)
  const target = whereShouldUserBe(user)
  if (target !== 'LOGIN_EMAIL') {
    await ctx.scene.enter(target)
    return
  }

  const email = ctx.message.text.trim()
  if (!email.includes('@') || email.length < 5) {
    await ctx.reply("That doesn't look like a valid email.\nTry again 👇")
    return
  }

  await transitionAfterEvent(ctx, { type: 'EMAIL_PROVIDED' }, {
    flowDataPatch: { email },
  })
})
