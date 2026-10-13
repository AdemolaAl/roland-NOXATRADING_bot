import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { parseSelectedPair, promptPairSelection } from './_sceneHelpers.js'
import { transitionAfterEvent } from './_bridge.js'

export const pairSelectionScene = new Scenes.BaseScene<BotContext>('PAIR_SELECTION')

pairSelectionScene.enter(async (ctx) => {
  await promptPairSelection(ctx)
})

pairSelectionScene.on('text', async (ctx) => {
  const pair = await parseSelectedPair(ctx, ctx.message.text)
  if (!pair) {
    await ctx.reply('Pick one of the listed pairs.')
    return
  }

  await transitionAfterEvent(ctx, { type: 'PAIR_PICKED' }, {
    flowDataPatch: { selectedPair: pair },
  })
})
