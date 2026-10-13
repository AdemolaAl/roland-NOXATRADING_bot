import type { Middleware } from 'telegraf'
import type { BotContext } from '../bot/index.js'
import { adminRepo } from '../core/repositories/index.js'

export const requireAdmin: Middleware<BotContext> = async (ctx, next) => {
  if (!ctx.from) {
    return
  }

  // Admin commands and inline-button taps must only ever be answered in
  // a 1:1 chat with the bot. Otherwise an admin typing /admin in a group
  // the bot is also in (e.g. the alert channel) would cause the admin
  // home menu — and every subsequent admin reply — to be posted there.
  if (ctx.chat?.type !== 'private') {
    return
  }

  const admin = await adminRepo.findById(BigInt(ctx.from.id))
  if (!admin || admin.removed_at) {
    return
  }

  await adminRepo.touchLastActive(BigInt(ctx.from.id))
  ;(ctx as BotContext & { admin?: typeof admin }).admin = admin
  await next()
}

export const requireSuperAdmin: Middleware<BotContext> = async (ctx, next) => {
  const admin = (ctx as BotContext & { admin?: { role?: string } }).admin
  if (admin?.role !== 'super_admin') {
    await ctx.reply('Super-admin only.')
    return
  }

  await next()
}
