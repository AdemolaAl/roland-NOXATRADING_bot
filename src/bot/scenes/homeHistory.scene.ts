import { Markup, Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { tradeRepo } from '../../core/repositories/index.js'
import { ensureUser } from './_bridge.js'
import { typing } from './_uxHelpers.js'

// Last-N trades view, reachable from HOME's 📜 History button. Read-only
// — just shows the user the bot's recent activity on their account so
// they have a sense of what's been happening without leaving Telegram.
export const homeHistoryScene = new Scenes.BaseScene<BotContext>('HOME_HISTORY')

const HISTORY_LIMIT = 5

function backKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('🏠  Back to Home', 'GO_HOME')]])
}

homeHistoryScene.enter(async (ctx) => {
  const user = await ensureUser(ctx)
  const trades = await tradeRepo.findRecentByUser(BigInt(user.telegram_id), HISTORY_LIMIT)

  await typing(ctx, 400)

  if (trades.length === 0) {
    await ctx.reply(
      [
        '📜  *Recent Trades*',
        '',
        "You haven't taken any trades yet.",
        '',
        'Tap *🚀 Take a Trade* on Home to get started.',
      ].join('\n'),
      { parse_mode: 'Markdown', ...backKeyboard() },
    )
    return
  }

  const lines = trades.map((t) => {
    const outcome = t.final_outcome
    const icon = outcome === 'win' ? '🟢' : outcome === 'loss' ? '🔴' : outcome === 'aborted' ? '⚪' : '⏳'
    const result = t.net_result === null ? 'pending' : `${Number(t.net_result) >= 0 ? '+' : ''}$${Number(t.net_result).toFixed(2)}`
    const mode = t.account_mode === 'live' ? 'LIVE' : 'Demo'
    const time = t.started_at.toISOString().slice(5, 16).replace('T', ' ')
    return `${icon}  *${t.pair_code}*  ·  ${t.timeframe}  ·  *${result}*  _(${mode}, ${time})_`
  })

  await ctx.reply(
    [
      `📜  *Recent Trades* (last ${trades.length})`,
      '',
      ...lines,
      '',
      '_🟢 win  ·  🔴 loss  ·  ⚪ aborted  ·  ⏳ pending_',
    ].join('\n'),
    { parse_mode: 'Markdown', ...backKeyboard() },
  )
})
