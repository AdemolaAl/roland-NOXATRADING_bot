import type { Telegraf } from 'telegraf'
import type { BotContext } from '../bot/index.js'
import { auditRepo, tradeRepo, userRepo } from '../core/repositories/index.js'
import { requireAdmin } from './permissions.js'

type SearchResult = {
  type: 'user'
  lines: string[]
  telegramId?: bigint
}

export async function searchUsers(query: string): Promise<SearchResult[]> {
  const cleaned = query.trim()
  const results: SearchResult[] = []

  const byUsername = cleaned.startsWith('@')
    ? await userRepo.findByUsername(cleaned.slice(1))
    : await userRepo.findByUsername(cleaned)
  const byIq = await userRepo.findByIqUserId(cleaned)
  const byEmail = cleaned.includes('@') ? await userRepo.findByEmail(cleaned) : []

  const seen = new Set<string>()
  for (const user of [...byUsername, ...byIq, ...byEmail]) {
    if (seen.has(user.telegram_id)) continue
    seen.add(user.telegram_id)
    results.push({
      type: 'user',
      telegramId: BigInt(user.telegram_id),
      lines: [
        '👤 USER MATCH',
        `Telegram: ${user.telegram_username ? `@${user.telegram_username}` : '(no username)'}`,
        `Telegram ID: ${user.telegram_id}`,
        `IQ User ID: ${user.iq_user_id ?? '-'}`,
        `Email: ${user.iq_email ?? '-'}`,
        `Tier: ${user.tier.toUpperCase()}`,
        `Status: ${user.status.toUpperCase()}`,
      ],
    })
  }

  return results
}

export function registerUserAdminRoutes(bot: Telegraf<BotContext>): void {
  bot.action('ADMIN_USERS', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.reply(
      [
        'Users',
        'Search: /admin_find <username|iq_id|email>',
        'Force demo: /admin_force_demo <telegram_id>',
        'Pause: /admin_pause_user <telegram_id>',
        'Suspend: /admin_suspend_user <telegram_id> <reason>',
        'History: /admin_trade_history <telegram_id> [limit]',
        'DM: /admin_dm <telegram_id> <message>',
      ].join('\n'),
    )
  })

  bot.command('admin_find', async (ctx) => {
    const parts = ctx.message.text.split(' ').slice(1)
    const query = parts.join(' ').trim()
    if (!query) {
      await ctx.reply('Usage: /admin_find <username|iq_id|email>')
      return
    }

    const results = await searchUsers(query)
    if (results.length === 0) {
      await ctx.reply('No user matched that query.')
      return
    }

    for (const result of results.slice(0, 5)) {
      await ctx.reply(result.lines.join('\n'))
    }
  })

  bot.command('admin_force_demo', async (ctx) => {
    const [idText] = ctx.message.text.split(' ').slice(1)
    if (!idText) return ctx.reply('Usage: /admin_force_demo <telegram_id>')
    await userRepo.setStatus(BigInt(idText), 'force_demo')
    await auditRepo.record({
      adminTelegramId: BigInt(ctx.from!.id),
      actionType: 'force_demo',
      targetType: 'user',
      targetId: idText,
    })
    await ctx.reply(`User ${idText} forced into demo mode.`)
  })

  bot.command('admin_pause_user', async (ctx) => {
    const [idText] = ctx.message.text.split(' ').slice(1)
    if (!idText) return ctx.reply('Usage: /admin_pause_user <telegram_id>')
    await userRepo.setStatus(BigInt(idText), 'paused')
    await auditRepo.record({
      adminTelegramId: BigInt(ctx.from!.id),
      actionType: 'pause_user',
      targetType: 'user',
      targetId: idText,
    })
    await ctx.reply(`User ${idText} paused.`)
  })

  bot.command('admin_suspend_user', async (ctx) => {
    const [idText, ...reasonParts] = ctx.message.text.split(' ').slice(1)
    if (!idText || reasonParts.length === 0) {
      return ctx.reply('Usage: /admin_suspend_user <telegram_id> <reason>')
    }
    const reason = reasonParts.join(' ')
    await userRepo.setStatus(BigInt(idText), 'suspended', reason)
    await auditRepo.record({
      adminTelegramId: BigInt(ctx.from!.id),
      actionType: 'suspend_user',
      targetType: 'user',
      targetId: idText,
      payload: { reason },
    })
    await ctx.reply(`User ${idText} suspended.`)
  })

  bot.command('admin_trade_history', async (ctx) => {
    const [idText, limitText] = ctx.message.text.split(' ').slice(1)
    if (!idText) return ctx.reply('Usage: /admin_trade_history <telegram_id> [limit]')
    const trades = await tradeRepo.findRecentByUser(BigInt(idText), Number(limitText ?? '5'))
    if (trades.length === 0) {
      return ctx.reply('No trades found.')
    }
    await ctx.reply(
      trades
        .map(
          (trade) =>
            `${trade.pair_code} ${trade.direction} ${trade.final_outcome ?? 'pending'} ${trade.net_result ?? '-'}`,
        )
        .join('\n'),
    )
  })

  bot.command('admin_dm', async (ctx) => {
    const [idText, ...messageParts] = ctx.message.text.split(' ').slice(1)
    if (!idText || messageParts.length === 0) {
      return ctx.reply('Usage: /admin_dm <telegram_id> <message>')
    }
    const message = messageParts.join(' ')
    await bot.telegram.sendMessage(Number(idText), message)
    await auditRepo.record({
      adminTelegramId: BigInt(ctx.from!.id),
      actionType: 'dm_user',
      targetType: 'user',
      targetId: idText,
      payload: { message },
    })
    await ctx.reply(`Message sent to ${idText}.`)
  })
}
