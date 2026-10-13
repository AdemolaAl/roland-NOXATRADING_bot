import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'
import { ProxyAgent } from 'undici'
import {
  agentFor,
  fallbackAgentFor,
  fallbackIndexFor,
  isProxyConnectError,
  proxyIndexFor,
  resetPoolForTest,
} from './proxyPool.js'

const THREE =
  'http://u:p@10.0.0.1:1000,http://u:p@10.0.0.2:2000,http://u:p@10.0.0.3:3000'

describe('proxyPool', () => {
  beforeEach(() => {
    delete process.env.IQ_PROXY_URLS
    resetPoolForTest()
  })
  afterEach(() => {
    delete process.env.IQ_PROXY_URLS
    resetPoolForTest()
  })

  it('returns undefined when IQ_PROXY_URLS is unset (feature off)', () => {
    expect(agentFor(123n)).toBeUndefined()
    expect(fallbackAgentFor(123n)).toBeUndefined()
  })

  it('returns undefined when IQ_PROXY_URLS is empty/whitespace', () => {
    process.env.IQ_PROXY_URLS = '   ,  '
    resetPoolForTest()
    expect(agentFor(123n)).toBeUndefined()
  })

  it('returns a ProxyAgent when the pool is configured', () => {
    process.env.IQ_PROXY_URLS = THREE
    resetPoolForTest()
    expect(agentFor(123n)).toBeInstanceOf(ProxyAgent)
  })

  it('is sticky: same telegramId always maps to the same agent instance', () => {
    process.env.IQ_PROXY_URLS = THREE
    resetPoolForTest()
    expect(agentFor(123n)).toBe(agentFor(123n))
  })

  it('caches agents: two ids on the same index share one ProxyAgent', () => {
    process.env.IQ_PROXY_URLS = THREE
    resetPoolForTest()
    // 123n and 126n happen to hash to the same pool index (both = 2 mod 3)
    expect(agentFor(123n)).toBe(agentFor(126n))
  })

  it('fallback is a different index than primary', () => {
    process.env.IQ_PROXY_URLS = THREE
    resetPoolForTest()
    expect(fallbackAgentFor(123n)).not.toBe(agentFor(123n))
    expect(fallbackAgentFor(123n)).toBeInstanceOf(ProxyAgent)
  })

  it('fallback is undefined when the pool has only one proxy', () => {
    process.env.IQ_PROXY_URLS = 'http://u:p@10.0.0.1:1000'
    resetPoolForTest()
    expect(agentFor(123n)).toBeInstanceOf(ProxyAgent)
    expect(fallbackAgentFor(123n)).toBeUndefined()
  })

  it('spreads different ids across more than one index', () => {
    process.env.IQ_PROXY_URLS = THREE
    resetPoolForTest()
    const seen = new Set([agentFor(1n), agentFor(2n), agentFor(3n), agentFor(4n), agentFor(5n)])
    expect(seen.size).toBeGreaterThan(1)
  })

  describe('proxyIndexFor', () => {
    it('returns undefined when IQ_PROXY_URLS is unset (feature off)', () => {
      expect(proxyIndexFor(123n)).toBeUndefined()
    })

    it('returns a number in [0, size) when configured', () => {
      process.env.IQ_PROXY_URLS = THREE
      resetPoolForTest()
      const index = proxyIndexFor(123n)
      expect(typeof index).toBe('number')
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(3)
    })

    it('is sticky: same telegramId always maps to the same index', () => {
      process.env.IQ_PROXY_URLS = THREE
      resetPoolForTest()
      expect(proxyIndexFor(123n)).toBe(proxyIndexFor(123n))
    })

    it('matches the index that agentFor actually selects', () => {
      process.env.IQ_PROXY_URLS = THREE
      resetPoolForTest()
      // 123n and 126n share a pool index, so they share the agent instance.
      expect(proxyIndexFor(123n)).toBe(proxyIndexFor(126n))
      expect(agentFor(123n)).toBe(agentFor(126n))
      // Find an id on a different index and confirm a different agent.
      const baseIndex = proxyIndexFor(123n)
      let otherId: bigint | undefined
      for (let i = 1n; i <= 20n; i += 1n) {
        if (proxyIndexFor(i) !== baseIndex) {
          otherId = i
          break
        }
      }
      expect(otherId).toBeDefined()
      expect(agentFor(otherId!)).not.toBe(agentFor(123n))
    })
  })

  describe('fallbackIndexFor', () => {
    it('returns undefined when IQ_PROXY_URLS is unset (feature off)', () => {
      expect(fallbackIndexFor(123n)).toBeUndefined()
    })

    it('is undefined when the pool has only one proxy', () => {
      process.env.IQ_PROXY_URLS = 'http://u:p@10.0.0.1:1000'
      resetPoolForTest()
      expect(fallbackIndexFor(123n)).toBeUndefined()
    })

    it('is (primary + 1) % size and differs from the primary index', () => {
      process.env.IQ_PROXY_URLS = THREE
      resetPoolForTest()
      const primary = proxyIndexFor(123n)!
      expect(fallbackIndexFor(123n)).toBe((primary + 1) % 3)
      expect(fallbackIndexFor(123n)).not.toBe(primary)
    })
  })

  describe('isProxyConnectError', () => {
    const connectCodes = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT', 'UND_ERR_CONNECT_TIMEOUT']
    for (const code of connectCodes) {
      it(`is true for cause.code=${code}`, () => {
        expect(isProxyConnectError(Object.assign(new TypeError('fetch failed'), { cause: { code } }))).toBe(true)
      })
    }
    it('is false for a mid-flight reset (ECONNRESET)', () => {
      expect(isProxyConnectError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(false)
    })
    it('is false for bad proxy auth (cause.code=0, global cred error)', () => {
      expect(isProxyConnectError(Object.assign(new TypeError('fetch failed'), { cause: { code: 0 } }))).toBe(false)
    })
    it('is false for a plain Error with no cause', () => {
      expect(isProxyConnectError(new Error('nope'))).toBe(false)
    })
    it('is false for non-error values', () => {
      expect(isProxyConnectError(undefined)).toBe(false)
      expect(isProxyConnectError('x')).toBe(false)
    })
  })
})
