import type { Telegraf } from 'telegraf'
import type { BotContext } from '../bot/index.js'
import { auditRepo, systemStateRepo } from '../core/repositories/index.js'
import { requireAdmin } from './permissions.js'

export async function renderSystemStatus(): Promise<string> {
  const state = await systemStateRepo.get()
  return [
    'System status',
    `paused_all: ${state.paused_all}`,
    `paused_auto: ${state.paused_auto}`,
    `paused_pro: ${state.paused_pro}`,
  ].join('\n')
}

export function registerSystemAdminRoutes(bot: Telegraf<BotContext>): void {
  bot.action('ADMIN_SYSTEM', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.reply(
      `${await renderSystemStatus()}\n\nToggle with:\n/admin_pause <all|auto|pro> <on|off>`,
    )
  })

  bot.command('admin_system', async (ctx) => {
    await ctx.reply(await renderSystemStatus())
  })

  bot.command('admin_pause', async (ctx) => {
    const [field, value] = ctx.message.text.split(' ').slice(1)
    if (!field || !value) {
      return ctx.reply('Usage: /admin_pause <all|auto|pro> <on|off>')
    }
    const fieldName =
      field === 'all' ? 'paused_all' : field === 'auto' ? 'paused_auto' : 'paused_pro'
    const enabled = value === 'on'
    await systemStateRepo.setPaused(fieldName, enabled, BigInt(ctx.from!.id))
    await auditRepo.record({
      adminTelegramId: BigInt(ctx.from!.id),
      actionType: enabled ? `pause_${field}` : `resume_${field}`,
      targetType: 'system',
      targetId: fieldName,
    })
    await ctx.reply(await renderSystemStatus())
  })
}
