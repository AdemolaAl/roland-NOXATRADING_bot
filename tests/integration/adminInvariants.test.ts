import { describe, expect, it } from '@jest/globals'
import { testPool, resetDb } from '../fixtures/testDb.js'
import { AdminRepository } from '../../src/core/repositories/adminRepo.js'
import { AuditLogRepository } from '../../src/core/repositories/auditRepo.js'
import { SystemStateRepository } from '../../src/core/repositories/systemStateRepo.js'

describe('admin invariants', () => {
  it('records one audit row per admin action and updates system pause', async () => {
    await resetDb()
    const admins = new AdminRepository(testPool)
    const audit = new AuditLogRepository(testPool)
    const system = new SystemStateRepository(testPool)

    await admins.add({ telegramId: 1n, displayName: 'Root', role: 'super_admin' })
    await audit.record({ adminTelegramId: 1n, actionType: 'issue_token' })
    await audit.record({ adminTelegramId: 1n, actionType: 'revoke_token' })
    await audit.record({ adminTelegramId: 1n, actionType: 'suspend_user' })
    await audit.record({ adminTelegramId: 1n, actionType: 'broadcast_send' })
    const count = await audit.count()
    expect(count).toBe(4)

    const state = await system.setPaused('paused_all', true, 1n)
    expect(state.paused_all).toBe(true)
  })
})
