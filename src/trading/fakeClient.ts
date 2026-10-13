import type { LoginResult, PlaceBinaryParams, TradeResult, TradingClient } from './client.js'

type Outcome = 'win' | 'loss'

export type FakeConfig = {
  outcomes?: Outcome[]
  initialBalance?: { demo: number; live: number }
  partnerCode?: string | null
  loginShouldFail?: boolean
  resultDelayMs?: number
}

export class FakeTradingClient implements TradingClient {
  private userId = ''
  private accountMode: 'demo' | 'live' = 'demo'
  private balance: { demo: number; live: number }
  private readonly partnerCode: string | null
  private cursor = 0
  private readonly outcomes: Outcome[]
  private readonly placed = new Map<string, { outcome: Outcome; stake: number }>()
  private readonly failNextLogin: boolean
  private readonly resultDelayMs: number

  constructor(private readonly cfg: FakeConfig = {}) {
    this.outcomes = cfg.outcomes ?? ['win']
    this.balance = cfg.initialBalance ?? { demo: 10_000, live: 100 }
    this.partnerCode = cfg.partnerCode ?? 'aff=743768'
    this.failNextLogin = cfg.loginShouldFail ?? false
    this.resultDelayMs = cfg.resultDelayMs ?? 5
  }

  async login(email: string, _password: string): Promise<LoginResult> {
    if (this.failNextLogin) {
      throw new Error('login_failed')
    }

    this.userId = `FAKE-${email}`

    return {
      iqUserId: this.userId,
      sessionToken: `fake-session-${Date.now()}`,
      sessionExpiresAt: new Date(Date.now() + 3_600_000),
      partnerCode: this.partnerCode,
      initialBalance: { ...this.balance },
    }
  }

  async resumeSession(_token: string): Promise<void> {}

  async logout(): Promise<void> {
    this.userId = ''
  }

  async getBalance(mode: 'demo' | 'live'): Promise<number> {
    return this.balance[mode]
  }

  async setAccountMode(mode: 'demo' | 'live'): Promise<void> {
    this.accountMode = mode
  }

  getUserId(): string {
    return this.userId
  }

  getPartnerCode(): string | null {
    return this.partnerCode
  }

  async placeBinary(params: PlaceBinaryParams): Promise<{ iqTradeId: string }> {
    const iqTradeId = `fake-trade-${Math.random().toString(36).slice(2)}`
    const outcome = this.outcomes[this.cursor % this.outcomes.length]!
    this.cursor += 1
    this.placed.set(iqTradeId, { outcome, stake: params.stake })
    this.balance[this.accountMode] -= params.stake
    return { iqTradeId }
  }

  async awaitResult(iqTradeId: string, _timeoutMs: number): Promise<TradeResult> {
    const trade = this.placed.get(iqTradeId)

    if (!trade) {
      throw new Error(`unknown trade: ${iqTradeId}`)
    }

    await new Promise((resolve) => setTimeout(resolve, this.resultDelayMs))

    if (trade.outcome === 'win') {
      const payout = trade.stake * 1.92
      this.balance[this.accountMode] += payout
      return { outcome: 'win', payout }
    }

    return { outcome: 'loss', payout: 0 }
  }
}
