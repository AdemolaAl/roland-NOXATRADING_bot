export type Direction = 'call' | 'put'

export type PlaceBinaryParams = {
  pair: string
  direction: Direction
  stake: number
  expirationSeconds: number
}

export type LoginResult = {
  iqUserId: string
  sessionToken: string
  sessionExpiresAt: Date
  partnerCode: string | null
  initialBalance: { demo: number; live: number }
}

export type TradeResult = { outcome: 'win' | 'loss'; payout: number }

export interface TradingClient {
  login(email: string, password: string): Promise<LoginResult>
  resumeSession(token: string): Promise<void>
  logout(): Promise<void>
  getBalance(mode: 'demo' | 'live'): Promise<number>
  setAccountMode(mode: 'demo' | 'live'): Promise<void>
  getUserId(): string
  getPartnerCode(): string | null
  placeBinary(params: PlaceBinaryParams): Promise<{ iqTradeId: string }>
  awaitResult(iqTradeId: string, timeoutMs: number): Promise<TradeResult>
}
