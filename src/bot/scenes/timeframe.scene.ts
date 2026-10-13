import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { timeframeKeyboard } from '../keyboards/inline.js'
import { userRepo } from '../../core/repositories/index.js'
import { ensureUser, transitionAfterEvent } from './_bridge.js'
import { replyWithMoneyGbtImage } from '../media.js'
import { typing } from './_uxHelpers.js'

export const timeframeScene = new Scenes.BaseScene<BotContext>('TIMEFRAME')

timeframeScene.enter(async (ctx) => {
  await typing(ctx, 450)
  await replyWithMoneyGbtImage(
    ctx,
    '07-set-timeframe.jpg',
    [
      '*Pick your expiry timeframe* 👇',
      '',
      '⏱  Faster timeframes settle quicker.',
      '🐢  Longer timeframes ride bigger moves.',
    ].join('\n'),
    { parse_mode: 'Markdown', ...timeframeKeyboard() },
  )
})

for (const tf of ['30s', '1m', '2m', '5m'] as const) {
  timeframeScene.action(`TIMEFRAME_${tf}`, async (ctx) => {
    await ctx.answerCbQuery(`⏱ ${tf}`)
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    // Instant feedback so the user sees a reply within ~200ms — without
    // this, earlyAckMw clears the spinner and the next outbound message
    // (the pair-selection photo) can be 30+ sec out under per-chat rate
    // limits, leaving the user staring at a stripped keyboard.
    await ctx.reply(`⏱ ${tf} locked in — picking your top pairs…`).catch(() => {})
    const user = await ensureUser(ctx)
    await userRepo.setTimeframe(BigInt(user.telegram_id), tf)
    await transitionAfterEvent(ctx, { type: 'TIMEFRAME_PICKED', timeframe: tf }, {
      flowDataPatch: { timeframe: tf },
    })
  })
}
