import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { DEMO_MAX_STAKE, amountKeyboard, mainMenuKeyboard } from '../keyboards/reply.js'
import { userRepo } from '../../core/repositories/index.js'
import { ensureUser, transitionAfterEvent } from './_bridge.js'
import { promptAmount } from './_sceneHelpers.js'

function parseStake(text: string): number | null {
  if (text === 'Custom') {
    return null
  }
  const normalized = Number(text.replace(/[^0-9.]/g, ''))
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null
}

// Persist to the users.base_stake column so the trade executor sees it.
async function persistStake(ctx: BotContext, stake: number): Promise<void> {
  const user = await ensureUser(ctx)
  await userRepo.setBaseStake(BigInt(user.telegram_id), stake)
}

export const amountScene = new Scenes.BaseScene<BotContext>('AMOUNT')
export const amountCustomScene = new Scenes.BaseScene<BotContext>('AMOUNT_CUSTOM')
export const amountProScene = new Scenes.BaseScene<BotContext>('AMOUNT_PRO')

amountScene.enter(async (ctx) => {
  await promptAmount(ctx)
})

amountProScene.enter(async (ctx) => {
  await promptAmount(ctx)
})

amountScene.on('text', async (ctx) => {
  const user = await ensureUser(ctx)
  const stake = parseStake(ctx.message.text)
  if (stake === null && ctx.message.text === 'Custom') {
    if (user.account_mode === 'demo') {
      // Demo has no Custom button — but if a stale keyboard somehow sends
      // Custom, gently steer them back to the preset grid.
      await ctx.reply(
        `On demo the max stake is *$${DEMO_MAX_STAKE}* — pick from the buttons below 👇`,
        { parse_mode: 'Markdown', ...amountKeyboard('demo') },
      )
      return
    }
    await transitionAfterEvent(ctx, { type: 'AMOUNT_CUSTOM_REQUESTED' })
    return
  }
  if (!stake) {
    await ctx.reply('Choose a valid amount.', amountKeyboard(user.account_mode))
    return
  }
  if (user.account_mode === 'demo' && stake > DEMO_MAX_STAKE) {
    await ctx.reply(
      `Demo stake is capped at *$${DEMO_MAX_STAKE}*. Pick a smaller amount 👇`,
      { parse_mode: 'Markdown', ...amountKeyboard('demo') },
    )
    return
  }
  await persistStake(ctx, stake)
  await transitionAfterEvent(ctx, { type: 'AMOUNT_PICKED' }, {
    flowDataPatch: { baseStake: stake },
  })
})

amountProScene.on('text', async (ctx) => {
  const user = await ensureUser(ctx)
  const stake = parseStake(ctx.message.text)
  if (!stake) {
    await ctx.reply('Choose a valid amount.', amountKeyboard(user.account_mode))
    return
  }
  if (user.account_mode === 'demo' && stake > DEMO_MAX_STAKE) {
    await ctx.reply(
      `Demo stake is capped at *$${DEMO_MAX_STAKE}*. Pick a smaller amount 👇`,
      { parse_mode: 'Markdown', ...amountKeyboard('demo') },
    )
    return
  }
  await persistStake(ctx, stake)
  await transitionAfterEvent(ctx, { type: 'AMOUNT_PICKED' }, {
    flowDataPatch: { baseStake: stake },
  })
})

amountCustomScene.enter(async (ctx) => {
  await ctx.reply('Send your custom stake as a number.', mainMenuKeyboard())
})

amountCustomScene.on('text', async (ctx) => {
  const user = await ensureUser(ctx)
  const stake = Number(ctx.message.text)
  if (!Number.isFinite(stake) || stake <= 0) {
    await ctx.reply('Send a positive number.')
    return
  }
  if (user.account_mode === 'demo' && stake > DEMO_MAX_STAKE) {
    await ctx.reply(`Demo stake is capped at *$${DEMO_MAX_STAKE}*. Send a smaller number.`, {
      parse_mode: 'Markdown',
    })
    return
  }
  await persistStake(ctx, stake)
  await transitionAfterEvent(ctx, { type: 'CUSTOM_AMOUNT_PROVIDED' }, {
    flowDataPatch: { baseStake: stake },
  })
})
