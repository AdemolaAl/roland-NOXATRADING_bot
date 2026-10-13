import { Markup, Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { getLogger } from '../../infra/logger.js'
import { mediaInputFor } from '../media.js'
import { ensureUser, transitionAfterEvent } from './_bridge.js'
import { typing } from './_uxHelpers.js'
import { userRepo } from '../../core/repositories/index.js'
import { whereShouldUserBe } from '../../core/services/userJourney.js'

// Private channel users must be in before they can use the bot. The chat_id
// is the supergroup-style channel id Telegram returns from getChatMember.
// The bot must be added as ADMIN to this channel for getChatMember to
// succeed — without admin, every call returns "chat not found" and the
// gate becomes impassable. See channel_gate_chat_not_found logging below.
const CHANNEL_INVITE_URL = 'https://t.me/+vrmYgpElOzE1ODg1'
const CHANNEL_CHAT_ID = -1002260951553
const CHANNEL_TITLE = 'ROLAND TRADER 🤖'

export const channelGateScene = new Scenes.BaseScene<BotContext>('CHANNEL_GATE')

function gateKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.url("📢  JOIN ROLAND'S CHANNEL", CHANNEL_INVITE_URL)],
    [Markup.button.callback("✅  I've Joined — Launch My Bot", 'CHANNEL_GATE_VERIFY')],
  ])
}

function launchKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀  LAUNCH MY BOT NOW', 'CHANNEL_GATE_LAUNCH')],
  ])
}

// Loading-state keyboard shown while getChatMember is in flight. The single
// no-op button gives the user a visible "checking" indicator on the gate
// message itself and prevents double-taps re-triggering the verify call.
function checkingKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔍  Checking your membership...', 'CHANNEL_GATE_NOOP')],
  ])
}

// Minimum time the "checking" UI stays visible. getChatMember usually
// resolves in <200ms; an instant flip back looks broken. 800ms is long
// enough to read the spinner state, short enough to not feel sluggish.
const MIN_CHECK_VISIBLE_MS = 800

channelGateScene.enter(async (ctx) => {
  // Skip the channel-join prompt if the user has already joined.
  // Without this, a returning user (e.g. /start after onboarding)
  // briefly flashes the channel-gate screen before being routed
  // forward.
  const user = await ensureUser(ctx)
  const target = whereShouldUserBe(user)
  if (target !== 'CHANNEL_GATE') {
    getLogger().info(
      { event: 'gate_redirect', from: 'CHANNEL_GATE', to: target, telegramId: user.telegram_id },
      'CHANNEL_GATE redirected by achievement state',
    )
    await ctx.scene.enter(target)
    return
  }
  await typing(ctx, 700)
  await ctx.replyWithPhoto(
    mediaInputFor('join squad.jpg'),
    {
      caption: [
        '*Before NOXA launches — you need to be inside the squad first.*',
        '',
        'Roland streams live every evening with members running the bot.',
        'Real trades. Real wins. You\'ll want to be there.',
        '',
        '👇 Join the channel first, then come back.',
      ].join('\n'),
      parse_mode: 'Markdown',
      ...gateKeyboard(),
    },
  )
})

// getChatMember outcomes we care about:
//   - status ∈ {creator, administrator, member, restricted} → in
//   - status ∈ {left, kicked} → out
//   - "chat not found" → bot isn't admin in the channel; this is a config
//     bug, not a user problem. We log loudly so it's visible in alerts.
//   - "user not found" / participant_id_invalid → user has never been
//     visible to the channel; treat as not joined.
type VerifyResult = { ok: true } | { ok: false; configError?: boolean }

async function isChannelMember(ctx: BotContext): Promise<VerifyResult> {
  if (!ctx.from) return { ok: false }
  try {
    const member = await ctx.telegram.getChatMember(CHANNEL_CHAT_ID, ctx.from.id)
    const inChannel =
      member.status === 'creator' ||
      member.status === 'administrator' ||
      member.status === 'member' ||
      member.status === 'restricted'
    return inChannel ? { ok: true } : { ok: false }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/chat not found/i.test(msg)) {
      getLogger().error(
        { err, channelId: CHANNEL_CHAT_ID, event: 'channel_gate_chat_not_found' },
        'channel gate: chat_not_found — bot must be admin in the channel',
      )
      return { ok: false, configError: true }
    }
    if (/user not found/i.test(msg) || /participant.?id.?invalid/i.test(msg)) {
      return { ok: false }
    }
    getLogger().warn(
      { err, channelId: CHANNEL_CHAT_ID, telegramId: ctx.from.id, event: 'channel_gate_verify_failed' },
      'channel gate: getChatMember unexpected error',
    )
    return { ok: false }
  }
}

channelGateScene.action('CHANNEL_GATE_VERIFY', async (ctx) => {
  // Acknowledge the tap immediately (clears the inline-button spinner)
  // and swap the gate buttons for a "Checking..." indicator so the user
  // has clear visual confirmation a check is running.
  await ctx.answerCbQuery('🔍 Checking…').catch(() => {})
  await ctx.editMessageReplyMarkup(checkingKeyboard().reply_markup).catch(() => {})
  if (ctx.chat) {
    await ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(() => {})
  }

  const checkStart = Date.now()
  const result = await isChannelMember(ctx)
  const elapsed = Date.now() - checkStart
  if (elapsed < MIN_CHECK_VISIBLE_MS) {
    await new Promise((r) => setTimeout(r, MIN_CHECK_VISIBLE_MS - elapsed))
  }

  if ('configError' in result && result.configError) {
    // Restore the retry buttons so the user can try again once the bot
    // is fixed (and so the gate isn't permanently stuck on "Checking...").
    await ctx.editMessageReplyMarkup(gateKeyboard().reply_markup).catch(() => {})
    await ctx.reply('⚠️ Verification is temporarily unavailable. Try again in a minute.')
    return
  }

  if (!result.ok) {
    // Restore the retry buttons on the gate photo and send a clear
    // explanation as a fresh message so the user sees BOTH a persistent
    // "you haven't joined" notice AND has the buttons to retry.
    await ctx.editMessageReplyMarkup(gateKeyboard().reply_markup).catch(() => {})
    await ctx.reply(
      [
        "❌ *You haven't joined the channel yet.*",
        '',
        "Tap *JOIN ROLAND'S CHANNEL* above, hit *Join* inside Telegram, then come back and tap *✅ I've Joined* again.",
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
    return
  }

  // Success — clear the gate's keyboard so it's visually "complete",
  // then stream Step 02.
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})

  // Step 02 — Message A (channel reminder).
  await typing(ctx, 600)
  await ctx.reply(
    [
      "✅  *You're in the squad now.*",
      '',
      "Check the channel daily — Roland goes live every evening with members actively running NOXA. You'll see real sessions, real signals, real wins. That's your proof.",
      '',
      `👉 [${CHANNEL_TITLE}](${CHANNEL_INVITE_URL})`,
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )

  // Message B — fired immediately after, no delay, no friction (per spec).
  await ctx.reply(
    [
      "*Now let's get your bot running.*",
      '',
      'Tap below and NOXA fires up on your account in 60 seconds.👇🏻👇🏻',
    ].join('\n'),
    { parse_mode: 'Markdown', ...launchKeyboard() },
  )
})

// User tapped the "Checking..." indicator while a verify call was still
// in flight. Just acknowledge to clear the spinner; we don't need to
// trigger anything else because the original verify call will resolve
// on its own.
channelGateScene.action('CHANNEL_GATE_NOOP', async (ctx) => {
  await ctx.answerCbQuery('Still checking — hang on a sec ⏳').catch(() => {})
})

channelGateScene.action('CHANNEL_GATE_LAUNCH', async (ctx) => {
  await ctx.answerCbQuery('Launching ⚡')
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  // Achievement flag write. Idempotent: COALESCE-protected at the
  // repo layer, so a user re-tapping LAUNCH after the gate has
  // already advanced (e.g. they hit /start mid-flow) doesn't move
  // the timestamp. Fire-and-forget — failure here would just leave
  // the new routing model unable to recognise channel passage, and
  // the user would still cross the gate via the legacy flow_stage
  // transition that follows.
  if (ctx.from) {
    await userRepo.markChannelJoined(BigInt(ctx.from.id)).catch((err) => {
      ctx.logger?.warn(
        { err, event: 'channel_joined_mark_failed', telegramId: ctx.from!.id.toString() },
        'failed to mark channel_joined_at',
      )
    })
  }
  await transitionAfterEvent(ctx, { type: 'CHANNEL_GATE_PASSED' })
})
