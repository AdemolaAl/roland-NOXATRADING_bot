import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { depositGateKeyboard } from '../keyboards/inline.js'
import { MIN_BALANCE_AUTO, MIN_BALANCE_PRO } from '../../core/services/tierService.js'
import { ensureUser, getUserFlowData, transitionAfterEvent } from './_bridge.js'
import { pause, typing } from './_uxHelpers.js'
import { refreshUserBalance } from './_sceneHelpers.js'
import { attemptDepositActivation } from '../depositActivation.js'
import { cancelDepositPoll, scheduleDepositPoll } from '../../jobs/depositPoll.js'
import { getLogger } from '../../infra/logger.js'
import { whereShouldUserBe } from '../../core/services/userJourney.js'

const log = getLogger().child({ module: 'depositGate' })
const DEPOSIT_URL = 'https://iqoption.com/pwa/payments/deposit/en/counting?promocode=NOXA100'

function requestedTier(flow: Record<string, unknown>): 'auto' | 'pro' {
  return String(flow.requestedTier ?? '') === 'pro' ? 'pro' : 'auto'
}

async function notifyConfirmed(ctx: BotContext, tier: 'auto' | 'pro', totalDeposits: number) {
  await ctx.reply(
    [
      tier === 'pro' ? '💎 *PRO activated.*' : '🔥 *AUTO activated.*',
      '',
      `Deposit confirmed: *$${totalDeposits.toFixed(2)}*`,
      '',
      'Your live setup is unlocked. Next step: choose your account and timeframe 👇',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
}

export const depositGateScene = new Scenes.BaseScene<BotContext>('DEPOSIT_GATE')

depositGateScene.enter(async (ctx) => {
  const user = await ensureUser(ctx)
  // Short-circuit if achievement state says we shouldn't be here.
  // Catches: users who've already deposited (first_deposit_at set),
  // demo-path users (requiresDeposit returns false → derivation
  // returns HOME), and any earlier-gate users who somehow landed
  // here (e.g. stale inline keyboard tap from before the deploy).
  const target = whereShouldUserBe(user)
  if (target !== 'DEPOSIT_GATE') {
    log.info(
      { event: 'gate_redirect', from: 'DEPOSIT_GATE', to: target, telegramId: user.telegram_id },
      'DEPOSIT_GATE redirected by achievement state',
    )
    await ctx.scene.enter(target)
    return
  }
  const flow = await getUserFlowData(ctx)
  const tier = requestedTier(flow)
  const min = tier === 'pro' ? MIN_BALANCE_PRO : MIN_BALANCE_AUTO
  const telegramId = BigInt(user.telegram_id)

  let balance = Number(user.iq_balance_cached ?? 0)
  try {
    balance = await refreshUserBalance(telegramId, 'live')
  } catch {
    balance = Number(user.iq_balance_cached ?? 0)
  }

  if (balance >= min) {
    await transitionAfterEvent(
      ctx,
      tier === 'pro' ? { type: 'DEPOSIT_CONFIRMED_PRO' } : { type: 'DEPOSIT_CONFIRMED_AUTO' },
    )
    return
  }

  const gap = (min - balance).toFixed(2)

  await scheduleDepositPoll(telegramId).catch((err) => {
    log.warn(
      { err, telegramId: user.telegram_id, event: 'deposit_poll_schedule_failed' },
      'failed to arm deposit poll on gate entry',
    )
  })

  await typing(ctx, 800)
  if (tier === 'pro') {
    await ctx.reply(
      [
        'You chose the best mode 💎',
        '',
        'PRO unlocks everything — multiple markets firing at once, priority signals first, full capacity.',
        '',
        `Current live balance: *$${balance.toFixed(2)}*`,
        `Still needed to activate: *$${gap}*`,
        '',
        'Higher is always better — the more NOXATRADING has to work with, the stronger the results.',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
    await pause(700)
    await typing(ctx, 700)
    await ctx.reply(
      [
        'This is the mode our top earners run.',
        'Multiple pairs. Priority queue. Maximum output.',
        '',
        'Make your deposit — PRO activates automatically 👇',
      ].join('\n'),
      depositGateKeyboard({ requestedTier: tier, depositUrl: DEPOSIT_URL }),
    )
    return
  }

  await ctx.reply(
    [
      'Almost there 🔥',
      '',
      'To activate your live setup, make a deposit into your IQ Option account.',
      "Once it's in, NOXATRADING goes live and starts trading automatically.",
      '',
      `Current live balance: *$${balance.toFixed(2)}*`,
      `Still needed to start: *$${gap}*`,
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
  await pause(700)
  await typing(ctx, 700)
  await ctx.reply(
    [
      'One more thing before you deposit —',
      '',
      'Use coupon code *NOXA100* when depositing *$100 or more* and IQ Option adds a *100% bonus* to your account.',
      '',
      '$100 deposit = $200 trading balance · $200 deposit = $400 trading balance',
      '',
      'The bigger your balance, the more NOXATRADING has to work with — better results overall.',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
  await pause(700)
  await typing(ctx, 700)
  await ctx.reply(
    [
      `Starting with $${min}? That's fine — the bot works at every level.`,
      "You can top up anytime and use the coupon when you're ready.",
      '',
      'Make your deposit now 👇',
    ].join('\n'),
    depositGateKeyboard({ requestedTier: tier, depositUrl: DEPOSIT_URL }),
  )
})

depositGateScene.action('DEPOSIT_DONE', async (ctx) => {
  await ctx.answerCbQuery('Checking deposit…')
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  const user = await ensureUser(ctx)
  const result = await attemptDepositActivation(BigInt(user.telegram_id))

  if (result.kind === 'confirmed') {
    await cancelDepositPoll(BigInt(user.telegram_id)).catch(() => {})
    await notifyConfirmed(ctx, result.tier, result.totalDeposits)
    await ctx.scene.enter(result.nextStage)
    return
  }

  if (result.kind === 'wrong_affiliate') {
    await ctx.scene.enter('NON_PARTNER_REJECT')
    return
  }

  if (result.kind === 'below_min') {
    await ctx.reply(
      [
        `✅ Deposit detected: *$${result.totalDeposits.toFixed(2)}*`,
        '',
        `You still need *$${result.deficit.toFixed(2)}* more to clear the *$${result.minRequired}* minimum.`,
        '',
        'Top up and tap the same button again. Background checks are still running.',
      ].join('\n'),
      { parse_mode: 'Markdown', ...depositGateKeyboard({ requestedTier: requestedTier(await getUserFlowData(ctx)), depositUrl: DEPOSIT_URL }) },
    )
    return
  }

  await ctx.reply(
    [
      "I still can't confirm the deposit yet.",
      '',
      'Finish the deposit in IQ Option, wait a moment, then tap the confirmation button again.',
    ].join('\n'),
    depositGateKeyboard({ requestedTier: requestedTier(await getUserFlowData(ctx)), depositUrl: DEPOSIT_URL }),
  )
})
