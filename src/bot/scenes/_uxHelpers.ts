import type { BotContext } from '../index.js'

function responsivenessFactor(): number {
  return process.env.NODE_ENV === 'production' ? 0.2 : 1
}

function scaledDelay(ms: number): number {
  return Math.max(0, Math.round(ms * responsivenessFactor()))
}

// Sleep — small breathers between message bubbles per spec tone rules.
export async function pause(ms: number): Promise<void> {
  const wait = scaledDelay(ms)
  if (wait <= 0) return
  await new Promise((resolve) => setTimeout(resolve, wait))
}

// Show Telegram's "typing…" indicator and hold it for `ms` before returning.
// Telegraf auto-clears typing after ~5 seconds, so for longer pauses we
// re-issue the action mid-way.
export async function typing(ctx: BotContext, ms: number): Promise<void> {
  const total = scaledDelay(ms)
  if (!ctx.chat) {
    await pause(total)
    return
  }
  await typingTo(ctx.telegram, ctx.chat.id, ms)
}

// Same as `typing` but takes a raw Telegram client + chat id. Used by the
// detached post-trade UX runner where there's no Telegraf request context
// — only the chat id captured at trade-start time.
export async function typingTo(
  telegram: BotContext['telegram'],
  chatId: number,
  ms: number,
): Promise<void> {
  const total = scaledDelay(ms)
  let elapsed = 0
  while (elapsed < total) {
    await telegram.sendChatAction(chatId, 'typing').catch(() => {})
    const slice = Math.min(4_000, total - elapsed)
    await pause(slice)
    elapsed += slice
  }
}

// Multi-stage spectacle — sends a single message and edits it through
// successive stages with typing in between. Returns the final messageId
// in case the caller wants to keep editing.
export async function revealStages(
  ctx: BotContext,
  stages: string[],
  options?: { msPerStage?: number; preTypingMs?: number },
): Promise<{ messageId: number } | null> {
  if (stages.length === 0) return null
  const msPerStage = scaledDelay(options?.msPerStage ?? 900)
  const preTypingMs = scaledDelay(options?.preTypingMs ?? 600)

  await typing(ctx, preTypingMs)
  const sent = await ctx.reply(stages[0]!)
  for (let i = 1; i < stages.length; i++) {
    await pause(msPerStage)
    await ctx.telegram
      .editMessageText(sent.chat.id, sent.message_id, undefined, stages[i]!)
      .catch(() => {})
  }
  return { messageId: sent.message_id }
}

// Markdown helpers — Telegram's classic Markdown parser is permissive enough
// that we can use *bold* and _italic_ without aggressive escaping for the
// content we control. Don't use these on arbitrary user-supplied strings.
export function md(text: string): string {
  return text
}
