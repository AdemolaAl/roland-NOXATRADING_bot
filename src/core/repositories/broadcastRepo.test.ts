import { afterAll, beforeEach, describe, expect, it } from '@jest/globals'
import { testPool, resetDb } from '../../../tests/fixtures/testDb.js'
import { AdminRepository } from './adminRepo.js'
import { BroadcastRepository } from './broadcastRepo.js'
import { FunnelRepository } from './funnelRepo.js'
import { SystemStateRepository } from './systemStateRepo.js'
import { UserRepository } from './userRepo.js'

describe('BroadcastRepository, SystemStateRepository, FunnelRepository', () => {
  const users = new UserRepository(testPool)
  const admins = new AdminRepository(testPool)
  const broadcasts = new BroadcastRepository(testPool)
  const systemState = new SystemStateRepository(testPool)
  const funnel = new FunnelRepository(testPool)

  beforeEach(async () => {
    await resetDb()
    await users.createIfMissing(123n, 'alice')
    await admins.add({ telegramId: 900n, displayName: 'Admin' })
  })

  afterAll(async () => {
    await testPool.end()
  })

  it('broadcast lifecycle methods persist status and counts', async () => {
    const broadcast = await broadcasts.create({
      createdByAdminId: 900n,
      segment: 'all',
      recipientCount: 3,
      messageText: 'hello',
    })
    await broadcasts.markSending(broadcast.id)
    await broadcasts.markSent(broadcast.id, 2, 1)
    const found = await broadcasts.findById(broadcast.id)
    expect(found!.status).toBe('sent')
    expect(found!.delivered_count).toBe(2)
  })

  it('listScheduledDue returns pending broadcasts at or before asOf', async () => {
    const dueDate = new Date(Date.now() - 1000)
    await broadcasts.create({
      createdByAdminId: 900n,
      segment: 'all',
      recipientCount: 1,
      messageText: 'scheduled',
      scheduledFor: dueDate,
    })
    const due = await broadcasts.listScheduledDue(new Date())
    expect(due).toHaveLength(1)
  })

  it('system state get and setPaused work', async () => {
    const before = await systemState.get()
    expect(before.paused_all).toBe(false)
    const after = await systemState.setPaused('paused_all', true, 900n)
    expect(after.paused_all).toBe(true)
    expect(after.updated_by).toBe('900')
  })

  it('funnel record, funnelLast7d, and countByEvent work', async () => {
    await funnel.record(123n, 'started')
    await funnel.record(123n, 'iq_connected')
    await funnel.record(123n, 'started')
    const rows = await funnel.funnelLast7d()
    expect(rows.find((row) => row.eventType === 'started')!.count).toBe(2)
    const count = await funnel.countByEvent('iq_connected', {
      from: new Date(Date.now() - 1000),
      to: new Date(Date.now() + 1000),
    })
    expect(count).toBe(1)
  })
})
