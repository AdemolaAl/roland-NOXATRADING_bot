import { describe, it, expect, beforeEach } from '@jest/globals'

describe('env validation', () => {
  beforeEach(async () => {
    process.env = {
      NODE_ENV: 'test',
      BOT_TOKEN: '123:abcdef',
      DATABASE_URL: 'postgresql://localhost:5432/noxatrading_dev',
      SESSION_ENCRYPTION_KEY: '0'.repeat(64),
      ADMIN_TELEGRAM_IDS: '111,222',
      SUPER_ADMIN_TELEGRAM_ID: '111',
      ALERT_CHANNEL_ID: '-100123',
    }
    const { resetEnvCache } = await import('./env.js')
    resetEnvCache()
  })

  it('parses valid env into typed object', async () => {
    const { loadEnv } = await import('./env.js')
    const env = loadEnv()
    expect(env.BOT_TOKEN).toBe('123:abcdef')
    expect(env.ADMIN_TELEGRAM_IDS).toEqual([111n, 222n])
    expect(env.SUPER_ADMIN_TELEGRAM_ID).toEqual([111n])
  })

  it('allows an empty admin list', async () => {
    process.env.ADMIN_TELEGRAM_IDS = ''
    const { resetEnvCache, loadEnv } = await import('./env.js')
    resetEnvCache()
    const env = loadEnv()
    expect(env.ADMIN_TELEGRAM_IDS).toEqual([])
  })

  it('throws when BOT_TOKEN missing', async () => {
    delete process.env.BOT_TOKEN
    const { loadEnv } = await import('./env.js')
    expect(() => loadEnv()).toThrow(/BOT_TOKEN/)
  })

  it('throws when SESSION_ENCRYPTION_KEY is wrong length', async () => {
    process.env.SESSION_ENCRYPTION_KEY = 'short'
    const { loadEnv } = await import('./env.js')
    expect(() => loadEnv()).toThrow(/SESSION_ENCRYPTION_KEY/)
  })

  it('defaults POLL_WATCHDOG_EXIT_ON_QUIET to false', async () => {
    const { loadEnv } = await import('./env.js')
    const env = loadEnv()
    expect(env.POLL_WATCHDOG_EXIT_ON_QUIET).toBe(false)
  })

  it('parses POLL_WATCHDOG_EXIT_ON_QUIET when enabled', async () => {
    process.env.POLL_WATCHDOG_EXIT_ON_QUIET = 'true'
    const { resetEnvCache, loadEnv } = await import('./env.js')
    resetEnvCache()
    const env = loadEnv()
    expect(env.POLL_WATCHDOG_EXIT_ON_QUIET).toBe(true)
  })
})
