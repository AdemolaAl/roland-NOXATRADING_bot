import { Markup, type Telegram } from 'telegraf'
import { loadEnv } from '../../infra/env.js'
import { getLogger } from '../../infra/logger.js'
import { attemptDepositActivation } from '../../bot/depositActivation.js'
import { userRepo } from '../repositories/index.js'

const log = getLogger().child({ module: 'affstoreNotifier' })

export type PostbackEvent = {
  traderId: string
  eventType: 'registration' | 'ftd' | 'redeposit' | 'payout' | 'other'
  amount: number | null
  currency: string | null
  country: string | null
  afftrack: string | null
  clickId: string | null
}

function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null) return '(amount unknown)'
  const sym = (currency ?? 'USD').toUpperCase() === 'USD' ? '$' : `${currency} `
  return `${sym}${amount.toFixed(2)}`
}

function eventLabel(eventType: PostbackEvent['eventType']): string {
  switch (eventType) {
    case 'registration':
      return '🆕 REGISTRATION'
    case 'ftd':
      return '🟢 FIRST DEPOSIT'
    case 'redeposit':
      return '🔁 RE-DEPOSIT'
    case 'payout':
      return '💸 PAYOUT'
    default:
      return '📬 POSTBACK'
  }
}

export async function handlePostbackNotifications(
  telegram: Telegram,
  event: PostbackEvent,
): Promise<void> {
  const users = await userRepo.findByIqTraderId(event.traderId).catch((err) => {
    log.warn({ err, traderId: event.traderId }, 'failed to lookup user by trader_id')
    return []
  })

  await sendAdminAlert(telegram, event, users[0] ?? null).catch((err) => {
    log.error({ err, traderId: event.traderId, eventType: event.eventType }, 'admin alert failed')
  })

  if ((event.eventType === 'ftd' || event.eventType === 'redeposit') && users.length > 0) {
    for (const user of users) {
      const result = await attemptDepositActivation(BigInt(user.telegram_id)).catch((err) => {
        log.warn({ err, telegramId: user.telegram_id, traderId: event.traderId }, 'deposit activation attempt failed')
        return { kind: 'ignored' } as const
      })
      if (result.kind !== 'confirmed') continue

      await telegram
        .sendMessage(
          Number(user.telegram_id),
          [
            result.tier === 'pro' ? '💎 *PRO deposit confirmed.*' : '🔥 *AUTO deposit confirmed.*',
            '',
            `We detected *$${result.totalDeposits.toFixed(2)}* on your IQ Option account.`,
            '',
            'Tap below to continue.',
          ].join('\n'),
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('Continue 👉', 'DEPOSIT_CONFIRMED_CONTINUE')],
            ]),
          },
        )
        .catch(() => {})
    }
  }
}

async function sendAdminAlert(
  telegram: Telegram,
  event: PostbackEvent,
  user: Awaited<ReturnType<typeof userRepo.findById>> | null,
): Promise<void> {
  const env = loadEnv()
  if (!env.ALERT_CHANNEL_ID) return

  const amountStr =
    event.amount !== null ? `Amount: ${formatAmount(event.amount, event.currency)}` : null
  const country = event.country ? ` (${event.country})` : ''
  const afftrackLine = event.afftrack ? `Afftrack: ${event.afftrack}` : null
  const clickIdLine = event.clickId ? `Click id: ${event.clickId}` : null

  let userLine = '(no linked Telegram user — trader not in our attribution table)'
  if (user) {
    const username = user.telegram_username ? `@${user.telegram_username}` : '(no username)'
    userLine = `TG user: ${username}  ·  id ${user.telegram_id}  ·  tier ${user.tier}`
  }

  const lines = [
    eventLabel(event.eventType),
    '',
    `IQ trader: ${event.traderId}${country}`,
    amountStr,
    afftrackLine,
    clickIdLine,
    '',
    userLine,
  ].filter((line) => line !== null) as string[]

  await telegram.sendMessage(env.ALERT_CHANNEL_ID, lines.join('\n'))
}
