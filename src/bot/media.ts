import path from 'node:path'
import type { Telegram } from 'telegraf'
import type { BotContext } from './index.js'
import { FILE_IDS } from './generated/fileIds.js'

// Numbered NOXATRADING banner set in images/. Each one is a branded
// full-bleed card meant to anchor a specific scene moment.
export type HandoffImage =
  | '01-bot-live.jpg'
  | '03-select-pair.jpg'
  | '05-signal-confirmed.jpg'
  | '08-demo-vs-live.jpg'
  | '09-scanning.jpg'
  | '10-recovery.jpg'
  | '13-watching.jpg'
  | '16-upsell-pro.jpg'
  | '17-bullish-signal.jpg'
  | '18-bearish-signal.jpg'
  | '19-profit-confirmed.jpg'
  | '20-win-locked.jpg'
  | '21-opportunity-found.jpg'
  | '22-account-detected.jpg'

export type MoneyGbtImage =
  | '01-bot-live.jpg'
  | '02-demo-active.jpg'
  | '03-select-pair.jpg'
  | '04-go-live.jpg'
  | '05-signal-confirmed.jpg'
  | '06-three-tiers.jpg'
  | '07-set-timeframe.jpg'
  | '08-demo-vs-live.jpg'
  | '09-scanning.jpg'
  | '10-recovery.jpg'
  | '11-connect-account.jpg'
  | '13-watching.jpg'
  | '15-user-profit.jpg'
  | '21-opportunity-found.jpg'
  | '22-account-detected.jpg'

export function handoffImagePath(file: HandoffImage): string {
  return path.resolve(process.cwd(), 'images', file)
}

export function moneyGbtImagePath(file: MoneyGbtImage): string {
  return path.resolve(process.cwd(), 'images', file)
}

// All branded images now follow the NN-name.jpg convention and live in the
// same images/ directory, so HandoffImage and MoneyGbtImage resolve via the
// same path lookup. The two types are kept separate only to preserve the
// per-scene naming convention call sites already use.
export function imagePathFor(file: HandoffImage | MoneyGbtImage): string {
  return path.resolve(process.cwd(), 'images', file)
}

// Single chokepoint for photo inputs. Returns a Telegram file_id (string) when
// one has been seeded for the filename — telegraf accepts a bare string as a
// previously-uploaded reference, so no bytes leave the host. Falls back to a
// local file upload when the map is empty (fresh checkout, new image not yet
// seeded). Run `npm run seed:media` to populate generated/fileIds.ts.
export function mediaInputFor(file: string): string | { source: string } {
  const fileId = FILE_IDS[file]
  if (fileId) return fileId
  return { source: path.resolve(process.cwd(), 'images', file) }
}

export async function replyWithHandoffImage(
  ctx: BotContext,
  file: HandoffImage,
  caption?: string,
  extra?: object,
){
  return ctx.replyWithPhoto(
    mediaInputFor(file),
    {
      caption,
      ...((extra ?? {}) as object),
    },
  )
}

export async function replyWithMoneyGbtImage(
  ctx: BotContext,
  file: MoneyGbtImage,
  caption?: string,
  extra?: object,
){
  return ctx.replyWithPhoto(
    mediaInputFor(file),
    {
      caption,
      ...((extra ?? {}) as object),
    },
  )
}

// Send a handoff image to an arbitrary chat ID — used when the bot needs to
// notify a user from inside another user's chat (e.g. admin approving a token
// from the admin home, DMs the requesting user).
export async function sendHandoffImageTo(
  telegram: Telegram,
  chatId: number | bigint,
  file: HandoffImage,
  caption?: string,
  extra?: object,
): Promise<void> {
  await telegram.sendPhoto(
    Number(chatId),
    mediaInputFor(file),
    {
      caption,
      ...((extra ?? {}) as object),
    },
  )
}

export async function sendMoneyGbtImageTo(
  telegram: Telegram,
  chatId: number | bigint,
  file: MoneyGbtImage,
  caption?: string,
  extra?: object,
){
  return await telegram.sendPhoto(
    Number(chatId),
    mediaInputFor(file),
    {
      caption,
      ...((extra ?? {}) as object),
    },
  )
}
