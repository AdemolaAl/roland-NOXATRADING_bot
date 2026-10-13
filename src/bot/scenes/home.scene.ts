import { Markup, Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { tradeRepo, userRepo } from '../../core/repositories/index.js'
import { getLogger } from '../../infra/logger.js'
import { mediaInputFor } from '../media.js'
import { invalidateCachedClient } from '../../trading/iqSessionCache.js'
import { ensureUser } from './_bridge.js'
import { getCachedBalanceForUser, refreshUserBalanceInBackground } from './_sceneHelpers.js'
import { pause, typing } from './_uxHelpers.js'
import { whereShouldUserBe } from '../../core/services/userJourney.js'

// HOME is the main hub a logged-in user lands on after `/start`. Brand-new
// users go through WELCOME → onboarding instead; users mid-onboarding (no
// IQ session yet) keep resuming their flow_stage. HOME is only for fully
// onboarded users who tap /start to "open the bot".
export const homeScene = new Scenes.BaseScene<BotContext>('HOME')

function homeKeyboard(opts: {
  currentMode: 'demo' | 'live'
  canGoLive: boolean
  isPro: boolean
  tier: 'demo' | 'auto' | 'pro'
}) {
  // Row 3 pairs the mode-switch (only when not locked to demo) with an
  // upgrade shortcut (only when there's a higher tier to climb to). PRO
  // users see neither slot's right-half — that's fine, single-button rows
  // render cleanly in Telegram.
  const switchRow: ReturnType<typeof Markup.button.callback>[] = []
  if (opts.canGoLive) {
    const targetLabel = opts.currentMode === 'live' ? 'Switch to DEMO' : 'Switch to LIVE'
    const targetIcon = opts.currentMode === 'live' ? '🧪' : '🟢'
    switchRow.push(Markup.button.callback(`${targetIcon}  ${targetLabel}`, 'HOME_TOGGLE_MODE'))
  }
  if (!opts.isPro) {
    const upgradeLabel = opts.tier === 'demo' ? '⚡  Activate LIVE' : '⚡  Upgrade to PRO'
    switchRow.push(Markup.button.callback(upgradeLabel, 'HOME_UPGRADE'))
  }

  // Mixing callback + url buttons in the same keyboard means we can't
  // narrow rows to a single button type — let inference handle it via the
  // builder's accumulator.
  const tradeRow = [Markup.button.callback('🚀  Take a Trade', 'HOME_TRADE')]
  const infoRow = [
    Markup.button.callback('📜  History', 'HOME_HISTORY'),
    Markup.button.callback('📊  Stats', 'HOME_STATS'),
  ]
  const idHelpRow = [Markup.button.callback('🆔  How to get my IQ ID', 'HOME_HOW_GET_ID')]
  const helpRow = [
    Markup.button.callback('❓  Help & FAQ', 'HOME_HELP'),
    Markup.button.url('💬  Support', 'https://t.me/rolandsupport1'),
  ]

  return switchRow.length > 0
    ? Markup.inlineKeyboard([tradeRow, infoRow, switchRow, idHelpRow, helpRow])
    : Markup.inlineKeyboard([tradeRow, infoRow, idHelpRow, helpRow])
}

homeScene.enter(async (ctx) => {
  const user = await ensureUser(ctx)
  // HOME is for fully-onboarded users. If achievement state says
  // they're still missing a gate (e.g. landed here via a stale
  // inline keyboard or after session expiry wiped iq_session_token),
  // redirect downward. Prevents the HOME UI showing "Take a Trade"
  // for users who can't actually trade.
  const target = whereShouldUserBe(user)
  if (target !== 'HOME') {
    getLogger().info(
      { event: 'gate_redirect', from: 'HOME', to: target, telegramId: user.telegram_id },
      'HOME redirected by achievement state',
    )
    await ctx.scene.enter(target)
    return
  }
  const stats = await tradeRepo.aggregatesForUser(BigInt(user.telegram_id))
  const net = Number(stats.net_pnl)
  const sign = net >= 0 ? '+' : ''
  const modeLabel = user.account_mode === 'live' ? 'LIVE' : 'Demo'
  const tierBadge =
    user.tier === 'pro' ? '⚡ PRO' : user.tier === 'auto' ? '🚀 AUTO' : '🧪 Demo'
  const telegramId = BigInt(user.telegram_id)
  const balance = await getCachedBalanceForUser(telegramId)

  const canGoLive = user.tier !== 'demo' && user.status !== 'force_demo'

  await typing(ctx, 500)
  const sent = await ctx.reply(
    [
      `*NOXATRADING — Home*`,
      '',
      `Tier: *${tierBadge}*  ·  Mode: *${modeLabel}*`,
      `Balance: *$${balance.toFixed(2)}*`,
      `Session: *${stats.total_trades}* trades  ·  *${sign}$${net.toFixed(2)}*`,
      '',
      'What now? 👇',
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      ...homeKeyboard({
        currentMode: user.account_mode,
        canGoLive,
        isPro: user.tier === 'pro',
        tier: user.tier,
      }),
    },
  )

  refreshUserBalanceInBackground(telegramId, user.account_mode, async (freshBalance) => {
    if (Math.abs(freshBalance - balance) < 0.01) return
    await ctx.telegram
      .editMessageText(
        sent.chat.id,
        sent.message_id,
        undefined,
        [
          `*NOXATRADING — Home*`,
          '',
          `Tier: *${tierBadge}*  ·  Mode: *${modeLabel}*`,
          `Balance: *$${freshBalance.toFixed(2)}*`,
          `Session: *${stats.total_trades}* trades  ·  *${sign}$${net.toFixed(2)}*`,
          '',
          'What now? 👇',
        ].join('\n'),
        {
          parse_mode: 'Markdown',
          ...homeKeyboard({
            currentMode: user.account_mode,
            canGoLive,
            isPro: user.tier === 'pro',
            tier: user.tier,
          }),
        },
      )
      .catch(() => {})
  })
})

homeScene.action('HOME_TRADE', async (ctx) => {
  await ctx.answerCbQuery('Loading signal ⚡')
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  // Persist flow_stage='TIMEFRAME' so the state machine starts from
  // TIMEFRAME when the user picks an expiry. Without this, applyEvent
  // resolves from a stale stage (HOME or POST_TRADE_MENU) where the
  // TIMEFRAME_PICKED event has no transition → result.changed=false →
  // ctx.scene.enter('PAIR_SELECTION') never fires → user is stuck.
  if (ctx.from) {
    const user = await ensureUser(ctx)
    await userRepo.updateFlowStage(BigInt(user.telegram_id), 'TIMEFRAME', user.flow_data ?? {})
  }
  await ctx.scene.enter('TIMEFRAME')
})

homeScene.action('HOME_STATS', async (ctx) => {
  await ctx.answerCbQuery()
  if (ctx.from) {
    const user = await ensureUser(ctx)
    await userRepo.updateFlowStage(BigInt(user.telegram_id), 'STATS_VIEW', user.flow_data ?? {})
  }
  await ctx.scene.enter('STATS_VIEW')
})

// Direct toggle — no scene transition. Updates account_mode in DB and
// re-renders HOME with the new mode + freshly pulled balance.
export async function handleHomeToggleMode(ctx: BotContext): Promise<void> {
  if (!ctx.from) return
  const user = await ensureUser(ctx)
  const telegramId = BigInt(user.telegram_id)

  if (user.tier === 'demo' || user.status === 'force_demo') {
    await ctx.answerCbQuery('Live trading is locked for this account', { show_alert: true })
    return
  }

  const target = user.account_mode === 'live' ? 'demo' : 'live'
  await userRepo.setAccountMode(telegramId, target)
  // ctx.state.currentUser is the per-update cached row from activityMw.
  // Without this mutation the immediate scene re-enter renders the keyboard
  // from the pre-toggle mode, so the button label appears not to flip and
  // users tap repeatedly.
  if (ctx.state.currentUser) {
    ctx.state.currentUser.account_mode = target
  }
  // Drop the cached IQ client so the next trade rebuilds the SDK session
  // with the new mode via a fresh resumeSession. setAccountMode on the
  // cached client only flips a local label — relying on it leaves any
  // mode-bound SDK state stale.
  await invalidateCachedClient(telegramId)
  getLogger().info(
    { event: 'home_toggle_mode', telegramId: user.telegram_id, from: user.account_mode, to: target },
    'user toggled account mode',
  )
  await ctx.answerCbQuery(target === 'live' ? 'Switched to LIVE 💸' : 'Switched to Demo 🧪')
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  await pause(200)
  await ctx.scene.enter('HOME')
}

homeScene.action('HOME_TOGGLE_MODE', handleHomeToggleMode)

homeScene.action('HOME_HISTORY', async (ctx) => {
  await ctx.answerCbQuery()
  if (ctx.from) {
    const user = await ensureUser(ctx)
    await userRepo.updateFlowStage(BigInt(user.telegram_id), 'HOME_HISTORY', user.flow_data ?? {})
  }
  await ctx.scene.enter('HOME_HISTORY')
})

homeScene.action('HOME_HOW_GET_ID', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.replyWithPhoto(
    mediaInputFor('how to get id.jpg'),
    {
      caption: [
        '*How to find your IQ Option account ID*',
        '',
        '1️⃣  Open IQ Option (app or web).',
        '2️⃣  Tap your profile in the *top-left corner*.',
        '3️⃣  Your *account ID* shows right under your name.',
        '',
        'Copy it and paste it back here when asked.',
      ].join('\n'),
      parse_mode: 'Markdown',
    },
  )
})

homeScene.action('HOME_HELP', async (ctx) => {
  await ctx.answerCbQuery()
  if (ctx.from) {
    const user = await ensureUser(ctx)
    await userRepo.updateFlowStage(BigInt(user.telegram_id), 'HELP_FAQ', user.flow_data ?? {})
  }
  await ctx.scene.enter('HELP_FAQ')
})

// Shortcut into the deposit gate. Demo users use it to unlock AUTO, AUTO
// users use it to unlock PRO. PRO users never see the button.
homeScene.action('HOME_UPGRADE', async (ctx) => {
  await ctx.answerCbQuery()
  const user = await ensureUser(ctx)
  const nextFlow = {
    ...(user.flow_data ?? {}),
    requestedTier: user.tier === 'auto' ? 'pro' : 'auto',
    desiredAccountMode: 'live',
  }
  await userRepo.updateFlowStage(BigInt(user.telegram_id), 'DEPOSIT_GATE', nextFlow)
  if (ctx.state.currentUser) {
    ctx.state.currentUser.flow_stage = 'DEPOSIT_GATE'
    ctx.state.currentUser.flow_data = nextFlow
  }
  await ctx.scene.enter('DEPOSIT_GATE')
})

homeScene.action('HOME_TOGGLE_NOTIFS', async (ctx) => {
  if (!ctx.from) return
  const user = await ensureUser(ctx)
  const telegramId = BigInt(user.telegram_id)
  if (user.nudges_paused_at) {
    await userRepo.resetNudgeState(telegramId)
    await ctx.answerCbQuery('Notifications resumed 🔔')
  } else {
    await userRepo.pauseNudges(telegramId)
    await ctx.answerCbQuery('Notifications paused 🔕')
  }
  await pause(200)
  // Re-render the home menu so the button label flips immediately.
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  await ctx.scene.enter('HOME')
})
