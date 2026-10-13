import type { Telegraf } from 'telegraf'
import type { BotContext } from '../bot/index.js'
import { iqPostbackRepo } from '../core/repositories/index.js'
import { attributePostback } from '../core/services/affstoreAttribution.js'
import { handlePostbackNotifications } from '../core/services/affstoreDepositNotifier.js'
import { notifySignupConfirmed } from '../core/services/signupConfirmedNotifier.js'
import { loadEnv } from '../infra/env.js'
import { getLogger } from '../infra/logger.js'

export type PostbackEventType = 'registration' | 'ftd' | 'redeposit' | 'payout' | 'other'

export type ParsedPostback = {
  eventType: PostbackEventType
  rawEvent: string
  traderId: string
  amount: number | null
  countryCode: string | null
  afftrack: string | null
  clickId: string | null
}

export function parsePostbackMessage(text: string | undefined): ParsedPostback | null {
  if (!text || typeof text !== 'string') return null
  const normalized = text.replace(/\s+/g, ' ').trim()
  const evt = normalized.match(/^([A-Za-z][A-Za-z\-_ ]*?)\s*:/)
  if (!evt) return null
  const rawEvent = evt[1]!.trim()
  const trader = normalized.match(/(?<![\d])(\d{6,12})(?![\d])/)
  if (!trader) return null
  const traderId = trader[1]!
  const amt = normalized.match(/amount\s*:\s*([\d.]+)/i)
  const amount = amt ? Number(amt[1]) : null
  const cty = normalized.match(/country\s*:\s*([A-Za-z]{2})/i)
  const countryCode = cty ? cty[1]!.toUpperCase() : null
  const lnk = normalized.match(/link\s*:\s*(\S+)/i)
  const afftrack = lnk ? lnk[1]! : null
  const cid = normalized.match(/click(?:[_\s-]?id)?\s*:\s*([A-Z0-9]+)/i)
  const clickId = cid ? cid[1]!.toUpperCase() : null

  const k = rawEvent.toLowerCase().replace(/[-_\s]/g, '')
  let eventType: PostbackEventType = 'other'
  if (k === 'registration' || k === 'register' || k === 'signup' || k === 'registerpostback' || k === 'reg') {
    eventType = 'registration'
  } else if (k === 'ftd' || k === 'firstdeposit') {
    eventType = 'ftd'
  } else if (k === 'redeposit' || k === 'repeatdeposit' || k === 'repeateddeposit' || k === 'deposit' || k === 'redepo') {
    eventType = 'redeposit'
  } else if (k === 'payout' || k === 'withdrawal') {
    eventType = 'payout'
  }
  return { eventType, rawEvent, traderId, amount, countryCode, afftrack, clickId }
}

async function processPostbackUpdate(
  bot: Telegraf<BotContext>,
  post: { message_id: number; text?: string; caption?: string } | undefined,
  chatId: number | undefined,
): Promise<void> {
  const cfg = loadEnv()
  if (!cfg.AFFSTORE_POSTBACK_CHANNEL_ID) return
  if (chatId !== Number(cfg.AFFSTORE_POSTBACK_CHANNEL_ID)) return

  const rawText = post?.text ?? post?.caption ?? ''
  const parsed = parsePostbackMessage(rawText)
  if (!parsed) return

  await iqPostbackRepo.insertPostback({
    traderId: parsed.traderId,
    eventType: parsed.eventType,
    rawEvent: parsed.rawEvent,
    amount: parsed.amount,
    countryCode: parsed.countryCode,
    afftrack: parsed.afftrack,
    clickid: parsed.clickId,
    rawText,
    sourceChatId: chatId,
    sourceMessageId: post!.message_id,
  })

  if (parsed.eventType === 'registration' && parsed.clickId) {
    const result = await attributePostback(
      { clickId: parsed.clickId, traderId: parsed.traderId, eventType: 'registration' },
      'channel',
    ).catch(() => null)
    if (result?.matched) {
      await notifySignupConfirmed(bot.telegram, result.telegramId)
    }
  }

  await handlePostbackNotifications(bot.telegram, {
    traderId: parsed.traderId,
    eventType: parsed.eventType,
    amount: parsed.amount,
    currency: 'USD',
    country: parsed.countryCode,
    afftrack: parsed.afftrack,
    clickId: parsed.clickId,
  })
}

export function registerPostbackChannelListener(bot: Telegraf<BotContext>) {
  const log = getLogger().child({ module: 'postbackChannel' })
  bot.on('channel_post', async (ctx) => {
    await processPostbackUpdate(bot, ctx.channelPost, ctx.chat?.id).catch((err) => {
      log.warn({ err }, 'postback channel processing failed')
    })
  })
  bot.on('message', async (ctx, next) => {
    const cfg = loadEnv()
    if (!cfg.AFFSTORE_POSTBACK_CHANNEL_ID || ctx.chat?.id !== Number(cfg.AFFSTORE_POSTBACK_CHANNEL_ID)) {
      await next()
      return
    }
    await processPostbackUpdate(bot, ctx.message, ctx.chat?.id).catch((err) => {
      log.warn({ err }, 'postback group processing failed')
    })
  })
}
