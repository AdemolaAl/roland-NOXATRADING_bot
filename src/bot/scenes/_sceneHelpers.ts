import { decryptString, encryptString } from '../../core/services/encryption.js'
import {
  funnelRepo,
  systemStateRepo,
  tradeRepo,
  userRepo,
} from '../../core/repositories/index.js'
import type { UserRow } from '../../core/repositories/userRepo.js'
import { generatePairSelection, type PairWithRate } from '../../core/services/pairGenerator.js'
import { loadEnv } from '../../infra/env.js'
import { getLogger } from '../../infra/logger.js'
import { adoptClient, getCachedClient, invalidateCachedClient } from '../../trading/iqSessionCache.js'
import { IqClient, IqSessionExpiredError, isIqAuthFailedError } from '../../trading/iqClient.js'
import { getEgressIp } from '../../infra/egressIp.js'
import { sendAlert } from '../../infra/alerts.js'
import { executeGale, type GaleResult } from '../../trading/galeExecutor.js'
import { executeProBatch } from '../../trading/proCoordinator.js'
import { createGaleMessage } from '../messageBuilder.js'
import { mediaInputFor, replyWithHandoffImage, replyWithMoneyGbtImage } from '../media.js'
import type { BotContext } from '../index.js'
import {
  demoConversionKeyboard,
  openingModeKeyboard,
  postTradeKeyboard,
  proUpsellKeyboard,
} from '../keyboards/inline.js'
import {
  amountKeyboard,
  pairKeyboard,
} from '../keyboards/reply.js'
import {
  applyEventDetached,
  ensureUser,
  getUserFlowData,
  setFlowData,
  transitionAfterEvent,
} from './_bridge.js'
import { pause, revealStages, typing, typingTo } from './_uxHelpers.js'

type AbortedGaleResult = Extract<GaleResult, { outcome: 'aborted' }>

function formatTimeframe(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m`
}

function prettyPair(code: string): string {
  const match = /^([A-Z]{3})([A-Z]{3})-OTC$/i.exec(code)
  if (match) return `${match[1]}/${match[2]} OTC`
  return code
}

export function friendlyAbortMessage(result: AbortedGaleResult): string {
  if (result.reason === 'system_paused') {
    return '⏸️ Trading is paused for maintenance.\nTry again in a minute.'
  }
  if (result.reason === 'insufficient_balance') {
    return '💸 Not enough balance for the next gale step.\nTop up your IQ Option account or pick a smaller stake next time.'
  }
  const err = result.error ?? ''
  const noMatch = /^no_matching_expiration:([^:]+):wanted=(\d+)s/.exec(err)
  if (noMatch) {
    const pair = prettyPair(noMatch[1]!)
    const seconds = Number(noMatch[2])
    return `⏱️ ${formatTimeframe(seconds)} isn't available for ${pair} right now.\nPick a different timeframe or pair and try again.`
  }
  if (err.startsWith('active_not_found:') || err.startsWith('instrument_unavailable:')) {
    const pair = prettyPair(err.split(':')[1] ?? 'this pair')
    return `🚫 ${pair} isn't tradable right now.\nPick a different pair.`
  }
  if (err.startsWith('balance_not_found:')) {
    return '🔌 Lost connection to your IQ account.\nTap /start to reconnect.'
  }
  if (err.startsWith('timeout_waiting_for_trade:')) {
    return '⌛ The broker took too long to confirm the trade.\nTry again in a moment.'
  }
  return "🔌 Couldn't reach the broker right now.\nTry again in a moment."
}

export async function enterWelcome(ctx: BotContext) {
  await typing(ctx, 1000)
  await replyWithHandoffImage(
    ctx,
    '13-watching.jpg',
    [
      "*I'm NOXATRADING.*",
      '',
      'The smartest auto-trading bot for IQ Option OTC pairs.',
      '',
      'I scan markets. I read signals. I place trades.',
      'You sit back and watch the wins land.',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
  await pause(900)
  await typing(ctx, 900)
  await ctx.reply(
    [
      '⚡ Built for serious traders.',
      '🎯 Trades 8+ OTC pairs.',
      '🛡️ Smart Gale recovery.',
      '💰 Withdraws straight to your own IQ Option account.',
    ].join('\n'),
  )
  await pause(1100)
  await typing(ctx, 1000)
  await replyWithMoneyGbtImage(
    ctx,
    '06-three-tiers.jpg',
    [
      '*Three ways to start*',
      '',
      '✅ The bot itself is free.',
      '',
      'What you fund is *your own* IQ Option trading capital.',
      'It stays in *your* account, you trade with it, you withdraw it.',
      '',
      '🧪 DEMO — try the bot risk-free',
      '🚀 AUTO — trade with $50+ capital',
      '⚡ PRO — trade with $500+ capital',
      '',
      'How are you starting? 👇',
    ].join('\n'),
    { parse_mode: 'Markdown', ...openingModeKeyboard() },
  )
}

export async function showTierPitch(
  ctx: BotContext,
  which: 'demo' | 'auto' | 'pro',
) {
  if (which === 'demo') {
    await pause(900)
    await typing(ctx, 900)
    await ctx.reply(
      [
        '🧪 *DEMO Mode*',
        '',
        "I'll trade your IQ Option DEMO balance only.",
        'Your real money stays untouched.',
        '',
        'This is the safest way to see NOXATRADING work.',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
    return
  }

  const minBalance = which === 'pro' ? '$500' : '$50'
  const tierLabel = which === 'pro' ? 'PRO' : 'AUTO'
  await pause(900)
  await typing(ctx, 900)
  await ctx.reply(
    [
      which === 'pro' ? '⚡ *PRO Mode*' : '🚀 *AUTO Mode*',
      '',
      `You'll need at least *${minBalance}* as trading capital in your IQ Option account.`,
      '',
      'This is *your* money.',
      'It stays in *your* account.',
      'You trade and withdraw it like normal.',
      '',
      `Once your funded balance clears the *${tierLabel}* minimum, the bot unlocks automatically.`,
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
}

// Silent re-auth failure monitor. Module-level state — bot restart
// resets it, which is fine: alerts are best-effort signals, not
// auditable counters. A run of transient re-auth failures (network
// / IQ-side issues, not stale credentials) usually means IQ has
// throttled or blocked our Railway egress IP. Redeploying rotates
// the IP and typically restores connectivity, so we surface the
// signal to the alert channel for an operator to action.
//
// THRESHOLD: 3 consecutive transient failures with no intervening
// successes. Small enough to catch real outages quickly, large
// enough to avoid false-positives on a single bad minute.
//
// COOLDOWN: 30 minutes between alerts. During a sustained block,
// every user hitting the bot would otherwise flood the channel
// with the same alert. The threshold + cooldown together produce
// one alert per outage event.
let consecutiveSilentReAuthTransientFailures = 0
let lastSilentReAuthAlertAt = 0
const SILENT_REAUTH_FAIL_THRESHOLD = 3
const SILENT_REAUTH_ALERT_COOLDOWN_MS = 30 * 60 * 1000

function noteSilentReAuthSuccess(): void {
  consecutiveSilentReAuthTransientFailures = 0
}

async function noteSilentReAuthTransientFailure(): Promise<void> {
  consecutiveSilentReAuthTransientFailures += 1
  const count = consecutiveSilentReAuthTransientFailures
  if (count < SILENT_REAUTH_FAIL_THRESHOLD) return

  const now = Date.now()
  const sinceLastAlert = now - lastSilentReAuthAlertAt
  if (sinceLastAlert < SILENT_REAUTH_ALERT_COOLDOWN_MS) {
    // Threshold met but we already alerted recently. Skip silently.
    return
  }
  lastSilentReAuthAlertAt = now

  const ip = getEgressIp()
  await sendAlert(
    [
      '🚨 *Silent re-auth failing repeatedly*',
      '',
      `*${count} consecutive transient failures* — none have recovered.`,
      ip ? `Current egress IP: \`${ip}\`` : 'Egress IP: _unknown (probe failed)_',
      '',
      'IQ Option is likely rate-limiting or blocking our IP.',
      '*Redeploy on Railway* to rotate the egress IP and restore connectivity.',
      '',
      '_Cooldown: 30 min before this alert fires again._',
    ].join('\n'),
  )
  getLogger().error(
    {
      event: 'silent_reauth_alert_sent',
      consecutiveFailures: count,
      egressIp: ip,
    },
    'silent re-auth threshold breached — alert posted to channel',
  )
}

// Silent re-authentication. Invoked when the SDK reports the cached
// session is no longer valid ("authentication is failed"). Reads the
// encrypted password stored at original login time, calls
// IqClient.login() to mint a fresh SSID, persists it, adopts the
// new client into the cache, and returns it — all transparently
// to the user, who never sees a "session expired" message or has
// to re-enter credentials.
//
// Returns null on three classes of failure:
//   1. No stored password (user predates this feature, or admin
//      cleared their credentials) → caller falls back to manual
//      re-login UX.
//   2. HTTP login returned "authentication is failed" → stored
//      password is stale (user changed it externally or account was
//      suspended). We wipe iq_password_encrypted so we don't retry
//      uselessly on the next request, and the caller surfaces the
//      manual-login UX.
//   3. Network / WS / decrypt error → transient. We keep the stored
//      password (might work next time) and let the caller decide
//      whether to retry or surface the friction.
async function attemptSilentReAuth(
  telegramId: bigint,
  accountMode: 'demo' | 'live',
): Promise<IqClient | null> {
  const user = await userRepo.findById(telegramId)
  if (!user?.iq_email || !user?.iq_password_encrypted) {
    return null
  }
  const env = loadEnv()
  let plaintextPassword: string
  try {
    plaintextPassword = decryptString(user.iq_password_encrypted, env.SESSION_ENCRYPTION_KEY)
  } catch (err) {
    // Encrypted blob corrupt or key rotated since storage. No way
    // to recover from here — treat as missing credentials so the
    // user gets the manual-login UX.
    getLogger().warn(
      { err, event: 'silent_reauth_decrypt_failed', telegramId: telegramId.toString() },
      'silent re-auth: stored password failed to decrypt',
    )
    return null
  }

  const startedAt = Date.now()
  const client = new IqClient()
  try {
    const result = await client.login(user.iq_email, plaintextPassword, telegramId)
    // Persist the fresh session. Password column is preserved via
    // COALESCE (we pass undefined, not the value) so we don't pay
    // an encryption round-trip we don't need.
    await userRepo.setIqSession(telegramId, {
      iqUserId: result.iqUserId,
      email: user.iq_email,
      encryptedToken: encryptString(result.sessionToken, env.SESSION_ENCRYPTION_KEY),
      expiresAt: result.sessionExpiresAt,
      balance: result.initialBalance.live,
      partnerCodeVerified: user.partner_code_verified,
    })
    // Align the SDK account mode with the user's persisted choice
    // before handing it to the cache — otherwise the first trade
    // after silent re-auth places against demo when the user is
    // in live (or vice-versa).
    await client.setAccountMode(accountMode)
    adoptClient(telegramId, client, accountMode)
    // Recovery resets the failure streak so a single succeeded
    // re-auth clears any pending alert state.
    noteSilentReAuthSuccess()
    getLogger().info(
      {
        event: 'silent_reauth_success',
        telegramId: telegramId.toString(),
        ms: Date.now() - startedAt,
        egressIp: getEgressIp(),
      },
      'silent re-auth succeeded — session refreshed transparently',
    )
    return client
  } catch (err) {
    if (err instanceof Error && err.message === 'authentication is failed') {
      // Stale password. Wipe so we don't retry on the next request
      // and bombard IQ with bad-credential attempts. NOT counted as
      // a transient failure — this is per-user, not an IP-block
      // signal, and shouldn't trigger the redeploy alert.
      await userRepo.clearIqCredentials(telegramId).catch(() => {})
      getLogger().info(
        { event: 'silent_reauth_creds_stale', telegramId: telegramId.toString() },
        'silent re-auth: HTTP login returned auth-failed, wiped stored password',
      )
      return null
    }
    // Network/transient. Keep credentials, let caller decide. Count
    // toward the consecutive-failure tally — a run of these usually
    // means IQ has rate-limited or blocked our egress IP and a
    // redeploy is needed.
    getLogger().warn(
      {
        err,
        event: 'silent_reauth_transient_fail',
        telegramId: telegramId.toString(),
        egressIp: getEgressIp(),
      },
      'silent re-auth failed transiently — stored password retained',
    )
    await noteSilentReAuthTransientFailure()
    return null
  }
}

export async function loadTradingClientForUser(telegramId: bigint) {
  const user = await userRepo.findById(telegramId)
  if (!user?.iq_session_token) {
    // Token-not-present is now a legitimate runtime state — the SDK
    // auth-failed catch below wipes the token mid-session, and users can
    // tap stale inline keyboards (HOME_TRADE etc.) that route them back
    // into trade scenes after the wipe. Throwing the typed error here
    // lets the existing trade-scene catch handlers run their recovery
    // UX (clear message + route to LOGIN_EMAIL) instead of bubbling a
    // plain Error into the global middleware handler as a silent fail.
    throw new IqSessionExpiredError(new Error('missing_iq_session'))
  }

  const startedAt = Date.now()
  const sessionToken = user.iq_session_token
  let client
  try {
    client = await getCachedClient(telegramId, user.account_mode, () => {
      const env = loadEnv()
      return decryptString(sessionToken, env.SESSION_ENCRYPTION_KEY)
    })
  } catch (err) {
    // IQ revoked the SSID server-side. Drop the dead client from
    // the cache, then try silent re-auth using the stored password
    // before surfacing the error to the user. If silent re-auth
    // succeeds the user never sees friction; if it fails we fall
    // back to the manual-login UX (clear session token + throw the
    // typed error that scene catches route on).
    if (isIqAuthFailedError(err)) {
      await invalidateCachedClient(telegramId).catch(() => {})

      const reAuthed = await attemptSilentReAuth(telegramId, user.account_mode)
      if (reAuthed) {
        // Refresh the user row to pick up the new session token
        // and return the re-authed client. From the caller's
        // perspective this loadTradingClientForUser call simply
        // succeeded — no error propagates, no UX change.
        const refreshedUser = (await userRepo.findById(telegramId)) ?? user
        return { client: reAuthed, user: refreshedUser }
      }

      // Silent re-auth was either skipped (no stored password) or
      // failed (stale credentials, network issue). Fall back to
      // the legacy clear-and-prompt path.
      await userRepo.clearIqSession(telegramId).catch((dbErr) => {
        getLogger().warn(
          { err: dbErr, telegramId: telegramId.toString(), event: 'iq_session_clear_failed' },
          'failed to wipe expired iq_session_token from DB',
        )
      })
      getLogger().info(
        { event: 'iq_session_expired', telegramId: telegramId.toString(), egressIp: getEgressIp() },
        'iq session rejected by SDK — silent re-auth unavailable, cache + DB token cleared',
      )
      throw new IqSessionExpiredError(err)
    }
    throw err
  }
  const elapsedMs = Date.now() - startedAt
  if (elapsedMs > 200) {
    getLogger().info(
      { event: 'iq_client_load_ms', ms: elapsedMs, telegramId: telegramId.toString() },
      'iq client load',
    )
  }
  return { client, user }
}

// Pulls the live balance for the requested mode from the IQ SDK and
// refreshes `users.iq_balance_cached`. Returns the live number so callers
// can render it without going through the DB again. If the SDK call fails
// (rate-limited, session expired, etc.), falls back to the cached value
// and logs the failure — never throws.
export async function refreshUserBalance(
  telegramId: bigint,
  mode: 'demo' | 'live',
): Promise<number> {
  try {
    const { client } = await loadTradingClientForUser(telegramId)
    const live = await client.getBalance(mode)
    await userRepo.setCachedBalance(telegramId, live)
    return live
  } catch (err) {
    // Drop the cached client so the next caller rebuilds it; cheap if the
    // session was already healthy, essential if it wasn't.
    await invalidateCachedClient(telegramId)
    getLogger().debug(
      { err, telegramId: telegramId.toString(), mode, event: 'balance_refresh_failed' },
      'balance refresh failed, returning cached',
    )
    const user = await userRepo.findById(telegramId)
    return Number(user?.iq_balance_cached ?? 0)
  }
}

export async function getCachedBalanceForUser(telegramId: bigint): Promise<number> {
  const user = await userRepo.findById(telegramId)
  return Number(user?.iq_balance_cached ?? 0)
}

export function refreshUserBalanceInBackground(
  telegramId: bigint,
  mode: 'demo' | 'live',
  onFresh?: (balance: number) => Promise<void> | void,
): void {
  void (async () => {
    try {
      const balance = await refreshUserBalance(telegramId, mode)
      await onFresh?.(balance)
    } catch (err) {
      getLogger().debug(
        { err, telegramId: telegramId.toString(), mode, event: 'balance_refresh_bg_failed' },
        'background balance refresh failed',
      )
    }
  })()
}

export async function finishLogin(
  telegramId: bigint,
  email: string,
  sessionToken: string,
  iqUserId: string,
  initialBalance: { demo: number; live: number },
  partnerCodeVerified: boolean,
  // Captured plaintext password — encrypted here and persisted so
  // future SDK auth-failed events can attempt silent re-auth instead
  // of pushing the user back to LOGIN_EMAIL. The plaintext stays
  // in-process for the encryptString call and is never written
  // anywhere unencrypted.
  password: string,
) {
  const env = loadEnv()
  await userRepo.setIqSession(telegramId, {
    iqUserId,
    email,
    encryptedToken: encryptString(sessionToken, env.SESSION_ENCRYPTION_KEY),
    encryptedPassword: encryptString(password, env.SESSION_ENCRYPTION_KEY),
    expiresAt: new Date(Date.now() + 3_600_000),
    balance: initialBalance.live,
    partnerCodeVerified,
  })
  await funnelRepo.record(telegramId, 'iq_connected')
}

export async function promptPairSelection(
  ctx: BotContext,
  count = 4,
  opts?: { proStep?: 1 | 2 | 3 },
): Promise<PairWithRate[]> {
  const pairs = generatePairSelection(count)
  await setFlowData(ctx, {
    ...(await getUserFlowData(ctx)),
    availablePairs: pairs,
  })

  // Single composite message: banner image with the full pair list as a
  // caption, the keyboard attached. This used to be 8 outbound calls
  // (banner + 4 reveal-stage edits + pair image + typing + keyboard reply).
  // Under viral load Telegram per-chat rate-limits the bot at ~1 msg/sec
  // and Telegraf was sleeping on retry_after for tens of seconds, so
  // users saw the timeframe button highlight then nothing else came up.
  //
  // PRO users pick three pairs across PAIR_SELECT_PRO_1/2/3, which
  // previously rendered identical screens — users thought the bot was
  // looping and gave up. The proStep header makes the progress explicit.
  const headerLine = opts?.proStep
    ? `🎯 *PRO trade — Pick pair ${opts.proStep} of 3*`
    : '*Top picks ready* 🎯'
  const ctaLine = opts?.proStep
    ? opts.proStep < 3
      ? `🚀 Pair ${opts.proStep} of 3 — choose below 👇`
      : '🚀 Final pair — choose below 👇'
    : '🚀 Make your choice below 👇'
  const caption = [
    headerLine,
    '',
    'Highest chance to win right now:',
    '',
    ...pairs.map((p, i) => {
      const icon = i === 0 ? '🏆' : '✅'
      return `${icon}  *${p.label}* — Win rate ≈*${p.winRate}%*`
    }),
    '',
    ctaLine,
  ].join('\n')

  try {
    await ctx.replyWithPhoto(
      mediaInputFor('03-select-pair.jpg'),
      {
        caption,
        parse_mode: 'Markdown',
        ...pairKeyboard(pairs),
      },
    )
  } catch (err) {
    const e = err as { code?: number; description?: string; parameters?: { retry_after?: number } }
    getLogger().warn(
      {
        err,
        telegramId: ctx.from?.id,
        event: 'pair_selection_photo_failed',
        tg_error_code: e?.code,
        tg_description: e?.description,
        tg_retry_after: e?.parameters?.retry_after,
      },
      'pair selection photo send failed; falling back to text',
    )
    await ctx.reply(caption, { parse_mode: 'Markdown', ...pairKeyboard(pairs) })
  }
  return pairs
}

export async function promptAmount(ctx: BotContext) {
  const user = await ensureUser(ctx)
  const flow = await getUserFlowData(ctx)
  const selected = flow.selectedPair as PairWithRate | undefined
  const mode = user.account_mode
  const modeNote =
    mode === 'demo'
      ? '_Demo capped at $20 per trade._'
      : '_Live — your real IQ Option capital._'
  await typing(ctx, 500)
  if (selected) {
    await ctx.reply(
      [
        `Selected: *${selected.label}*`,
        `Confidence: *${selected.winRate}%*`,
        '',
        'How much do you want to trade?',
        modeNote,
      ].join('\n'),
      { parse_mode: 'Markdown', ...amountKeyboard(mode) },
    )
    return
  }
  await ctx.reply('Choose your stake amount 👇', amountKeyboard(mode))
}

export async function parseSelectedPair(ctx: BotContext, text: string): Promise<PairWithRate | null> {
  const data = await getUserFlowData(ctx)
  const pairs = (data.availablePairs as PairWithRate[] | undefined) ?? []
  return pairs.find((pair) => text.includes(pair.label)) ?? null
}

// Post-trade UX, replicated for the detached-background path. The
// equivalent in-Telegraf flow is celebrationScene.enter ->
// CELEBRATION_DONE -> demoConversionScene/proUpsellScene/postTradeMenuScene.
// We can't call ctx.scene.enter from a detached promise (the Telegraf
// request context is gone), so each renderer below sends the same
// images/text/keyboards directly via the telegram client + chatId,
// and we walk the state machine ourselves with applyEventDetached so
// the user's next button tap (e.g. SWITCH_TO_LIVE) routes to the right
// scene's action handler via sceneRehydrateMw.

type TgClient = BotContext['telegram']

// Replicates celebrationScene.enter (WIN path).
//
// Image selection branches on recovery state because the framing of
// each win type is different:
//   - First-step win (winStep === 1):  19-profit-confirmed.jpg —
//     "PROFIT. CONFIRMED. Your account just grew. Withdraw anytime."
//   - Recovery win  (winStep > 1):     20-win-locked.jpg —
//     "PROFIT. Signal confirmed · Trade closed · Win locked."
// Using a single image for both used to produce cognitive dissonance:
// the previous 10-recovery.jpg ("COUNTER-STRIKE INITIATED · RECOVERY
// MODE") attached to a clean-first-step-win read as a contradiction.
async function renderCelebrationWin(
  telegram: TgClient,
  chatId: number,
  telegramId: bigint,
  result: { netProfit?: number; winStep?: number },
): Promise<void> {
  const profit = Number(result.netProfit ?? 0)
  const winStep = result.winStep ?? 1
  const isRecovery = winStep > 1
  await typingTo(telegram, chatId, 700)
  const caption = isRecovery
    ? [
        `🏆 *+$${profit.toFixed(2)}* added to your balance.`,
        '',
        `Recovery complete on step ${winStep}/6.`,
      ].join('\n')
    : [
        '🏆  *TRADE WON*',
        '',
        `*+$${profit.toFixed(2)}* added to your balance.`,
        'Clean first-step win — no recovery needed.',
      ].join('\n')
  await telegram
    .sendPhoto(
      chatId,
      mediaInputFor(isRecovery ? '20-win-locked.jpg' : '19-profit-confirmed.jpg'),
      { caption, parse_mode: 'Markdown' },
    )
    .catch(() => {})
  const stats = await tradeRepo.aggregatesForUser(telegramId)
  await pause(500)
  const net = Number(stats.net_pnl)
  await telegram
    .sendMessage(
      chatId,
      [
        '_Session_',
        `📊  Trades: *${stats.total_trades}*  ·  Net: *${net >= 0 ? '+' : ''}$${net.toFixed(2)}*`,
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
    .catch(() => {})
}

// Replicates celebrationScene.enter (LOSS path).
async function renderCelebrationLoss(
  telegram: TgClient,
  chatId: number,
  result: { cumulativeLoss?: number },
): Promise<void> {
  const loss = Number(result.cumulativeLoss ?? 0)
  await typingTo(telegram, chatId, 700)
  await telegram
    .sendMessage(
      chatId,
      [
        '🛑 *Trade closed*',
        '',
        `Net: *-$${loss.toFixed(2)}*`,
        '',
        'Pick another pair and run it back 👇',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
    .catch(() => {})
}

// Replicates celebrationProScene.enter.
async function renderCelebrationPro(
  telegram: TgClient,
  chatId: number,
  result: {
    totalProfit?: number
    positions?: Array<{ outcome?: string }>
  },
): Promise<void> {
  const total = Number(result.totalProfit ?? 0)
  const wins = result.positions?.filter((p) => p.outcome === 'win').length ?? 0
  const losses = result.positions?.filter((p) => p.outcome === 'loss').length ?? 0
  await typingTo(telegram, chatId, 700)
  await telegram
    .sendPhoto(
      chatId,
      mediaInputFor('16-upsell-pro.jpg'),
      {
        caption: [
          '⚡ *PRO batch complete*',
          '',
          `Net across 3 positions: *${total >= 0 ? '+' : ''}$${total.toFixed(2)}*`,
          `🏆  Wins: *${wins}*    💥  Losses: *${losses}*`,
        ].join('\n'),
        parse_mode: 'Markdown',
      },
    )
    .catch(() => {})
  await pause(500)
}

// Replicates demoConversionScene.enter — "what if this was real" upsell.
async function renderDemoConversion(
  telegram: TgClient,
  chatId: number,
  lastResult: { netProfit?: number },
): Promise<void> {
  const profit = Number(lastResult.netProfit ?? 0)
  await pause(500)
  await typingTo(telegram, chatId, 700)
  await telegram
    .sendMessage(
      chatId,
      [`💸 You just made *+$${profit.toFixed(2)}*`, 'In demo coins.'].join('\n'),
      { parse_mode: 'Markdown' },
    )
    .catch(() => {})
  await pause(400)
  await typingTo(telegram, chatId, 800)
  await telegram
    .sendPhoto(
      chatId,
      mediaInputFor('08-demo-vs-live.jpg'),
      { caption: '*WHAT IF THIS WAS REAL?*', parse_mode: 'Markdown' },
    )
    .catch(() => {})
  await pause(450)
  await typingTo(telegram, chatId, 700)
  await telegram
    .sendMessage(
      chatId,
      [
        'While you read this…',
        '',
        `real NOXATRADING users just banked *+$${profit.toFixed(2)}* CASH from the exact same setup.`,
        '',
        'Every minute on demo = real profit lost.',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
    .catch(() => {})
  await pause(450)
  await typingTo(telegram, chatId, 700)
  await telegram
    .sendPhoto(
      chatId,
      mediaInputFor('04-go-live.jpg'),
      {
        caption:
          '*Time to earn real money.*\nFund your IQ Option account, wins land in your bank, withdraw anytime.',
        parse_mode: 'Markdown',
      },
    )
    .catch(() => {})
  await pause(400)
  await typingTo(telegram, chatId, 450)
  await telegram
    .sendMessage(chatId, 'Switch to LIVE in 1 tap 👇', demoConversionKeyboard())
    .catch(() => {})
}

// Replicates proUpsellScene.enter — fifth-live-win PRO pitch.
async function renderProUpsell(
  telegram: TgClient,
  chatId: number,
  telegramId: bigint,
  lastResult: { netProfit?: number },
): Promise<void> {
  await funnelRepo.record(telegramId, 'pro_upsell_hit').catch(() => {})
  const profit = Number(lastResult.netProfit ?? 0)
  const tripled = profit * 3
  await pause(450)
  await typingTo(telegram, chatId, 700)
  await telegram
    .sendMessage(chatId, 'Do you know you can get *3x results* with PRO mode?', {
      parse_mode: 'Markdown',
    })
    .catch(() => {})
  await pause(400)
  await typingTo(telegram, chatId, 800)
  await telegram
    .sendPhoto(
      chatId,
      mediaInputFor('16-upsell-pro.jpg'),
      { caption: '⚡ *NOXATRADING PRO*', parse_mode: 'Markdown' },
    )
    .catch(() => {})
  await pause(500)
  await typingTo(telegram, chatId, 750)
  await telegram
    .sendMessage(
      chatId,
      [
        `That *$${profit.toFixed(2)}* you just made?`,
        '',
        `On PRO running 3 trades at once = *$${tripled.toFixed(2)}*.`,
        '',
        'Same skill. *3x* the money.',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
    .catch(() => {})
  await pause(400)
  await typingTo(telegram, chatId, 700)
  await telegram
    .sendPhoto(
      chatId,
      mediaInputFor('16-upsell-pro.jpg'),
      { caption: '*3 positions running in parallel*', parse_mode: 'Markdown' },
    )
    .catch(() => {})
  await pause(500)
  await typingTo(telegram, chatId, 550)
  await telegram
    .sendMessage(chatId, 'Plus drop any chart screenshot.\nGet instant AI analysis.')
    .catch(() => {})
  await pause(400)
  await typingTo(telegram, chatId, 700)
  await telegram
    .sendPhoto(
      chatId,
      mediaInputFor('09-scanning.jpg'),
      { caption: '📈 *Instant chart AI*', parse_mode: 'Markdown' },
    )
    .catch(() => {})
  await pause(500)
  await typingTo(telegram, chatId, 450)
  await telegram.sendMessage(chatId, 'Unlock PRO 👇', proUpsellKeyboard()).catch(() => {})
}

// Replicates postTradeMenuScene.enter — Take Another / View Stats / Stop.
async function renderPostTradeMenu(telegram: TgClient, chatId: number): Promise<void> {
  await typingTo(telegram, chatId, 450)
  await telegram
    .sendMessage(
      chatId,
      [
        '*Ready for the next trade?*',
        '',
        '👇  Take another signal, view stats, or pause for now.',
      ].join('\n'),
      { parse_mode: 'Markdown', ...postTradeKeyboard() },
    )
    .catch(() => {})
}

// Orchestrates the full post-single-trade UX from the detached background.
// Walks the state machine: TRADE_EXECUTING -> CELEBRATION (via TRADE_WON
// or TRADE_LOST) -> DEMO_CONVERSION | PRO_UPSELL | POST_TRADE_MENU (via
// CELEBRATION_DONE), rendering each scene's UX directly. By the time
// this returns, flow_stage in DB matches the visible UX, so the user's
// next button tap routes through sceneRehydrateMw to the right scene.
async function runSinglePostTradeUx(deps: {
  telegram: TgClient
  chatId: number
  telegramId: bigint
  outcome: 'win' | 'loss'
  result: { netProfit?: number; cumulativeLoss?: number; winStep?: number }
  clearedFlow: Record<string, unknown>
}): Promise<void> {
  const { telegram, chatId, telegramId, outcome, result, clearedFlow } = deps

  // Step 1: state machine TRADE_EXECUTING -> CELEBRATION
  await applyEventDetached(
    telegramId,
    { type: outcome === 'win' ? 'TRADE_WON' : 'TRADE_LOST' },
    {
      flowDataPatch: { ...clearedFlow, lastTradeResult: result },
      replaceFlowData: true,
    },
  )

  // Step 2: render celebration banner.
  if (outcome === 'win') {
    await renderCelebrationWin(telegram, chatId, telegramId, result)
  } else {
    await renderCelebrationLoss(telegram, chatId, result)
  }
  await pause(450)

  // Step 3: state machine CELEBRATION -> DEMO_CONVERSION | PRO_UPSELL | POST_TRADE_MENU
  const transition = await applyEventDetached(telegramId, { type: 'CELEBRATION_DONE' })

  // Step 4: render whichever scene the machine landed in.
  switch (transition.nextStage) {
    case 'DEMO_CONVERSION':
      await renderDemoConversion(telegram, chatId, result)
      break
    case 'PRO_UPSELL':
      await renderProUpsell(telegram, chatId, telegramId, result)
      break
    default:
      await renderPostTradeMenu(telegram, chatId)
  }
}

export async function executeSingleTradeScene(ctx: BotContext): Promise<void> {
  let prepared: SingleTradeBackgroundDeps | null
  try {
    prepared = await prepareSingleTrade(ctx)
  } catch (err) {
    // Stale IQ session caught at prepare time (before any cosmetic messages
    // or DB writes that would need rolling back). Show the user a clear
    // recovery message instead of letting the error bubble up to the
    // middleware handler as a silent failure.
    if (err instanceof IqSessionExpiredError) {
      await handleExpiredIqSession(ctx)
      return
    }
    throw err
  }
  if (!prepared) return

  // Detach: the gale loop runs in the background while the Telegraf
  // handler returns immediately. The scene's enter() resolving in <1s
  // means subsequent updates from this user (or anyone else) don't queue
  // behind the trade. We capture chatId / telegram client / user snapshot
  // by value so the closure doesn't outlive a fresh ctx.
  const captured = prepared
  void runSingleTradeBackground(captured).catch(async (err) => {
    // Auth failure mid-trade: IQ revoked the session between prepare and
    // place. Clear the dead state, message the user, then fall through to
    // strip tradeInFlight so the user can recover on /start.
    if (isIqAuthFailedError(err) || err instanceof IqSessionExpiredError) {
      await invalidateCachedClient(captured.telegramId).catch(() => {})
      await userRepo.clearIqSession(captured.telegramId).catch(() => {})
      await captured.telegram
        .sendMessage(
          captured.chatId,
          '⚠️ Your IQ Option session expired during the trade.\nPlease /start to reconnect.',
        )
        .catch(() => {})
      await userRepo
        .updateFlowStage(
          captured.telegramId,
          'LOGIN_EMAIL',
          withoutTradeInFlight(captured.userSnapshot.flow_data),
        )
        .catch(() => {})
      getLogger().info(
        { event: 'iq_session_expired_mid_trade', telegramId: captured.telegramId.toString(), egressIp: getEgressIp() },
        'iq session expired during trade execution — user routed to LOGIN_EMAIL',
      )
      return
    }
    getLogger().error(
      { err, telegramId: captured.telegramId.toString(), event: 'trade_background_failed' },
      'detached single-trade background failed',
    )
    await captured.telegram
      .sendMessage(captured.chatId, '⚠️ Trade aborted unexpectedly. Tap /start to continue.')
      .catch(() => {})
    // Always strip tradeInFlight when falling back; otherwise the user
    // is locked out by the concurrent-trade guard until the stale
    // timestamp expires (30 min).
    await userRepo
      .updateFlowStage(
        captured.telegramId,
        'TIMEFRAME',
        withoutTradeInFlight(captured.userSnapshot.flow_data),
      )
      .catch(() => {})
  })
}

// Shared recovery routine for the synchronous (ctx-bound) path of an
// IqSessionExpiredError. Wipes the in-flight trade flag if present, sends
// the user a clear message, and routes them into LOGIN_EMAIL where the
// existing login scenes already handle re-authentication.
async function handleExpiredIqSession(ctx: BotContext): Promise<void> {
  if (!ctx.from) return
  const telegramId = BigInt(ctx.from.id)
  const user = ctx.state.currentUser ?? (await userRepo.findById(telegramId))
  const flow = withoutTradeInFlight(user?.flow_data ?? {})
  await userRepo.updateFlowStage(telegramId, 'LOGIN_EMAIL', flow).catch(() => {})
  await ctx
    .reply(
      '⚠️ Your IQ Option session expired.\nLog in again to continue trading.',
    )
    .catch(() => {})
  await ctx.scene.enter('LOGIN_EMAIL').catch(() => {})
}

type SingleTradeBackgroundDeps = {
  telegram: BotContext['telegram']
  chatId: number
  telegramId: bigint
  userSnapshot: UserRow
  selectedPair: PairWithRate
  baseStake: number
  direction: 'call' | 'put'
  client: Awaited<ReturnType<typeof loadTradingClientForUser>>['client']
  tradeId: string
  galeMessage: Awaited<ReturnType<typeof createGaleMessage>>
}

// Synchronous prep: validates the trade setup, hard-claims TRADE_EXECUTING
// in DB so concurrent updates from the same user can't double-launch a
// gale loop, sends the pre-trade ceremony banners, and returns everything
// the background runner needs. Returns null if we bailed (bad setup or
// trade already in flight).
async function prepareSingleTrade(ctx: BotContext): Promise<SingleTradeBackgroundDeps | null> {
  const user = await ensureUser(ctx)
  const data = user.flow_data ?? {}
  const selectedPair = data.selectedPair as PairWithRate | undefined
  const baseStake = Number(user.base_stake ?? 0)
  if (!selectedPair || !baseStake) {
    // Persist the corrected stage so the DB matches runtime; otherwise a
    // restart leaves flow_stage='TRADE_EXECUTING' and the rehydrate path
    // won't have anywhere clean to land. Strip tradeInFlight so the user
    // isn't locked out of the next attempt.
    await userRepo.updateFlowStage(
      BigInt(user.telegram_id),
      'TIMEFRAME',
      withoutTradeInFlight(user.flow_data),
    )
    await ctx.reply('Trade setup is incomplete. Choose pair and amount again.')
    await ctx.scene.enter('TIMEFRAME')
    return null
  }

  // Concurrent-trade guard. If the previous trade detached and the user
  // managed to retap "Take another" before it finished, short-circuit
  // instead of spawning a second gale loop racing the same IQ session.
  //
  // Stale-flag protection: a previous trade that crashed or was
  // interrupted by a bot restart can leave tradeInFlight=true with no
  // running gale loop, locking the user out indefinitely. We pair the
  // flag with a tradeInFlightAt timestamp; if more than
  // STALE_INFLIGHT_MS has elapsed, treat the flag as stale residue and
  // proceed with a fresh trade.
  const flowData = user.flow_data ?? {}
  const inFlight = (flowData as Record<string, unknown>).tradeInFlight === true
  const inFlightAt = Number((flowData as Record<string, unknown>).tradeInFlightAt ?? 0)
  const STALE_INFLIGHT_MS = 30 * 60 * 1000 // 30 min — longer than max gale chain
  const isStale = inFlight && (Date.now() - inFlightAt > STALE_INFLIGHT_MS || inFlightAt === 0)
  if (inFlight && !isStale) {
    await ctx.reply('A trade is already running — hold on for the result. ⏳')
    return null
  }

  const telegramId = BigInt(user.telegram_id)
  const direction = Math.random() < 0.5 ? 'call' : 'put'
  const { client } = await loadTradingClientForUser(telegramId)

  // Pre-trade ceremony per spec stage 9 — scanning, opportunity-found
  // banner, direction signal, params card, then "session initialized".
  // These still run synchronously inside the scene's enter() so the user
  // sees immediate feedback; only the gale loop itself is detached.
  await typing(ctx, 600)
  await replyWithMoneyGbtImage(
    ctx,
    '09-scanning.jpg',
    '🔍 *Scanning markets...*',
    { parse_mode: 'Markdown' },
  )
  await pause(1500)
  await typing(ctx, 600)
  await replyWithMoneyGbtImage(
    ctx,
    '21-opportunity-found.jpg',
    `*OPPORTUNITY FOUND*\nConfidence: *${selectedPair.winRate}%*  ·  Bot is ready to execute.`,
    { parse_mode: 'Markdown' },
  )
  await pause(500)
  await typing(ctx, 500)
  await replyWithHandoffImage(
    ctx,
    direction === 'call' ? '17-bullish-signal.jpg' : '18-bearish-signal.jpg',
    direction === 'call' ? '🟢 *CALL SIGNAL*' : '🔴 *PUT SIGNAL*',
    { parse_mode: 'Markdown' },
  )
  await pause(500)
  await typing(ctx, 500)
  await ctx.reply(
    [
      `🔷  Trading pair: *${selectedPair.label}*`,
      `🔷  Amount: *$${baseStake.toFixed(2)}* USD`,
      `🔷  Expiration: *${user.timeframe ?? '1m'}*`,
      '🔷  Strategy: *High-Profit* ⚡',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
  await pause(450)
  await typing(ctx, 500)
  const galeMessage = await createGaleMessage(ctx as never, ctx.chat!.id, '✦ Trade session initialized…')
  await pause(800)
  const tradeId = await tradeRepo.create({
    userTelegramId: telegramId,
    tradeNum: 1,
    pairCode: selectedPair.code,
    pairFlag: selectedPair.flag,
    direction,
    timeframe: user.timeframe ?? '1m',
    accountMode: user.account_mode,
    baseStake,
  })

  // Hard-claim the in-flight slot. tradeInFlight (boolean) + tradeInFlightAt
  // (epoch ms) — the timestamp lets the stale-flag protection above
  // recover users whose flag never got cleared (background crash, bot
  // restart, etc.) without admin intervention.
  const claimedFlow = {
    ...(user.flow_data ?? {}),
    tradeInFlight: true,
    tradeInFlightAt: Date.now(),
  }
  await userRepo.updateFlowStage(telegramId, 'TRADE_EXECUTING', claimedFlow)
  if (ctx.state.currentUser) {
    ctx.state.currentUser.flow_stage = 'TRADE_EXECUTING'
    ctx.state.currentUser.flow_data = claimedFlow
  }

  return {
    telegram: ctx.telegram,
    chatId: ctx.chat!.id,
    telegramId,
    userSnapshot: { ...user, flow_data: claimedFlow, flow_stage: 'TRADE_EXECUTING' },
    selectedPair,
    baseStake,
    direction,
    client,
    tradeId,
    galeMessage,
  }
}

// Strips the in-flight bookkeeping flags from a flow_data snapshot.
// Used by every recovery path (background catch handler, abort branch,
// post-trade UX) so we never write a stale tradeInFlight=true back to
// the DB and lock the user out.
function withoutTradeInFlight(flow: Record<string, unknown> | undefined): Record<string, unknown> {
  const cleared = { ...(flow ?? {}) }
  delete cleared.tradeInFlight
  delete cleared.tradeInFlightAt
  return cleared
}

// Detached gale runner. Owns no Telegraf request context — only the chatId
// + telegram client + user snapshot captured at prep time. All UI emits go
// via telegram.sendMessage / message edits; all flow_stage advancement
// uses applyEventDetached so it survives ctx-scene-state being long gone.
async function runSingleTradeBackground(deps: SingleTradeBackgroundDeps): Promise<void> {
  const { telegram, chatId, telegramId, userSnapshot, selectedPair, baseStake, direction, client, tradeId, galeMessage } = deps

  let recoveryShown = false
  const result = await executeGale({
    client,
    baseStake,
    pair: selectedPair.code,
    direction,
    timeframe: userSnapshot.timeframe ?? '1m',
    tradeNum: 1,
    accountMode: userSnapshot.account_mode,
    message: galeMessage,
    systemPaused: async () => {
      const state = await systemStateRepo.get()
      return (
        state.paused_all ||
        (userSnapshot.tier === 'auto' && state.paused_auto) ||
        (userSnapshot.tier === 'pro' && state.paused_pro)
      )
    },
    persistStep: async (step) => {
      await tradeRepo.appendStep(tradeId, {
        step: step.step,
        stake: step.stake,
        iq_trade_id: step.iqTradeId,
        outcome: step.outcome === 'pending' ? undefined : step.outcome,
        return: step.netReturn,
        error: step.error,
      })
      if (step.outcome === 'loss' && !recoveryShown) {
        recoveryShown = true
        await telegram
          .sendPhoto(
            chatId,
            mediaInputFor('10-recovery.jpg'),
            {
              caption:
                '⚡ *SMART RECOVERY ACTIVATED*\nBumping the next stake. Bot fights back.',
              parse_mode: 'Markdown',
            },
          )
          .catch(() => {})
      }
    },
    sleep: async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    },
  })

  // Always clear the in-flight flag (and its timestamp) before
  // transitioning out. If the transition itself throws, the parent
  // .catch() falls back to TIMEFRAME with the same flag-stripped flow.
  const clearedFlow = withoutTradeInFlight(userSnapshot.flow_data)

  if (result.outcome === 'win') {
    await tradeRepo.complete(tradeId, 'win', result.winStep, result.netProfit)
    if (userSnapshot.account_mode === 'live') {
      await userRepo.incrementLiveWinCount(telegramId)
    }
    await runSinglePostTradeUx({
      telegram,
      chatId,
      telegramId,
      outcome: 'win',
      result: { netProfit: result.netProfit, winStep: result.winStep },
      clearedFlow,
    })
    return
  }

  if (result.outcome === 'loss') {
    await tradeRepo.complete(tradeId, 'loss', null, -result.cumulativeLoss)
    await runSinglePostTradeUx({
      telegram,
      chatId,
      telegramId,
      outcome: 'loss',
      result: { cumulativeLoss: result.cumulativeLoss },
      clearedFlow,
    })
    return
  }

  // aborted — no celebration path; reset to TIMEFRAME so the user can retry.
  await tradeRepo.complete(tradeId, 'aborted', null, -result.cumulativeLoss)
  await telegram.sendMessage(chatId, friendlyAbortMessage(result)).catch(() => {})
  await userRepo.updateFlowStage(telegramId, 'TIMEFRAME', clearedFlow)
}

export async function executeProTradeScene(ctx: BotContext): Promise<void> {
  let prepared: ProTradeBackgroundDeps | null
  try {
    prepared = await prepareProTrade(ctx)
  } catch (err) {
    if (err instanceof IqSessionExpiredError) {
      await handleExpiredIqSession(ctx)
      return
    }
    throw err
  }
  if (!prepared) return

  const captured = prepared
  void runProTradeBackground(captured).catch(async (err) => {
    if (isIqAuthFailedError(err) || err instanceof IqSessionExpiredError) {
      await invalidateCachedClient(captured.telegramId).catch(() => {})
      await userRepo.clearIqSession(captured.telegramId).catch(() => {})
      await captured.telegram
        .sendMessage(
          captured.chatId,
          '⚠️ Your IQ Option session expired during the trade.\nPlease /start to reconnect.',
        )
        .catch(() => {})
      await userRepo
        .updateFlowStage(
          captured.telegramId,
          'LOGIN_EMAIL',
          withoutTradeInFlight(captured.userSnapshot.flow_data),
        )
        .catch(() => {})
      getLogger().info(
        {
          event: 'iq_session_expired_mid_trade',
          telegramId: captured.telegramId.toString(),
          tradeKind: 'pro',
          egressIp: getEgressIp(),
        },
        'iq session expired during PRO trade execution — user routed to LOGIN_EMAIL',
      )
      return
    }
    getLogger().error(
      { err, telegramId: captured.telegramId.toString(), event: 'pro_trade_background_failed' },
      'detached PRO trade background failed',
    )
    await captured.telegram
      .sendMessage(captured.chatId, '⚠️ PRO trade aborted unexpectedly. Tap /start to continue.')
      .catch(() => {})
    await userRepo
      .updateFlowStage(
        captured.telegramId,
        'TIMEFRAME',
        withoutTradeInFlight(captured.userSnapshot.flow_data),
      )
      .catch(() => {})
  })
}

type ProTradeBackgroundDeps = {
  telegram: BotContext['telegram']
  chatId: number
  telegramId: bigint
  userSnapshot: UserRow
  client: Awaited<ReturnType<typeof loadTradingClientForUser>>['client']
  proSessionId: string
  positions: Array<{
    pair: string
    direction: 'call' | 'put'
    baseStake: number
    message: Awaited<ReturnType<typeof createGaleMessage>>
  }>
  createdTrades: string[]
}

async function prepareProTrade(ctx: BotContext): Promise<ProTradeBackgroundDeps | null> {
  const user = await ensureUser(ctx)
  const data = user.flow_data ?? {}
  const proPairs = ((data.proPairs as PairWithRate[] | undefined) ?? []).slice(0, 3)
  const baseStake = Number(user.base_stake ?? 0)
  if (proPairs.length !== 3 || !baseStake) {
    await userRepo.updateFlowStage(
      BigInt(user.telegram_id),
      'TIMEFRAME',
      withoutTradeInFlight(user.flow_data),
    )
    await ctx.reply('PRO trade setup is incomplete. Choose your pairs again.')
    await ctx.scene.enter('TIMEFRAME')
    return null
  }

  // Same stale-flag protection as the SINGLE path — see prepareSingleTrade.
  const flowData = user.flow_data ?? {}
  const inFlight = (flowData as Record<string, unknown>).tradeInFlight === true
  const inFlightAt = Number((flowData as Record<string, unknown>).tradeInFlightAt ?? 0)
  const STALE_INFLIGHT_MS = 30 * 60 * 1000
  const isStale = inFlight && (Date.now() - inFlightAt > STALE_INFLIGHT_MS || inFlightAt === 0)
  if (inFlight && !isStale) {
    await ctx.reply('A PRO trade is already running — hold on for the result. ⏳')
    return null
  }

  const telegramId = BigInt(user.telegram_id)
  const { client } = await loadTradingClientForUser(telegramId)
  const proSessionId = crypto.randomUUID()
  const createdTrades = await Promise.all(
    proPairs.map((pair, index) =>
      tradeRepo.create({
        userTelegramId: telegramId,
        tradeNum: index + 1,
        pairCode: pair.code,
        pairFlag: pair.flag,
        direction: Math.random() < 0.5 ? 'call' : 'put',
        timeframe: user.timeframe ?? '1m',
        accountMode: user.account_mode,
        baseStake,
        proSessionId,
      }),
    ),
  )

  const positions = await Promise.all(
    proPairs.map(async (pair) => ({
      pair: pair.code,
      direction: (Math.random() < 0.5 ? 'call' : 'put') as 'call' | 'put',
      baseStake,
      message: await createGaleMessage(ctx as never, ctx.chat!.id, `PRO ${pair.label} initialized...`),
    })),
  )

  const claimedFlow = {
    ...(user.flow_data ?? {}),
    tradeInFlight: true,
    tradeInFlightAt: Date.now(),
  }
  await userRepo.updateFlowStage(telegramId, 'TRADE_EXECUTING_PRO', claimedFlow)
  if (ctx.state.currentUser) {
    ctx.state.currentUser.flow_stage = 'TRADE_EXECUTING_PRO'
    ctx.state.currentUser.flow_data = claimedFlow
  }

  return {
    telegram: ctx.telegram,
    chatId: ctx.chat!.id,
    telegramId,
    userSnapshot: { ...user, flow_data: claimedFlow, flow_stage: 'TRADE_EXECUTING_PRO' },
    client,
    proSessionId,
    positions,
    createdTrades,
  }
}

async function runProTradeBackground(deps: ProTradeBackgroundDeps): Promise<void> {
  const { telegram, chatId, telegramId, userSnapshot, client, proSessionId, positions, createdTrades } = deps

  const result = await executeProBatch(
    {
      client,
      timeframe: userSnapshot.timeframe ?? '1m',
      accountMode: userSnapshot.account_mode,
      systemPaused: async () => (await systemStateRepo.get()).paused_all,
      persistStep: async (step) => {
        const tradeId = createdTrades[Math.max(0, step.step - 1)] ?? createdTrades[0]!
        await tradeRepo.appendStep(tradeId, {
          step: step.step,
          stake: step.stake,
          iq_trade_id: step.iqTradeId,
          outcome: step.outcome === 'pending' ? undefined : step.outcome,
          return: step.netReturn,
          error: step.error,
        })
      },
      sleep: async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms))
      },
    },
    positions,
    proSessionId,
    1,
  )

  for (let index = 0; index < result.positions.length; index += 1) {
    const position = result.positions[index]!
    const tradeId = createdTrades[index]!
    if (position.outcome === 'win') {
      await tradeRepo.complete(tradeId, 'win', position.winStep, position.netProfit)
    } else if (position.outcome === 'loss') {
      await tradeRepo.complete(tradeId, 'loss', null, -position.cumulativeLoss)
    } else {
      await tradeRepo.complete(tradeId, 'aborted', null, -position.cumulativeLoss)
    }
  }

  const clearedFlow = withoutTradeInFlight(userSnapshot.flow_data)

  // All three positions aborted (insufficient balance, system pause,
  // SDK error, etc.) → no celebration, just tell the user once and
  // route them back to TIMEFRAME so they can retry. Without this branch
  // the user sees a confused "celebration" with $0 profit and no idea
  // why nothing happened — exactly the silent-failure mode reported by
  // a live-mode test on 2026-05-09.
  const abortedPositions = result.positions.filter(
    (position): position is AbortedGaleResult => position.outcome === 'aborted',
  )
  if (abortedPositions.length === result.positions.length && abortedPositions.length > 0) {
    await telegram
      .sendMessage(chatId, friendlyAbortMessage(abortedPositions[0]!))
      .catch(() => {})
    await userRepo.updateFlowStage(telegramId, 'TIMEFRAME', clearedFlow)
    return
  }

  // TRADE_EXECUTING_PRO -> CELEBRATION_PRO
  await applyEventDetached(telegramId, { type: 'TRADE_WON' }, {
    flowDataPatch: { ...clearedFlow, lastTradeResult: result },
    replaceFlowData: true,
  })

  // celebrationProScene UX
  await renderCelebrationPro(telegram, chatId, result)

  // CELEBRATION_PRO -> POST_TRADE_MENU
  await applyEventDetached(telegramId, { type: 'CELEBRATION_DONE' })
  await renderPostTradeMenu(telegram, chatId)
}
