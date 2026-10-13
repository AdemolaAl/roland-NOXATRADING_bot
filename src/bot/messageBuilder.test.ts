import { describe, expect, it, jest } from '@jest/globals'
import { createGaleMessageHandleForTest } from './messageBuilder.js'

describe('GaleMessageHandle', () => {
  it('appendLine appends a new line', async () => {
    const editMessageText = jest.fn(
      async (
        _chatId: number,
        _messageId: number,
        _inlineMessageId: unknown,
        _text: string,
      ) => {},
    )
    const handle = createGaleMessageHandleForTest(
      { telegram: { editMessageText } } as never,
      1,
      2,
      'line-1',
    )
    await handle.appendLine('line-2')
    expect(editMessageText).toHaveBeenCalledWith(1, 2, undefined, 'line-1\nline-2')
  })

  it('replaceLastLine replaces the trailing line', async () => {
    const editMessageText = jest.fn(
      async (
        _chatId: number,
        _messageId: number,
        _inlineMessageId: unknown,
        _text: string,
      ) => {},
    )
    const handle = createGaleMessageHandleForTest(
      { telegram: { editMessageText } } as never,
      1,
      2,
      'line-1\nline-2',
    )
    await handle.replaceLastLine('line-3')
    expect(editMessageText).toHaveBeenCalledWith(1, 2, undefined, 'line-1\nline-3')
  })

  it('queues edits per chat in sequence', async () => {
    const calls: string[] = []
    const editMessageText = jest.fn(
      async (
        _chatId: number,
        _messageId: number,
        _inlineMessageId: unknown,
        text: string,
      ) => {
      calls.push(text)
      },
    )
    const handle = createGaleMessageHandleForTest(
      { telegram: { editMessageText } } as never,
      1,
      2,
      'line-1',
    )
    await Promise.all([handle.appendLine('line-2'), handle.appendLine('line-3')])
    expect(calls[0]).toBe('line-1\nline-2')
    expect(calls[1]).toBe('line-1\nline-2\nline-3')
  })
})
