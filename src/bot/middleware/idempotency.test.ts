import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { processedUpdateRepo } from '../../core/repositories/index.js'
import { idempotencyMw } from './idempotency.js'
import type { BotContext } from '../index.js'

type Mw = typeof idempotencyMw

function buildCtx(updateId: number | undefined): BotContext {
  return {
    update: typeof updateId === 'number' ? { update_id: updateId } : undefined,
    state: {},
    session: {},
  } as unknown as BotContext
}

async function runMw(mw: Mw, ctx: BotContext, next: jest.Mock): Promise<void> {
  await (mw as (ctx: BotContext, next: () => Promise<void>) => Promise<void>)(
    ctx,
    next as unknown as () => Promise<void>,
  )
}

describe('idempotencyMw', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('runs the next handler when the update is fresh', async () => {
    const recordIfNew = jest.spyOn(processedUpdateRepo, 'recordIfNew').mockResolvedValue(true)
    const next = jest.fn(async () => {})

    await runMw(idempotencyMw, buildCtx(42), next)

    expect(recordIfNew).toHaveBeenCalledWith(42)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('skips the next handler when the update_id was already processed', async () => {
    const recordIfNew = jest.spyOn(processedUpdateRepo, 'recordIfNew').mockResolvedValue(false)
    const next = jest.fn(async () => {})

    await runMw(idempotencyMw, buildCtx(42), next)

    expect(recordIfNew).toHaveBeenCalledWith(42)
    expect(next).not.toHaveBeenCalled()
  })

  it('fails open if the dedup insert throws (better to risk a dup than block all traffic)', async () => {
    jest.spyOn(processedUpdateRepo, 'recordIfNew').mockRejectedValue(new Error('db down'))
    const next = jest.fn(async () => {})

    await runMw(idempotencyMw, buildCtx(42), next)

    expect(next).toHaveBeenCalledTimes(1)
  })

  it('falls through when the update has no update_id (defensive)', async () => {
    const recordIfNew = jest.spyOn(processedUpdateRepo, 'recordIfNew').mockResolvedValue(true)
    const next = jest.fn(async () => {})

    await runMw(idempotencyMw, buildCtx(undefined), next)

    expect(recordIfNew).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })
})
