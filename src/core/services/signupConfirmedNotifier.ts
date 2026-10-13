import { Markup, type Telegram } from 'telegraf'
import { sendMoneyGbtImageTo } from '../../bot/media.js'
import { getLogger } from '../../infra/logger.js'

// Sends the post-registration DM to the user whose IQ Option signup
// just landed. Called from the affstore webhook handler immediately
// after attributePostback returns matched=true.
//
// Failures are swallowed: BLOCKED / NOT_FOUND happens when the user
// has uninstalled Telegram or blocked the bot between starting the
// signup and finishing it. The attribution row is already marked
// matched at this point, so the user can still resume via /start.
export async function notifySignupConfirmed(
  telegram: Telegram,
  telegramId: bigint,
): Promise<void> {
  const logger = getLogger()
  try {
    const msg = await sendMoneyGbtImageTo(
      telegram,
      telegramId,
      '22-account-detected.jpg',
      [
        '✅ *New IQ Option account detected.*',
        '',
        "You're ready. Next step is connecting the account inside the bot.",
      ].join('\n'),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Continue 👉', 'IQ_SIGNUP_CONFIRMED_CONTINUE')],
        ]),
      },
    )
    logger.info(
      { event: 'signup_confirmed_dm_sent', telegramId: telegramId.toString(), messageId: msg.message_id },
      'sent signup-confirmation DM',
    )
  } catch (err) {
    const e = err as { code?: number; description?: string }
    const blocked = e?.code === 403
    logger.warn(
      {
        err,
        event: blocked ? 'signup_confirmed_dm_blocked' : 'signup_confirmed_dm_failed',
        telegramId: telegramId.toString(),
        tg_code: e?.code,
        tg_description: e?.description,
      },
      blocked ? 'user blocked the bot — DM swallowed' : 'signup-confirmation DM failed',
    )
  }
}
