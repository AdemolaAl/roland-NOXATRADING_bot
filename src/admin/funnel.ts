import type { Telegraf } from 'telegraf'
import type { BotContext } from '../bot/index.js'
import { funnelRepo } from '../core/repositories/index.js'
import { requireAdmin } from './permissions.js'

export function registerFunnelAdminRoutes(bot: Telegraf<BotContext>): void {
  bot.action('ADMIN_FUNNEL', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const rows = await funnelRepo.funnelLast7d()
    await ctx.reply(rows.map((row) => `${row.eventType}: ${row.count}`).join('\n'))
  })

  bot.command('admin_funnel', async (ctx) => {
    const rows = await funnelRepo.funnelLast7d()
    await ctx.reply(rows.map((row) => `${row.eventType}: ${row.count}`).join('\n'))
  })
}
