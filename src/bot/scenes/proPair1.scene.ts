import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { getUserFlowData, transitionAfterEvent } from './_bridge.js'
import { parseSelectedPair, promptPairSelection } from './_sceneHelpers.js'

export const proPair1Scene = new Scenes.BaseScene<BotContext>('PAIR_SELECT_PRO_1')
export const proPair2Scene = new Scenes.BaseScene<BotContext>('PAIR_SELECT_PRO_2')
export const proPair3Scene = new Scenes.BaseScene<BotContext>('PAIR_SELECT_PRO_3')

async function handleProPair(ctx: BotContext, eventType: 'PRO_PAIR_1_PICKED' | 'PRO_PAIR_2_PICKED' | 'PRO_PAIR_3_PICKED') {
  if (!('text' in ctx.message!)) {
    return
  }
  const pair = await parseSelectedPair(ctx, ctx.message.text)
  if (!pair) {
    await ctx.reply('Pick one of the listed pairs.')
    return
  }
  const flow = await getUserFlowData(ctx)
  const proPairs = [...(((flow.proPairs as typeof pair[] | undefined) ?? [])), pair]
  await transitionAfterEvent(ctx, { type: eventType }, {
    flowDataPatch: { proPairs },
  })
}

// Each PRO pair scene shows progress in the prompt header so users can
// tell they're on step 1/2/3 of selecting three pairs. Without this the
// three screens look identical and users thought the bot was looping.
proPair1Scene.enter(async (ctx) => {
  await promptPairSelection(ctx, 4, { proStep: 1 })
})
proPair2Scene.enter(async (ctx) => {
  await promptPairSelection(ctx, 4, { proStep: 2 })
})
proPair3Scene.enter(async (ctx) => {
  await promptPairSelection(ctx, 4, { proStep: 3 })
})

proPair1Scene.on('text', async (ctx) => handleProPair(ctx, 'PRO_PAIR_1_PICKED'))
proPair2Scene.on('text', async (ctx) => handleProPair(ctx, 'PRO_PAIR_2_PICKED'))
proPair3Scene.on('text', async (ctx) => handleProPair(ctx, 'PRO_PAIR_3_PICKED'))
