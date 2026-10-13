import type { Telegraf } from 'telegraf'
import type { BotContext } from '../bot/index.js'
import { auditRepo } from '../core/repositories/index.js'
import { requireAdmin } from './permissions.js'

export function registerAuditAdminRoutes(bot: Telegraf<BotContext>): void {
  bot.action('ADMIN_AUDIT', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const rows = await auditRepo.listRecent(50)
    await ctx.reply(
      rows.length === 0
        ? 'No audit log rows.'
        : rows
            .map(
              (row) =>
                `${row.created_at.toISOString()} ${row.admin_telegram_id} ${row.action_type} ${row.target_type ?? '-'}:${row.target_id ?? '-'}`,
            )
            .join('\n'),
    )
  })

  bot.command('admin_audit', async (ctx) => {
    const rows = await auditRepo.listRecent(50)
    await ctx.reply(
      rows.length === 0
        ? 'No audit log rows.'
        : rows
            .map(
              (row) =>
                `${row.created_at.toISOString()} ${row.admin_telegram_id} ${row.action_type} ${row.target_type ?? '-'}:${row.target_id ?? '-'}`,
            )
            .join('\n'),
    )
  })
}
