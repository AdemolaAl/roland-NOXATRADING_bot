import { Markup } from 'telegraf'
import type { UserRow } from '../core/repositories/userRepo.js'
import { PAIR_POOL } from '../core/services/pairGenerator.js'
import type { HandoffImage, MoneyGbtImage } from '../bot/media.js'

export type NudgeImage = HandoffImage | MoneyGbtImage

// Aggressive flat cadence — every 30 minutes, forever, no escalation.
// The bot is meant to disturb users until they engage or block it. The
// only relief is tapping Pause Notifications (we removed that button
// from HOME, so effectively users have to interact or block).
//
// First ping fires at INACTIVITY_PING_HOURS (env, default 0.5h = 30 min)
// per the activity middleware. Subsequent pings repeat at this same
// interval until the user re-engages.
const NUDGE_INTERVAL_SECONDS = 30 * 60

// Returns the delay in seconds until the next nudge. Constant 30 min —
// kept as a function so callers don't need to know the value, and so we
// can re-introduce escalation later without churning call sites.
export function nextNudgeDelaySeconds(_currentNudgeCount: number): number {
  return NUDGE_INTERVAL_SECONDS
}

const CONFIDENCES = [85, 87, 88, 89, 90, 91, 92, 93, 94, 95]
const TIMEFRAMES = ['30s', '1m', '2m'] as const
const FAKE_NAMES = [
  'Adamu O.', 'Maria S.', 'Lucas P.', 'Chen W.', 'Praise A.',
  'Femi T.', 'Aisha K.', 'Diego R.', 'Kemi B.', 'Rafael M.',
  'Tunde A.', 'Sofia L.', 'Joseph N.', 'Pedro G.', 'Ifeoma C.',
]
const FAKE_AMOUNTS = [85, 120, 145, 180, 220, 270, 340, 410, 540, 680, 820]

const pickRandom = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!
const pickRate = () => pickRandom(CONFIDENCES)
const pickTimeframe = () => pickRandom(TIMEFRAMES)
const pickPair = () => pickRandom(PAIR_POOL)
const pickName = () => pickRandom(FAKE_NAMES)
const pickAmount = () => pickRandom(FAKE_AMOUNTS)

// ─── Variant builders ──────────────────────────────────────────────────────
// Each variant returns a Markdown-formatted body and an optional image.
// Roughly 70% of variants attach an image; the rest stay text to keep the
// notification stream visually balanced and Telegram-friendly.

type VariantOutput = { text: string; image?: NudgeImage }
type Variant = (firstName: string) => VariantOutput

// Generic AUTO/PRO signal card — spec stage 13 format.
const signalCard: Variant = () => {
  const pair = pickPair()
  const opener = pickRandom([
    '🔥 *Hot opportunity right now*',
    '⚡ *Live signal — high confidence*',
    '📈 *OTC scanner just lit up*',
    '🎯 *High-conviction setup detected*',
    '🚨 *New signal — window closing*',
    '📡 *Scanner caught a clean entry*',
  ])
  return {
    text: [
      opener,
      '',
      `*${pair.label}*`,
      `Confidence: *${pickRate()}%*`,
      `Expiry: *${pickTimeframe()}*`,
      '',
      "Don't miss this one 👇",
    ].join('\n'),
    image: '05-signal-confirmed.jpg',
  }
}

// "Window closing" countdown framing.
const closingWindow: Variant = () => {
  const pair = pickPair()
  const minutes = pickRandom([2, 3, 4, 5])
  return {
    text: [
      `⏱ *${minutes} minutes left*`,
      '',
      `*${pair.label}* signal is active.`,
      `Confidence: *${pickRate()}%*`,
      '',
      "Tap in before it closes 👇",
    ].join('\n'),
    image: '05-signal-confirmed.jpg',
  }
}

// Top-N social-proof framing.
const topPicks: Variant = () => {
  const picks = [pickPair(), pickPair(), pickPair()].slice(0, 3)
  return {
    text: [
      '📊 *Top 3 OTC pairs scanning hot now*',
      '',
      ...picks.map((p, i) => `${i + 1})  *${p.label}* — ${pickRate()}%`),
      '',
      "Pick one and ride it 👇",
    ].join('\n'),
    image: '03-select-pair.jpg',
  }
}

// Fake-trader social proof. CRITICAL: copy AND image must read
// unambiguously as "another user won" — never as "you won". Earlier
// wording ("Maria S. just hit +$270 / Same setup is still active") +
// a generic win trophy was misread by users as their own win, which
// both confused them and broke trust when their IQ balance didn't
// match. The 15-user-profit.jpg banner explicitly says "Another user
// HUNT COMPLETE! · NOXA struck the signal · Profit confirmed" so image
// and text now reinforce each other.
const traderStory: Variant = () => {
  const profit = pickAmount()
  const stake = Math.round(profit / pickRandom([1.6, 1.8, 1.9, 2.1]))
  const pair = pickPair()
  return {
    text: [
      `🏆  *Another NOXATRADING user just banked +$${profit}*`,
      '',
      `_${pickName()}_  ·  Stake $${stake}  ·  Pair *${pair.label}*  ·  Closed in *${pickTimeframe()}*`,
      '',
      'The same signal is live for *you* now 👇',
    ].join('\n'),
    image: '15-user-profit.jpg',
  }
}

// Most explicit social-proof framing. Pairs with the dedicated branded
// asset (images/15-user-profit.jpg) which says "Another user HUNT
// COMPLETE! · NOXA struck the signal · Profit confirmed · Your account
// could look exactly like this" in big type — visual reinforcement
// that this is social proof, not the recipient's own win.
const anotherUserWin: Variant = () => {
  const profit = pickAmount()
  const pair = pickPair()
  return {
    text: [
      `NOXATRADING identified the signal on *${pair.label}* — *+$${profit}* closed in *${pickTimeframe()}*.`,
      '',
      'The bot is working. Connect yours and trade the same signal 👇',
    ].join('\n'),
    image: '15-user-profit.jpg',
  }
}

// Question hook — "up or down?" — text only (conversational).
const questionHook: Variant = () => {
  const pair = pickPair()
  return {
    text: [
      `🎯 *Up or down?*`,
      '',
      `*${pair.label}* in *${pickTimeframe()}* — your call.`,
      `Bot's read: *${pickRate()}%* confidence.`,
      '',
      'Take the trade 👇',
    ].join('\n'),
  }
}

// Money-math punchy — pairs naturally with the "real money" image.
const moneyMath: Variant = (firstName) => {
  const stake = pickRandom([20, 50, 100, 200])
  const result = Math.round(stake * pickRandom([1.84, 1.88, 1.92]))
  return {
    text: [
      `💸 *$${stake} → $${result}*  in 90 seconds.`,
      '',
      `That's the kind of trade ${firstName} could've taken right now.`,
      '',
      'Live signal active 👇',
    ].join('\n'),
    image: '04-go-live.jpg',
  }
}

// Streak hook — text only (lighter, personal).
const streakHook: Variant = (firstName) => {
  return {
    text: [
      `📉  ${firstName}, your streak is going cold.`,
      '',
      `The OTC scanner's been quiet on your account.`,
      `Tap below — we found a *${pickRate()}%* setup.`,
      '',
      "Don't let the day pass 👇",
    ].join('\n'),
  }
}

// Curiosity hook — they "missed something". Text only — relies on intrigue.
const missedSomething: Variant = () => {
  const pair = pickPair()
  return {
    text: [
      '👀  *You missed something today*',
      '',
      `Three signals fired on *${pair.label}*.`,
      'All three closed in profit.',
      '',
      'The next one is loading 👇',
    ].join('\n'),
  }
}

// PRO-specific: triple stack.
const proTripleStack: Variant = () => {
  const a = pickPair()
  const b = pickPair()
  const c = pickPair()
  return {
    text: [
      '⚡ *PRO triple-stack window opening*',
      '',
      `*${a.label}*  ·  *${b.label}*  ·  *${c.label}*`,
      `Combined confidence: *${pickRate()}%+*`,
      '',
      'Trigger all three at once 👇',
    ].join('\n'),
    image: '16-upsell-pro.jpg',
  }
}

// PRO-specific: chart AI tease.
const proChartTease: Variant = () => {
  return {
    text: [
      '📈  *Drop any chart, get an instant call*',
      '',
      'PRO chart AI is sitting idle.',
      "Send a screenshot — we'll tell you call or put.",
      '',
      'Or just take a fresh signal below 👇',
    ].join('\n'),
    image: '09-scanning.jpg',
  }
}

// Demo-specific variants — push toward AUTO unlock.
const demoUnlockNudge: Variant = (firstName) => {
  return {
    text: [
      pickRandom([
        `🚀  *${firstName}, other NOXATRADING users banked cash today.*`,
        `💸  *${firstName}, demo coins won't pay your bills.*`,
        `🔥  *${firstName}, your AUTO unlock is one tap away.*`,
      ]),
      '',
      pickRandom([
        'Top up your IQ Option account and activate live mode.',
        `Other live users just locked *+$${pickAmount()}* on the same setup you tested.`,
        'The bot is doing the work. Demo just shows what you could be making.',
      ]),
      '',
      'Tap below 👇',
    ].join('\n'),
    image: '04-go-live.jpg',
  }
}

const demoFomo: Variant = () => {
  const profit = pickAmount()
  return {
    text: [
      `💸  *Another NOXATRADING user just banked +$${profit} CASH*`,
      '',
      'Same bot. Same signals. Real money.',
      "You're still on demo coins.",
      '',
      'Switch up 👇',
    ].join('\n'),
    image: '04-go-live.jpg',
  }
}

const demoSocialProof: Variant = () => {
  return {
    text: [
      '🏆  *Other NOXATRADING users went LIVE today*',
      '',
      `_${pickName()}_ upgraded.  _${pickName()}_ too.`,
      `_${pickName()}_ hit their 3rd live win.`,
      '',
      "You're still on demo. Tap below to catch up 👇",
    ].join('\n'),
    image: '08-demo-vs-live.jpg',
  }
}

// ─── LIVE-trader variants — push them to take more trades ─────────────────
// These are explicitly aggressive about getting active live users to fire
// another trade right now. Aimed at AUTO/PRO pools.

const liveBalanceIdle: Variant = (firstName) => ({
  text: [
    `💼 *${firstName}, your live capital is sitting idle.*`,
    '',
    'Money in the account isn\'t money working.',
    `OTC scanner has a *${pickRate()}%* setup ready.`,
    '',
    'Run a trade 👇',
  ].join('\n'),
  image: '04-go-live.jpg',
})

const liveStreakKeep: Variant = (firstName) => ({
  text: [
    `🔥 *${firstName}, the day is hot.*`,
    '',
    `Other live NOXATRADING users averaged *+$${pickAmount()}* today.`,
    'Don\'t let the session pass without a trade.',
    '',
    'Take one now 👇',
  ].join('\n'),
  image: '15-user-profit.jpg',
})

const liveQuickWindow: Variant = () => ({
  text: [
    '⏱ *30-second window open*',
    '',
    `*${pickPair().label}* is set up cleanly.`,
    `Confidence: *${pickRate()}%*  ·  Expiry: *30s*`,
    '',
    'Tap to fire 👇',
  ].join('\n'),
  image: '05-signal-confirmed.jpg',
})

const liveOthersTrading: Variant = () => ({
  text: [
    `📡 *${pickRandom([18, 22, 31, 47, 64])} other NOXATRADING users* fired live trades in the last hour.`,
    '',
    `_${pickName()}_ just banked *+$${pickAmount()}*.`,
    `_${pickName()}_ closed *+$${pickAmount()}* on a 1m.`,
    '',
    "You're missing the action — fire yours 👇",
  ].join('\n'),
  image: '15-user-profit.jpg',
})

const liveDayHotMarket: Variant = () => ({
  text: [
    '📈 *Markets are running hot.*',
    '',
    'OTC volatility is elevated — perfect for our setups.',
    `Top scanner pick: *${pickPair().label}* @ *${pickRate()}%*.`,
    '',
    'Strike while it\'s warm 👇',
  ].join('\n'),
  image: '03-select-pair.jpg',
})

const liveOneMoreTrade: Variant = (firstName) => ({
  text: [
    `🎯 *One more trade, ${firstName}?*`,
    '',
    `Bot says *${pickPair().label}* is the cleanest call right now.`,
    `Confidence: *${pickRate()}%*.`,
    '',
    '60 seconds of your time. Tap 👇',
  ].join('\n'),
})

// "Bot is still watching" — always-on framing, works for both demo and live.
const stillWatching: Variant = (firstName) => ({
  text: [
    `👁  *${firstName}, I'm still watching.*`,
    '',
    '8 markets. Every second. 24/7.',
    `Latest scanner pick: *${pickPair().label}* @ *${pickRate()}%*.`,
    '',
    'Want me to fire? 👇',
  ].join('\n'),
  image: '13-watching.jpg',
})

const alwaysOnReminder: Variant = () => ({
  text: [
    "📡 *Bot is always on.*",
    '',
    `${pickRandom([8, 12, 14, 17])} setups crossed 80% confidence in the last hour.`,
    "I picked the best one for you.",
    '',
    'Tap to take it 👇',
  ].join('\n'),
  image: '13-watching.jpg',
})

// ─── DEMO push-to-start variants — get them to take any trade ─────────────

const demoFirstTrade: Variant = (firstName) => ({
  text: [
    `🧪 *${firstName}, take your first trade.*`,
    '',
    'Demo coins. Zero risk. The bot does the work.',
    'You just watch it win.',
    '',
    'Tap below to start 👇',
  ].join('\n'),
  image: '02-demo-active.jpg',
})

const demoSeeBotWork: Variant = () => ({
  text: [
    "👀 *Want to see the bot actually trade?*",
    '',
    'Demo mode is risk-free.',
    'One tap, one signal, one trade.',
    '',
    'Watch it work 👇',
  ].join('\n'),
  image: '05-signal-confirmed.jpg',
})

const demoConversionStat: Variant = () => ({
  text: [
    `📊 *${pickRandom([62, 71, 78, 84])}% of demo users* upgraded to LIVE this week.`,
    '',
    'They didn\'t guess. They watched the bot win on demo first.',
    'Then they switched.',
    '',
    'Run your demo trade 👇',
  ].join('\n'),
  image: '08-demo-vs-live.jpg',
})

const demoOpportunityFree: Variant = () => ({
  text: [
    '🎯 *Opportunity found — risk-free*',
    '',
    `*${pickPair().label}*  ·  Confidence: *${pickRate()}%*`,
    'Take it on demo. Costs nothing. Proves everything.',
    '',
    'Tap 👇',
  ].join('\n'),
  image: '05-signal-confirmed.jpg',
})

const demoMoneyMade: Variant = () => ({
  text: [
    '💸 *Other NOXATRADING users made profit today*',
    '',
    `_${pickName()}_ banked *+$${pickAmount()}*.`,
    `_${pickName()}_ banked *+$${pickAmount()}*.`,
    `_${pickName()}_ banked *+$${pickAmount()}*.`,
    '',
    'They started where you are. On demo.',
    '',
    'Take your first trade 👇',
  ].join('\n'),
  image: '04-go-live.jpg',
})

// ─── Pools per tier ────────────────────────────────────────────────────────
// Each pool has 12-14 variants so the same prompt rarely repeats within
// the same day at the new 30-min cadence.

const DEMO_VARIANTS: readonly Variant[] = [
  // Push-to-start — heaviest emphasis for users who haven't traded
  demoFirstTrade,
  demoSeeBotWork,
  demoOpportunityFree,
  demoMoneyMade,
  demoConversionStat,
  // Demo→Live conversion FOMO
  demoUnlockNudge,
  demoFomo,
  demoSocialProof,
  // Social proof — explicit "another user won" framing
  anotherUserWin,
  // Always-on framing
  stillWatching,
  alwaysOnReminder,
  // Generic opportunity flavor
  signalCard,
  questionHook,
  topPicks,
]

const AUTO_VARIANTS: readonly Variant[] = [
  // Push-to-trade-more — heaviest emphasis
  liveBalanceIdle,
  liveStreakKeep,
  liveQuickWindow,
  liveOthersTrading,
  liveDayHotMarket,
  liveOneMoreTrade,
  // Always-on framing
  stillWatching,
  alwaysOnReminder,
  // Generic opportunity / setup
  signalCard,
  closingWindow,
  topPicks,
  traderStory,
  anotherUserWin,
  questionHook,
  moneyMath,
  streakHook,
  missedSomething,
]

const PRO_VARIANTS: readonly Variant[] = [
  // PRO-specific
  proTripleStack,
  proChartTease,
  // Push-to-trade-more (live-trader emphasis)
  liveBalanceIdle,
  liveStreakKeep,
  liveQuickWindow,
  liveOthersTrading,
  liveDayHotMarket,
  liveOneMoreTrade,
  // Always-on framing
  stillWatching,
  alwaysOnReminder,
  // Generic
  signalCard,
  closingWindow,
  topPicks,
  traderStory,
  anotherUserWin,
  moneyMath,
]

function nudgeKeyboard() {
  // Single CTA — no Pause Notifications button. The bot is meant to
  // disturb until users engage; we don't give them an opt-out from
  // inside the nudge itself.
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀  Trade Now', 'NUDGE_TRADE')],
  ])
}

export function pickNudge(user: UserRow): {
  text: string
  image?: NudgeImage
  parseMode: 'Markdown'
  keyboard: ReturnType<typeof nudgeKeyboard>
} {
  const firstName = (user.telegram_first_name ?? '').trim() || 'trader'

  let pool: readonly Variant[]
  if (user.tier === 'pro') pool = PRO_VARIANTS
  else if (user.tier === 'auto') pool = AUTO_VARIANTS
  else pool = DEMO_VARIANTS

  const variant = pickRandom(pool)
  const built = variant(firstName)
  return {
    text: built.text,
    image: built.image,
    parseMode: 'Markdown',
    keyboard: nudgeKeyboard(),
  }
}
