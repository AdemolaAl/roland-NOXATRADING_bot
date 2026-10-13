import {
  BalanceType,
  BlitzOptionsDirection,
  ClientSdk,
  type Position,
  SsidAuthMethod,
} from '@tradecodehub/client-sdk-js'
import { getLogger } from '../infra/logger.js'
import { fetch as undiciFetch } from 'undici'
import {
  agentFor,
  fallbackAgentFor,
  fallbackIndexFor,
  isProxyConnectError,
  proxyIndexFor,
} from './proxyPool.js'
import type { LoginResult, PlaceBinaryParams, TradeResult, TradingClient } from './client.js'

// The credential-POST transport. Production uses undici.fetch so the request
// can carry a per-user ProxyAgent dispatcher (Node's global fetch rejects an
// externally-installed undici dispatcher with UND_ERR_INVALID_ARG). Tests swap
// this via __setHttpFetchForTest.
type HttpFetch = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    dispatcher?: unknown
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

let httpFetch: HttpFetch = undiciFetch as unknown as HttpFetch

export function __setHttpFetchForTest(fn: HttpFetch | null): void {
  httpFetch = fn ?? (undiciFetch as unknown as HttpFetch)
}

type AccountMode = 'demo' | 'live'

// Thrown when the IQ SDK reports "authentication is failed" on an existing
// session — typically because IQ revoked the SSID server-side. Distinct from
// a bad-credentials login failure: this happens *after* the user has already
// logged in successfully and means their cached session must be wiped before
// the next attempt.
export class IqSessionExpiredError extends Error {
  constructor(cause?: unknown) {
    super('iq_session_expired')
    this.name = 'IqSessionExpiredError'
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

// The SDK surfaces this exact string both from `loginForSsid` (where it
// means bad credentials, handled separately) and from `connection.onmessage`
// (where IQ has revoked the session mid-stream). The login-time path catches
// before it reaches here; anything else carrying this message is an
// expired-session signal.
export function isIqAuthFailedError(err: unknown): boolean {
  return err instanceof Error && err.message === 'authentication is failed'
}

function requireEnv(name: string): string {
  const value = process.env[name]

  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }

  return value
}

function sdkConfig() {
  return {
    wsUrl: requireEnv('IQ_SDK_WS_URL'),
    httpUrl: requireEnv('IQ_SDK_HTTP_URL'),
    platformId: Number(process.env.IQ_SDK_PLATFORM_ID ?? '82'),
  }
}

export class IqClient implements TradingClient {
  private sdk: ClientSdk | null = null
  private accountMode: AccountMode = 'demo'
  private partnerCode: string | null = null
  private userId = ''

  async login(email: string, password: string, telegramId?: bigint): Promise<LoginResult> {
    const { wsUrl, httpUrl, platformId } = sdkConfig()
    const sessionToken = await this.loginForSsid(httpUrl, email, password, telegramId)
    const sdkStartedAt = Date.now()
    this.sdk = await ClientSdk.create(wsUrl, platformId, new SsidAuthMethod(sessionToken))
    const sdkMs = Date.now() - sdkStartedAt

    const balances = await this.sdk.balances()
    const demoBalance = balances.getBalances().find((balance) => balance.type === BalanceType.Demo)
    const liveBalance = balances.getBalances().find((balance) => balance.type === BalanceType.Real)
    this.userId = String(this.sdk.userProfile.userId)
    this.partnerCode = null

    getLogger().info(
      { event: 'iq_sdk_create_ms', kind: 'login', ms: sdkMs, iqUserId: this.userId },
      'iq sdk handshake',
    )
    getLogger().info({ event: 'iq_login_success', iqUserId: this.userId }, 'IQ login succeeded')

    return {
      iqUserId: this.userId,
      sessionToken,
      sessionExpiresAt: new Date(Date.now() + 3_600_000),
      partnerCode: this.partnerCode,
      initialBalance: {
        demo: demoBalance?.amount ?? 0,
        live: liveBalance?.amount ?? 0,
      },
    }
  }

  async resumeSession(token: string): Promise<void> {
    const { wsUrl, platformId } = sdkConfig()
    const sdkStartedAt = Date.now()
    this.sdk = await ClientSdk.create(wsUrl, platformId, new SsidAuthMethod(token))
    const sdkMs = Date.now() - sdkStartedAt
    this.userId = String(this.sdk.userProfile.userId)
    this.partnerCode = null
    getLogger().info(
      { event: 'iq_sdk_create_ms', kind: 'resume', ms: sdkMs, iqUserId: this.userId },
      'iq sdk handshake',
    )
    getLogger().info({ event: 'iq_resume_success', iqUserId: this.userId }, 'IQ session resumed')
  }

  async logout(): Promise<void> {
    await this.sdk?.shutdown()
    this.sdk = null
    this.userId = ''
  }

  async getBalance(mode: AccountMode): Promise<number> {
    const balance = await this.getBalanceObject(mode)
    return balance.amount
  }

  async setAccountMode(mode: AccountMode): Promise<void> {
    this.accountMode = mode
  }

  getUserId(): string {
    return this.userId
  }

  getPartnerCode(): string | null {
    return this.partnerCode
  }

  async placeBinary(params: PlaceBinaryParams): Promise<{ iqTradeId: string }> {
    const sdk = this.ensureSdk()
    const target = params.expirationSeconds

    // Per OTC discovery (scripts/discover-iq-options.ts) every supported
    // timeframe in our spec — 30s, 1m, 2m, 5m — lives under the Blitz facade.
    // Turbo only has 1m on OTC and Binary only has 15m, so neither helps us.
    // Using a single facade keeps the placement path simple and predictable.
    const blitzOptions = await sdk.blitzOptions()
    const active = blitzOptions
      .getActives()
      .find((candidate) => candidate.ticker === params.pair && !candidate.isSuspended)

    if (!active) {
      throw new Error(`active_not_found:${params.pair}`)
    }

    if (!active.expirationTimes.includes(target)) {
      const offered = [...active.expirationTimes].sort((x, y) => x - y).join(',')
      getLogger().warn(
        { event: 'iq_no_matching_expiration', pair: params.pair, requested: target, offered },
        'pair found on Blitz but requested expiration not offered',
      )
      throw new Error(
        `no_matching_expiration:${params.pair}:wanted=${target}s offered=${offered}`,
      )
    }

    getLogger().info(
      {
        event: 'iq_place_binary',
        accountMode: this.accountMode,
        pair: params.pair,
        stake: params.stake,
      },
      'placing binary order',
    )
    const balance = await this.getBalanceObject(this.accountMode)
    const direction =
      params.direction === 'call' ? BlitzOptionsDirection.Call : BlitzOptionsDirection.Put
    const option = await blitzOptions.buy(active, direction, target, params.stake, balance)

    return { iqTradeId: String(option.id) }
  }

  async awaitResult(iqTradeId: string, timeoutMs: number): Promise<TradeResult> {
    const sdk = this.ensureSdk()
    const positions = await sdk.positions()
    const orderId = Number(iqTradeId)

    return new Promise<TradeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        positions.unsubscribeOnUpdatePosition(onUpdate)
        reject(new Error(`timeout_waiting_for_trade:${iqTradeId}`))
      }, timeoutMs)

      const onUpdate = (position: Position) => {
        if (!position.orderIds.includes(orderId)) {
          return
        }

        if (position.status !== 'closed') {
          return
        }

        clearTimeout(timer)
        positions.unsubscribeOnUpdatePosition(onUpdate)

        const payout = position.closeProfit ?? position.pnlRealized ?? 0
        resolve({
          outcome: payout > 0 ? 'win' : 'loss',
          payout,
        })
      }

      positions.subscribeOnUpdatePosition(onUpdate)
    })
  }

  private ensureSdk(): ClientSdk {
    if (!this.sdk) {
      throw new Error('IQ SDK session is not initialized')
    }

    return this.sdk
  }

  private async getBalanceObject(mode: AccountMode) {
    const sdk = this.ensureSdk()
    const balances = await sdk.balances()
    const type = mode === 'demo' ? BalanceType.Demo : BalanceType.Real
    const balance = balances.getBalances().find((candidate) => candidate.type === type)

    if (!balance) {
      throw new Error(`balance_not_found:${mode}`)
    }

    return balance
  }

  private async loginForSsid(
    httpUrl: string,
    email: string,
    password: string,
    telegramId?: bigint,
  ): Promise<string> {
    const primary = telegramId !== undefined ? agentFor(telegramId) : undefined
    const primaryIndex = telegramId !== undefined ? proxyIndexFor(telegramId) : undefined

    const post = async (dispatcher: unknown, index?: number): Promise<string> => {
      const startedAt = Date.now()
      const response = await httpFetch(`${httpUrl}/v2/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'tradecodehub-client-sdk-js/1.3.0',
        },
        body: JSON.stringify({ identifier: email, password }),
        ...(dispatcher ? { dispatcher } : {}),
      })

      const json = (await response.json()) as { code?: string; ssid?: string }

      if (!response.ok || json.code !== 'success' || !json.ssid) {
        throw new Error('authentication is failed')
      }

      if (dispatcher) {
        getLogger().info(
          {
            event: 'iq_proxy_used',
            ms: Date.now() - startedAt,
            telegramId: telegramId?.toString(),
            proxyIndex: index,
          },
          'IQ credential POST sent via proxy',
        )
      }
      return json.ssid
    }

    try {
      return await post(primary, primaryIndex)
    } catch (err) {
      // Retry ONLY when the proxy itself was unreachable — the POST never
      // landed at IQ, so a second attempt on a different proxy cannot produce
      // a duplicate login. Any in-flight failure (reset, 4xx/5xx) propagates
      // untouched, preserving the never-re-POST guarantee.
      const fallback = telegramId !== undefined ? fallbackAgentFor(telegramId) : undefined
      const fallbackIndex = telegramId !== undefined ? fallbackIndexFor(telegramId) : undefined
      if (primary && fallback && isProxyConnectError(err)) {
        getLogger().warn(
          {
            event: 'iq_proxy_connect_failed',
            code: (err as { cause?: { code?: unknown } }).cause?.code,
            telegramId: telegramId?.toString(),
            proxyIndex: primaryIndex,
          },
          'primary proxy unreachable; retrying once on fallback proxy',
        )
        getLogger().info(
          {
            event: 'iq_proxy_fallback_used',
            telegramId: telegramId?.toString(),
            fromIndex: primaryIndex,
            toIndex: fallbackIndex,
          },
          'retrying IQ credential POST on fallback proxy',
        )
        return await post(fallback, fallbackIndex)
      }
      throw err
    }
  }
}
