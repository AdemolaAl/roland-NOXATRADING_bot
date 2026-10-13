import type { Telegraf } from 'telegraf'
import type { BotContext } from '../bot/index.js'
import { tradeRepo } from '../core/repositories/index.js'
import { requireAdmin } from './permissions.js'

export function registerTopTradersAdminRoutes(bot: Telegraf<BotContext>): void {
  bot.action('ADMIN_TOP_TRADERS', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const rows = await tradeRepo.topByVolumeLast30d(20)
    await ctx.reply(
      rows.length === 0
        ? 'No trade volume in last 30 days.'
        : rows.map((row, index) => `${index + 1}. ${row.user_telegram_id} - $${row.total_volume}`).join('\n'),
    )
  })

  bot.command('admin_top', async (ctx) => {
    const rows = await tradeRepo.topByVolumeLast30d(20)
    await ctx.reply(
      rows.length === 0
        ? 'No trade volume in last 30 days.'
        : rows.map((row, index) => `${index + 1}. ${row.user_telegram_id} - $${row.total_volume}`).join('\n'),
    )
  })
}
