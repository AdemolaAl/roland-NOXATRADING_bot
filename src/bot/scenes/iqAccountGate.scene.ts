import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { iqAccountGateKeyboard } from '../keyboards/inline.js'
import { replyWithMoneyGbtImage } from '../media.js'
import { typing } from './_uxHelpers.js'

export const iqAccountGateScene = new Scenes.BaseScene<BotContext>('IQ_ACCOUNT_GATE')

iqAccountGateScene.enter(async (ctx) => {
  await typing(ctx, 700)
  await replyWithMoneyGbtImage(
    ctx,
    '11-connect-account.jpg',
    [
      '*Unlock your IQ Option account first.*',
      '',
      'Every user must create a fresh IQ Option account under our partner flow.',
      'Signup takes about 60 seconds.',
      '',
      'Tap below and I will generate your tracked signup link 👇',
    ].join('\n'),
    { parse_mode: 'Markdown', ...iqAccountGateKeyboard() },
  )
})

// NOTE: the 'IQ_CREATE_ACCOUNT' tap is handled by a GLOBAL bot.action in
// src/bot/index.ts, not here. A scene-bound handler silently died whenever
// sceneRehydrateMw had moved the user's in-memory scene off IQ_ACCOUNT_GATE
// before stage.middleware dispatched the tap (bot restart, a flow_data write
// that dropped requestedTier, or a stale button from old chat history) — the
// user just saw the Telegram spinner time out. The global handler fires
// regardless of which scene the rehydrate landed them in.
