import { afterAll, beforeEach, describe, expect, it } from '@jest/globals'
import { testPool, resetDb } from '../../../tests/fixtures/testDb.js'
import { UserRepository } from './userRepo.js'

describe('UserRepository', () => {
  const repo = new UserRepository(testPool)

  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await testPool.end()
  })

  it('createIfMissing inserts new user with defaults', async () => {
    const { user, created } = await repo.createIfMissing(123n, 'alice')
    expect(created).toBe(true)
    expect(user.telegram_id).toBe('123')
    expect(user.tier).toBe('demo')
    expect(user.flow_stage).toBe('welcome')
  })

  it('createIfMissing refreshes identity on repeat calls (Telegram users can rename)', async () => {
    await repo.createIfMissing(123n, 'alice', 'Alice')
    const { user: second, created } = await repo.createIfMissing(123n, 'alice2', 'Alice Two')
    expect(created).toBe(false)
    expect(second.telegram_username).toBe('alice2')
    expect(second.telegram_first_name).toBe('Alice Two')
  })

  it('createIfMissing preserves prior identity when called without new values', async () => {
    await repo.createIfMissing(123n, 'alice', 'Alice')
    const { user: second } = await repo.createIfMissing(123n)
    expect(second.telegram_username).toBe('alice')
    expect(second.telegram_first_name).toBe('Alice')
  })

  it('findById returns null for missing user', async () => {
    expect(await repo.findById(999n)).toBeNull()
  })

  it('updateFlowStage persists stage + data', async () => {
    await repo.createIfMissing(123n)
    await repo.updateFlowStage(123n, 'login_email', { email: 'x@y' })
    const user = await repo.findById(123n)
    expect(user!.flow_stage).toBe('login_email')
    expect(user!.flow_data).toEqual({ email: 'x@y' })
  })

  it('touchActivity bumps last_activity', async () => {
    await repo.createIfMissing(123n)
    const before = (await repo.findById(123n))!.last_activity
    await new Promise((resolve) => setTimeout(resolve, 50))
    await repo.touchActivity(123n)
    const after = (await repo.findById(123n))!.last_activity
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
  })

  it('touchActivityAndResetNudge bumps last_activity and clears nudge state in one statement', async () => {
    await repo.createIfMissing(123n)
    // Seed nudge state we expect to be cleared
    await repo.incrementNudgeCount(123n)
    await repo.incrementNudgeCount(123n)
    await repo.pauseNudges(123n)
    await repo.setLastNudgeMessageId(123n, 999)
    const before = (await repo.findById(123n))!
    expect(before.nudge_count).toBe(2)
    expect(before.nudges_paused_at).not.toBeNull()
    expect(before.last_nudge_message_id).toBe(999)

    await new Promise((resolve) => setTimeout(resolve, 30))
    await repo.touchActivityAndResetNudge(123n)
    const after = (await repo.findById(123n))!
    expect(after.nudge_count).toBe(0)
    expect(after.nudges_paused_at).toBeNull()
    expect(after.last_nudge_message_id).toBeNull()
    expect(new Date(after.last_activity).getTime()).toBeGreaterThan(
      new Date(before.last_activity).getTime(),
    )
  })

  it('updateStateAndFlow with only flow fields leaves tier/account_mode/agreement untouched', async () => {
    await repo.createIfMissing(123n)
    const updated = await repo.updateStateAndFlow(123n, {
      flowStage: 'TIMEFRAME',
      flowData: { foo: 'bar' },
    })
    expect(updated.flow_stage).toBe('TIMEFRAME')
    expect(updated.flow_data).toEqual({ foo: 'bar' })
    expect(updated.tier).toBe('demo')
    expect(updated.account_mode).toBe('demo')
    expect(updated.agreement_accepted).toBe(false)
  })

  it('updateStateAndFlow with all four columns updates each in a single round-trip', async () => {
    await repo.createIfMissing(123n)
    const updated = await repo.updateStateAndFlow(123n, {
      flowStage: 'POST_TRADE_MENU',
      flowData: { lastTrade: 'win' },
      tier: 'auto',
      accountMode: 'live',
      agreementAccepted: true,
    })
    expect(updated.flow_stage).toBe('POST_TRADE_MENU')
    expect(updated.flow_data).toEqual({ lastTrade: 'win' })
    expect(updated.tier).toBe('auto')
    expect(updated.account_mode).toBe('live')
    expect(updated.agreement_accepted).toBe(true)
  })

  it('updateStateAndFlow with empty flowData clears prior flow_data', async () => {
    await repo.createIfMissing(123n)
    await repo.updateStateAndFlow(123n, { flowStage: 'TIMEFRAME', flowData: { foo: 'bar' } })
    const cleared = await repo.updateStateAndFlow(123n, { flowStage: 'HOME', flowData: {} })
    expect(cleared.flow_stage).toBe('HOME')
    expect(cleared.flow_data).toEqual({})
  })

  it('hardDelete removes the user even when click_attributions reference them', async () => {
    await repo.createIfMissing(123n)
    // click_attributions has a NOT NULL FK to users(telegram_id) with no
    // cascade — if hardDelete skips this table, DELETE FROM users throws an
    // FK violation and the whole transaction rolls back.
    await testPool.query(
      `INSERT INTO click_attributions (click_id, telegram_id, tier_intent)
       VALUES ($1, $2, $3)`,
      ['click-abc', '123', 'auto'],
    )

    await repo.hardDelete(123n)

    expect(await repo.findById(123n)).toBeNull()
    const remaining = await testPool.query(
      'SELECT 1 FROM click_attributions WHERE telegram_id = $1',
      ['123'],
    )
    expect(remaining.rowCount).toBe(0)
  })
})
