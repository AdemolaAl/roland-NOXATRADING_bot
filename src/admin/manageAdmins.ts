import type { Telegraf } from 'telegraf'
import type { BotContext } from '../bot/index.js'
import { adminRepo } from '../core/repositories/index.js'
import { requireAdmin } from './permissions.js'

export function registerManageAdminsRoutes(bot: Telegraf<BotContext>): void {
  bot.action('ADMIN_MANAGE_ADMINS', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const admins = await adminRepo.listActive()
    const current = admins.length === 0
      ? 'No active admins.'
      : admins.map((admin) => `${admin.telegram_id} ${admin.role} ${admin.display_name}`).join('\n')
    await ctx.reply(
      [
        'Manage Admins',
        current,
        '',
        'Add: /admin_add_admin <telegram_id> <display_name>',
        'Remove: /admin_remove_admin <telegram_id>',
        'List: /admin_list_admins',
      ].join('\n'),
    )
  })

  bot.command('admin_list_admins', async (ctx) => {
    const admins = await adminRepo.listActive()
    await ctx.reply(
      admins.length === 0
        ? 'No active admins.'
        : admins.map((admin) => `${admin.telegram_id} ${admin.role} ${admin.display_name}`).join('\n'),
    )
  })

  bot.command('admin_add_admin', async (ctx) => {
    const [idText, ...nameParts] = ctx.message.text.split(' ').slice(1)
    if (!idText || nameParts.length === 0) {
      return ctx.reply('Usage: /admin_add_admin <telegram_id> <display_name>')
    }
    await adminRepo.add({
      telegramId: BigInt(idText),
      displayName: nameParts.join(' '),
      addedBy: BigInt(ctx.from!.id),
    })
    await ctx.reply(`Admin ${idText} added.`)
  })

  bot.command('admin_remove_admin', async (ctx) => {
    const [idText] = ctx.message.text.split(' ').slice(1)
    if (!idText) return ctx.reply('Usage: /admin_remove_admin <telegram_id>')
    await adminRepo.softRemove(BigInt(idText), BigInt(ctx.from!.id))
    await ctx.reply(`Admin ${idText} removed.`)
  })
}
