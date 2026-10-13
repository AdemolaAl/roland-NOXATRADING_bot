import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { transitionAfterEvent } from './_bridge.js'
import { enterWelcome, showTierPitch } from './_sceneHelpers.js'

export const welcomeScene = new Scenes.BaseScene<BotContext>('WELCOME')

welcomeScene.enter(async (ctx) => {
  await enterWelcome(ctx)
})

// Pass requestedTier / desiredAccountMode via flowDataPatch so applyEvent's
// batched updateStateAndFlow writes them atomically with the state-machine
// transition. The previous shape — manual updateFlowStage followed by
// transitionAfterEvent — wrote requestedTier to the DB but didn't refresh
// ctx.state.currentUser, so the subsequent applyEvent re-read the stale
// cached row and overwrote flow_data back to its pre-pick value, silently
// wiping requestedTier. That left whereShouldUserBe returning 'WELCOME' on
// the next click, sceneRehydrateMw redirected the user out of IQ_ACCOUNT_GATE,
// and their tap on "Create my IQ Option account" hit no handler.
welcomeScene.action('START_DEMO', async (ctx) => {
  await ctx.answerCbQuery('Demo mode 🧪')
  await showTierPitch(ctx, 'demo')
  await transitionAfterEvent(
    ctx,
    { type: 'PICKED_DEMO' },
    { flowDataPatch: { desiredAccountMode: 'demo', requestedTier: 'demo' } },
  )
})

welcomeScene.action('START_AUTO', async (ctx) => {
  await ctx.answerCbQuery('AUTO mode 🚀')
  await showTierPitch(ctx, 'auto')
  await transitionAfterEvent(
    ctx,
    { type: 'PICKED_AUTO' },
    { flowDataPatch: { desiredAccountMode: 'live', requestedTier: 'auto' } },
  )
})

welcomeScene.action('START_PRO', async (ctx) => {
  await ctx.answerCbQuery('PRO mode ⚡')
  await showTierPitch(ctx, 'pro')
  await transitionAfterEvent(
    ctx,
    { type: 'PICKED_PRO' },
    { flowDataPatch: { desiredAccountMode: 'live', requestedTier: 'pro' } },
  )
})
