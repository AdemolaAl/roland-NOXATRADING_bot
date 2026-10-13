import { Markup, Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { typing } from './_uxHelpers.js'

// In-bot help center. Surfaces answers to the questions support gets asked
// over and over, so users don't have to message anyone for common stuck-
// points. Reached via the ❓ Help & FAQ button on HOME.
export const helpFaqScene = new Scenes.BaseScene<BotContext>('HELP_FAQ')

type FaqTopic = {
  id: string
  label: string
  body: string
}

const TOPICS: readonly FaqTopic[] = [
  {
    id: 'real_money',
    label: '💸  How do I trade real money?',
    body: [
      '*Trading with real money*',
      '',
      'Two things you need:',
      '',
      '1️⃣  *LIVE activation* — AUTO ($50+ funded) or PRO ($500+ funded).',
      '2️⃣  *Funds in your IQ Option account* — the bot trades from your balance, not ours.',
      '',
      'Once you have both:',
      '• Tap *⚡ Activate LIVE* on Home',
      '• Tap *Take a Trade*',
      '• Profits land in your IQ Option account. Withdraw anytime.',
      '',
      "Not activated yet? Tap *⚡ Activate LIVE* on Home and follow the deposit check.",
    ].join('\n'),
  },
  {
    id: 'tokens',
    label: '🪙  Tokens — how to get one',
    body: [
      '*Unlock tokens*',
      '',
      'A token looks like `NOXA-AUTO-X9K2QM` or `NOXA-PRO-ABCD12`.',
      '',
      '*Current activation flow:*',
      '• Tap *⚡ Activate LIVE* or *⚡ Upgrade to PRO* on Home',
      '• Deposit into your IQ Option account',
      '• NOXATRADING checks your balance and activates the right tier automatically',
      '',
      '*What this means:*',
      '• You do not need to paste a code into the bot anymore',
      '• AUTO activates at $50+',
      '• PRO activates at $500+',
      '',
      'If activation does not update after your deposit, tap *Done Depositing* again or message support.',
    ].join('\n'),
  },
  {
    id: 'recovery',
    label: '🛡️  What is smart recovery?',
    body: [
      '*Smart Recovery*',
      '',
      'If a trade loses, the bot enters *recovery mode* — it places a follow-up trade with a higher stake to try to recoup the loss.',
      '',
      '*Key facts:*',
      '• Max *6 recovery steps* per signal',
      '• Each step roughly doubles the stake',
      '• A win at any step ends the chain in profit',
      '• After 6 losses, the chain stops',
      '',
      "*This is risk management, not a guarantee.* Long losing streaks can drain a small account fast — that's why AUTO requires $50+ and PRO requires $500+.",
      '',
      "Trade only what you're prepared to lose.",
    ].join('\n'),
  },
  {
    id: 'funds',
    label: '💰  Deposit / withdraw',
    body: [
      '*Funding your account*',
      '',
      'Your money lives in *your IQ Option account*, not in NOXATRADING. The bot only places trades on your behalf.',
      '',
      '*To deposit:*',
      '• Open your IQ Option app or web dashboard',
      '• Use any of their funding methods (card, crypto, e-wallet)',
      '• Funds reflect instantly in NOXATRADING',
      '',
      '*To withdraw:*',
      '• IQ Option app → Withdraw',
      '• Choose method, confirm',
      '• Profits never touch NOXATRADING — every dollar stays in your name',
      '',
      'We never hold, custody, or move your funds.',
    ].join('\n'),
  },
  {
    id: 'demo_lock',
    label: '🔓  Why am I in Demo?',
    body: [
      '*Demo vs Live*',
      '',
      "You're in Demo because LIVE mode hasn't been activated yet.",
      '',
      '*Demo mode:*',
      '• Practice trading with virtual money',
      '• See the bot in action, risk-free',
      '• Cannot withdraw — these are paper profits',
      '',
      '*To unlock Live:*',
      '• Tap *⚡ Activate LIVE* on Home',
      '• Deposit at least $50 into IQ Option',
      '• NOXATRADING checks your balance and activates AUTO',
      '',
      'Once activation clears, LIVE trading unlocks.',
    ].join('\n'),
  },
  {
    id: 'tiers',
    label: '⚡  AUTO vs PRO',
    body: [
      '*AUTO vs PRO*',
      '',
      '🚀  *AUTO ($50+ minimum)*',
      '• Single-pair signals',
      '• One trade at a time',
      '• Smart recovery enabled',
      '',
      '⚡  *PRO ($500+ minimum)*',
      '• *3 simultaneous trades* across different pairs',
      '• *Chart analysis* — send a chart screenshot, get an AI signal',
      '• 5 chart analyses per day',
      '• Smart recovery enabled',
      '',
      'PRO is for serious capital. AUTO is the starting point for live trading.',
      '',
      'AUTO activates at $50+ funded. PRO activates at $500+ funded.',
    ].join('\n'),
  },
  {
    id: 'stuck',
    label: '🤖  Bot stuck or silent?',
    body: [
      '*Bot stuck or silent?*',
      '',
      '*First, try this:*',
      '• Tap */start* (in the menu next to the input field)',
      '• This refreshes your session and lands you on Home',
      '',
      '*If a trade was mid-execution:*',
      '• /start clears any stuck "trade in flight" flags',
      '• Your trade history is preserved',
      '',
      '*If you are still stuck:*',
      '• Message support → @rolandsupport1',
      '• Include your Telegram ID and a screenshot of where you got stuck',
      '',
      '99% of "frozen bot" issues clear with /start.',
    ].join('\n'),
  },
] as const

function topicMenuKeyboard() {
  return Markup.inlineKeyboard([
    ...TOPICS.map((t) => [Markup.button.callback(t.label, `FAQ_${t.id.toUpperCase()}`)]),
    // SELF_DELETE is a global bot.action (like GO_HOME) — it shows a
    // Confirm/Cancel step before erasing anything.
    [Markup.button.callback('🗑  Delete account & start over', 'SELF_DELETE')],
    [Markup.button.callback('🏠  Back to Home', 'GO_HOME')],
  ])
}

function topicAnswerKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('↩  Back to FAQ', 'HELP_BACK')],
    [Markup.button.callback('🏠  Home', 'GO_HOME')],
  ])
}

helpFaqScene.enter(async (ctx) => {
  await typing(ctx, 350)
  await ctx.reply(
    [
      '*NOXATRADING — Help & FAQ*',
      '',
      'Pick a topic 👇',
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      ...topicMenuKeyboard(),
    },
  )
})

helpFaqScene.action('HELP_BACK', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  await ctx.scene.enter('HELP_FAQ')
})

// Wire each topic to its own action handler. Keeping them separate (rather
// than parsing the topic id off a single shared callback) keeps the action
// IDs greppable and the routing trivially traceable.
for (const topic of TOPICS) {
  helpFaqScene.action(`FAQ_${topic.id.toUpperCase()}`, async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    await typing(ctx, 300)
    await ctx.reply(topic.body, {
      parse_mode: 'Markdown',
      ...topicAnswerKeyboard(),
    })
  })
}
