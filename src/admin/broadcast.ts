import type { Telegraf } from 'telegraf'
import type { BotContext } from '../bot/index.js'
import { broadcastRepo } from '../core/repositories/index.js'
import { ALL_SEGMENTS, buildSegmentQuery } from '../core/services/broadcastSegmenter.js'
import { query } from '../infra/db.js'
import { getBoss } from '../jobs/boss.js'
import { requireAdmin } from './permissions.js'

async function recipientCount(segment: (typeof ALL_SEGMENTS)[number]): Promise<number> {
  const built = buildSegmentQuery(segment)
  const sql = built.text.replace('SELECT telegram_id', 'SELECT COUNT(*)::text AS count')
  const result = await query<{ count: string }>(sql, built.params)
  return Number(result.rows[0]?.count ?? '0')
}

export function registerBroadcastAdminRoutes(bot: Telegraf<BotContext>): void {
  bot.action('ADMIN_BROADCASTS', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.reply(
      [
        'Broadcasts',
        `Immediate: /admin_broadcast <${ALL_SEGMENTS.join('|')}> <message>`,
        `Scheduled: /admin_schedule_broadcast <delay_seconds> <${ALL_SEGMENTS.join('|')}> <message>`,
      ].join('\n'),
    )
  })

  bot.command('admin_broadcast', async (ctx) => {
    const [segmentText, ...messageParts] = ctx.message.text.split(' ').slice(1)
    if (!segmentText || messageParts.length === 0) {
      return ctx.reply(`Usage: /admin_broadcast <${ALL_SEGMENTS.join('|')}> <message>`)
    }
    const segment = ALL_SEGMENTS.includes(segmentText as never)
      ? (segmentText as (typeof ALL_SEGMENTS)[number])
      : null
    if (!segment) return ctx.reply('Invalid segment.')
    const messageText = messageParts.join(' ')
    const count = await recipientCount(segment)
    const row = await broadcastRepo.create({
      createdByAdminId: BigInt(ctx.from!.id),
      segment,
      recipientCount: count,
      messageText,
    })
    const boss = await getBoss()
    await boss.send('broadcast-send', { broadcastId: row.id })
    await ctx.reply(`Broadcast queued for ${count} recipients.`)
  })

  bot.command('admin_schedule_broadcast', async (ctx) => {
    const [startAfterSecondsText, segmentText, ...messageParts] = ctx.message.text.split(' ').slice(1)
    if (!startAfterSecondsText || !segmentText || messageParts.length === 0) {
      return ctx.reply(
        `Usage: /admin_schedule_broadcast <delay_seconds> <${ALL_SEGMENTS.join('|')}> <message>`,
      )
    }
    const segment = ALL_SEGMENTS.includes(segmentText as never)
      ? (segmentText as (typeof ALL_SEGMENTS)[number])
      : null
    if (!segment) return ctx.reply('Invalid segment.')
    const messageText = messageParts.join(' ')
    const count = await recipientCount(segment)
    const delaySeconds = Number(startAfterSecondsText)
    const scheduledFor = new Date(Date.now() + delaySeconds * 1000)
    const row = await broadcastRepo.create({
      createdByAdminId: BigInt(ctx.from!.id),
      segment,
      recipientCount: count,
      messageText,
      scheduledFor,
    })
    const boss = await getBoss()
    await boss.send(
      'broadcast-send',
      { broadcastId: row.id },
      { startAfter: scheduledFor.toISOString() },
    )
    await ctx.reply(`Broadcast scheduled for ${scheduledFor.toISOString()}.`)
  })
}
