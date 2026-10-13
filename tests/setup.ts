import { afterAll } from '@jest/globals'

process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = 'silent'
process.env.SESSION_ENCRYPTION_KEY = '0'.repeat(64)
// Tests that import from src/core/repositories/index.ts indirectly trigger
// loadEnv() via the lazy Pool init. Integration tests build repos directly
// from testPool and don't hit this path; only unit tests that import scene
// files through the global repo index need these placeholders. Real values
// are never read because the unit tests stub setAccountMode et al.
process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1/test'
process.env.BOT_TOKEN ??= 'test-token'
process.env.ADMIN_TELEGRAM_IDS ??= '1'
process.env.SUPER_ADMIN_TELEGRAM_ID ??= '1'
process.env.ALERT_CHANNEL_ID ??= '1'

afterAll(async () => {
  try {
    const { testPool } = await import('./fixtures/testDb.js')
    await testPool.end()
  } catch {}
})
