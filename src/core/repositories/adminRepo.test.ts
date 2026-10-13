import { afterAll, beforeEach, describe, expect, it } from '@jest/globals'
import { testPool, resetDb } from '../../../tests/fixtures/testDb.js'
import { AdminRepository } from './adminRepo.js'
import { AuditLogRepository } from './auditRepo.js'
import { resetEnvCache } from '../../infra/env.js'

describe('AdminRepository and AuditLogRepository', () => {
  const admins = new AdminRepository(testPool)
  const audit = new AuditLogRepository(testPool)

  beforeEach(async () => {
    await resetDb()
    process.env.SUPER_ADMIN_TELEGRAM_ID = '777'
    process.env.ADMIN_TELEGRAM_IDS = ''
    resetEnvCache()
  })

  afterAll(async () => {
    await testPool.end()
  })

  it('add and findById work', async () => {
    await admins.add({ telegramId: 100n, displayName: 'Alice', username: 'alice' })
    const admin = await admins.findById(100n)
    expect(admin!.display_name).toBe('Alice')
  })

  it('listActive excludes soft-removed admins', async () => {
    await admins.add({ telegramId: 100n, displayName: 'Alice' })
    await admins.add({ telegramId: 101n, displayName: 'Bob' })
    await admins.softRemove(101n, 100n)
    const active = await admins.listActive()
    expect(active.map((row) => row.telegram_id)).toEqual(['100'])
  })

  it('touchLastActive updates last_active_at', async () => {
    await admins.add({ telegramId: 100n, displayName: 'Alice' })
    const before = (await admins.findById(100n))!.last_active_at
    await new Promise((resolve) => setTimeout(resolve, 50))
    await admins.touchLastActive(100n)
    const after = (await admins.findById(100n))!.last_active_at
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
  })

  it('seedFromEnv inserts super-admin when missing', async () => {
    const seeded = await admins.seedFromEnv()
    expect(seeded).toHaveLength(1)
    expect(seeded[0]!.telegram_id).toBe('777')
    expect(seeded[0]!.role).toBe('super_admin')
  })

  it('seedFromEnv inserts multiple super-admins and extra admins', async () => {
    process.env.SUPER_ADMIN_TELEGRAM_ID = '777,888'
    process.env.ADMIN_TELEGRAM_IDS = '888,999'
    resetEnvCache()

    const seeded = await admins.seedFromEnv()
    expect(seeded.map((row) => [row.telegram_id, row.role])).toEqual([
      ['777', 'super_admin'],
      ['888', 'super_admin'],
      ['999', 'admin'],
    ])

    const active = await admins.listActive()
    expect(active.map((row) => [row.telegram_id, row.role])).toEqual([
      ['777', 'super_admin'],
      ['888', 'super_admin'],
      ['999', 'admin'],
    ])
  })

  it('record and listRecent work with filters', async () => {
    await admins.add({ telegramId: 100n, displayName: 'Alice' })
    await audit.record({
      adminTelegramId: 100n,
      actionType: 'pause_user',
      targetType: 'user',
      targetId: '123',
      payload: { reason: 'spam' },
    })
    await audit.record({
      adminTelegramId: 100n,
      actionType: 'issue_token',
      targetType: 'token',
      targetId: 'abc',
    })
    const filtered = await audit.listRecent(10, { actionType: 'pause_user' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.payload).toEqual({ reason: 'spam' })
  })

  it('exportRange and count work', async () => {
    await admins.add({ telegramId: 100n, displayName: 'Alice' })
    const from = new Date(Date.now() - 1000)
    await audit.record({ adminTelegramId: 100n, actionType: 'ping' })
    const to = new Date(Date.now() + 1000)
    const rows = await audit.exportRange(from, to)
    const count = await audit.count()
    expect(rows).toHaveLength(1)
    expect(count).toBe(1)
  })
})
