import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { mainMenuKeyboard } from '../keyboards/reply.js'
import { transitionAfterEvent } from './_bridge.js'
import { pause, typing } from './_uxHelpers.js'

export const loginPasswordScene = new Scenes.BaseScene<BotContext>('LOGIN_PASSWORD')

loginPasswordScene.enter(async (ctx) => {
  await typing(ctx, 400)
  await ctx.reply(
    [
      '🛡️ *Your password is safe*',
      '',
      'We use the official IQ Option API.',
      'Your details are encrypted and never seen by us.',
      'Your message auto-deletes from this chat in 10 seconds.',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
  await pause(400)
  await typing(ctx, 400)
  await ctx.reply('Now your password 👇', mainMenuKeyboard())
})

loginPasswordScene.on('text', async (ctx) => {
  const password = ctx.message.text
  // Schedule auto-delete of the user's password message after 10s.
  // Telegram requires bot admin in groups; in private chat the bot can
  // delete its own messages and ones it received from the user.
  const chatId = ctx.chat?.id
  const messageId = ctx.message.message_id
  if (chatId) {
    setTimeout(() => {
      ctx.telegram.deleteMessage(chatId, messageId).catch(() => {})
    }, 10_000)
  }
  await transitionAfterEvent(ctx, { type: 'PASSWORD_PROVIDED' }, {
    flowDataPatch: { password },
  })
})
