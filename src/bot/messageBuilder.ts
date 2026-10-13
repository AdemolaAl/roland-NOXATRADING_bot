import type { Telegraf } from 'telegraf'
import type { BotContext } from './index.js'

type EditQueue = { promise: Promise<void> }

const queues = new Map<string, EditQueue>()
const RATE_LIMIT_MS = 1100

export class GaleMessageHandle {
  public constructor(
    private readonly bot: Pick<Telegraf<BotContext>, 'telegram'>,
    private readonly chatId: number,
    private readonly messageId: number,
    private currentText: string,
  ) {}

  async appendLine(line: string): Promise<void> {
    await this.update((currentText) => currentText + (currentText ? '\n' : '') + line)
  }

  async replaceLastLine(line: string): Promise<void> {
    await this.update((currentText) => {
      const lines = currentText.split('\n')
      lines[lines.length - 1] = line
      return lines.join('\n')
    })
  }

  getText(): string {
    return this.currentText
  }

  private async update(updater: (currentText: string) => string): Promise<void> {
    const key = String(this.chatId)
    const previous = queues.get(key)?.promise ?? Promise.resolve()
    const next = previous.then(async () => {
      const newText = updater(this.currentText)
      await this.bot.telegram.editMessageText(this.chatId, this.messageId, undefined, newText)
      this.currentText = newText
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS))
    })
    queues.set(key, { promise: next })
    await next
  }
}

export async function createGaleMessage(
  bot: Pick<Telegraf<BotContext>, 'telegram'>,
  chatId: number,
  initialText: string,
): Promise<GaleMessageHandle> {
  const sent = await bot.telegram.sendMessage(chatId, initialText)
  return new GaleMessageHandle(bot, chatId, sent.message_id, initialText)
}

export function createGaleMessageHandleForTest(
  bot: Pick<Telegraf<BotContext>, 'telegram'>,
  chatId: number,
  messageId: number,
  currentText: string,
): GaleMessageHandle {
  return new GaleMessageHandle(bot, chatId, messageId, currentText)
}
