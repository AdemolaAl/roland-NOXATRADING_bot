import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { executeProTradeScene } from './_sceneHelpers.js'

export const tradeExecutingProScene = new Scenes.BaseScene<BotContext>('TRADE_EXECUTING_PRO')

tradeExecutingProScene.enter(async (ctx) => {
  await executeProTradeScene(ctx)
})
