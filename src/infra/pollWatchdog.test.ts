import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import {
  markUpdateReceived,
  shouldExitOnQuiet,
  startPollWatchdog,
  stopPollWatchdog,
} from './pollWatchdog.js'

describe('poll watchdog', () => {
  it('exits on quiet periods by default so Railway restarts after silent long-poll stalls', () => {
    expect(shouldExitOnQuiet({})).toBe(true)
    expect(shouldExitOnQuiet({ POLL_WATCHDOG_EXIT_ON_QUIET: 'true' })).toBe(true)
    expect(shouldExitOnQuiet({ POLL_WATCHDOG_EXIT_ON_QUIET: '1' })).toBe(true)
  })

  it('can be explicitly disabled with POLL_WATCHDOG_EXIT_ON_QUIET=0', () => {
    expect(shouldExitOnQuiet({ POLL_WATCHDOG_EXIT_ON_QUIET: 'false' })).toBe(false)
    expect(shouldExitOnQuiet({ POLL_WATCHDOG_EXIT_ON_QUIET: '0' })).toBe(false)
  })
})

describe('poll watchdog recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    markUpdateReceived()
  })

  afterEach(() => {
    stopPollWatchdog()
    jest.useRealTimers()
  })

  it('invokes the recovery callback when polling is silent past the fatal threshold', async () => {
    const onFatalQuiet = jest.fn(async () => {})
    startPollWatchdog({ onFatalQuiet })

    // Boot grace is 60s, fatal threshold is 90s, check interval 30s.
    // Advance well past both — 3 minutes worth of timer ticks — so the
    // first eligible tick (after BOOT_GRACE_MS) sees the silence.
    jest.advanceTimersByTime(3 * 60_000)
    // Drain the recovery promise the timer scheduled.
    await Promise.resolve()

    expect(onFatalQuiet).toHaveBeenCalledTimes(1)
  })

  it('does not invoke recovery while a previous recovery is still pending', async () => {
    let resolveRecovery: () => void = () => {}
    const onFatalQuiet = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRecovery = resolve
        }),
    )
    startPollWatchdog({ onFatalQuiet })

    jest.advanceTimersByTime(3 * 60_000)
    await Promise.resolve()
    // Tick the watchdog several more times while the recovery is pending.
    jest.advanceTimersByTime(2 * 60_000)
    expect(onFatalQuiet).toHaveBeenCalledTimes(1)

    // Once recovery resolves, future silent windows should be eligible
    // for another recovery attempt.
    resolveRecovery()
    await Promise.resolve()
    await Promise.resolve()
    jest.advanceTimersByTime(3 * 60_000)
    await Promise.resolve()
    expect(onFatalQuiet).toHaveBeenCalledTimes(2)
  })
})
