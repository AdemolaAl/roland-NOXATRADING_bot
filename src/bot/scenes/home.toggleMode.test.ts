import { describe, expect, it, jest } from '@jest/globals'
import { userRepo } from '../../core/repositories/index.js'
import { adoptClient, getIqCacheSize } from '../../trading/iqSessionCache.js'
import { IqClient } from '../../trading/iqClient.js'
import { handleHomeToggleMode } from './home.scene.js'

type Ctx = Parameters<typeof handleHomeToggleMode>[0]

const TEST_TG_ID = 8759034080n

function buildCtx(overrides: {
  account_mode: 'demo' | 'live'
  tier?: 'demo' | 'auto' | 'pro'
  status?: string
}): {
  ctx: Ctx
  scene: { enter: jest.Mock }
  answerCbQuery: jest.Mock
  editMessageReplyMarkup: jest.Mock
} {
  const enter = jest.fn(async () => {})
  const answerCbQuery = jest.fn(async () => true)
  const editMessageReplyMarkup = jest.fn(async () => true)
  const currentUser = {
    telegram_id: String(TEST_TG_ID),
    account_mode: overrides.account_mode,
    tier: overrides.tier ?? 'auto',
    status: overrides.status ?? 'active',
  }
  const ctx = {
    from: { id: Number(TEST_TG_ID) },
    state: { currentUser },
    scene: { enter },
    answerCbQuery,
    editMessageReplyMarkup,
  } as unknown as Ctx
  return { ctx, scene: { enter }, answerCbQuery, editMessageReplyMarkup }
}

// adoptClient takes a real IqClient instance; we never call any SDK
// methods on it because the toggle handler only invalidates the cache
// entry and triggers logout (best-effort try/catch). A bare IqClient
// without resumeSession() is fine — logout()'s `await this.sdk?.shutdown()`
// no-ops when sdk is null.
function stubCacheEntry(mode: 'demo' | 'live'): void {
  adoptClient(TEST_TG_ID, new IqClient(), mode)
}

describe('handleHomeToggleMode', () => {
  it('flips demo → live, refreshes per-update cache, drops IQ client cache', async () => {
    const setAccountMode = jest.spyOn(userRepo, 'setAccountMode').mockResolvedValue()
    stubCacheEntry('demo')
    expect(getIqCacheSize()).toBe(1)

    const { ctx, scene } = buildCtx({ account_mode: 'demo' })
    await handleHomeToggleMode(ctx)

    expect(setAccountMode).toHaveBeenCalledWith(TEST_TG_ID, 'live')
    expect(getIqCacheSize()).toBe(0)
    expect(
      (ctx.state as { currentUser: { account_mode: string } }).currentUser.account_mode,
    ).toBe('live')
    expect(scene.enter).toHaveBeenCalledWith('HOME')

    setAccountMode.mockRestore()
  })

  it('flips live → demo', async () => {
    const setAccountMode = jest.spyOn(userRepo, 'setAccountMode').mockResolvedValue()
    stubCacheEntry('live')

    const { ctx } = buildCtx({ account_mode: 'live' })
    await handleHomeToggleMode(ctx)

    expect(setAccountMode).toHaveBeenCalledWith(TEST_TG_ID, 'demo')
    expect(getIqCacheSize()).toBe(0)
    expect(
      (ctx.state as { currentUser: { account_mode: string } }).currentUser.account_mode,
    ).toBe('demo')

    setAccountMode.mockRestore()
  })

  it('blocks toggle when tier is demo and never touches DB or cache', async () => {
    const setAccountMode = jest.spyOn(userRepo, 'setAccountMode').mockResolvedValue()
    stubCacheEntry('demo')
    expect(getIqCacheSize()).toBe(1)

    const { ctx, answerCbQuery } = buildCtx({ account_mode: 'demo', tier: 'demo' })
    await handleHomeToggleMode(ctx)

    expect(setAccountMode).not.toHaveBeenCalled()
    expect(getIqCacheSize()).toBe(1)
    expect(answerCbQuery).toHaveBeenCalledWith(
      'Live trading is locked for this account',
      { show_alert: true },
    )

    setAccountMode.mockRestore()
  })

  it('blocks toggle when status is force_demo', async () => {
    const setAccountMode = jest.spyOn(userRepo, 'setAccountMode').mockResolvedValue()
    stubCacheEntry('demo')

    const { ctx } = buildCtx({ account_mode: 'demo', status: 'force_demo' })
    await handleHomeToggleMode(ctx)

    expect(setAccountMode).not.toHaveBeenCalled()
    expect(getIqCacheSize()).toBe(1)

    setAccountMode.mockRestore()
  })
})
