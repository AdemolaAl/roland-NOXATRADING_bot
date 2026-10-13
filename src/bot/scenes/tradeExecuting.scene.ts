import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { executeSingleTradeScene } from './_sceneHelpers.js'

export const tradeExecutingScene = new Scenes.BaseScene<BotContext>('TRADE_EXECUTING')

tradeExecutingScene.enter(async (ctx) => {
  await executeSingleTradeScene(ctx)
})
