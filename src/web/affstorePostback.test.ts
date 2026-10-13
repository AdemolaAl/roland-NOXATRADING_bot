import { describe, expect, it, jest, beforeEach } from '@jest/globals'
import type { IncomingMessage, ServerResponse } from 'node:http'

const insertS2S = jest.fn<(input: unknown) => Promise<void>>()
const hasFtdForTrader = jest.fn<(traderId: string) => Promise<boolean>>()
const findByIqTraderId = jest.fn<(traderId: string) => Promise<Array<{ telegram_id: string }>>>()
const attributePostback = jest.fn<(input: unknown, src: string) => Promise<unknown>>()
const notifySignupConfirmed = jest.fn<(telegram: unknown, telegramId: unknown) => Promise<void>>()
const loadEnv = jest.fn(() => ({ AFFSTORE_POSTBACK_SECRET: 'test-secret', NODE_ENV: 'test', LOG_LEVEL: 'silent' }))

jest.unstable_mockModule('../core/repositories/index.js', () => ({
  iqPostbackRepo: { insertS2S, hasFtdForTrader },
  userRepo: { findByIqTraderId },
  funnelRepo: {},
}))
jest.unstable_mockModule('../core/services/affstoreAttribution.js', () => ({
  attributePostback,
}))
jest.unstable_mockModule('../core/services/signupConfirmedNotifier.js', () => ({
  notifySignupConfirmed,
}))
jest.unstable_mockModule('../infra/env.js', () => ({ loadEnv }))

const { createAffstorePostbackHandler } = await import('./affstorePostback.js')

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code
      if (headers) this.headers = headers
      return this
    },
    end(body?: string) {
      if (body) this.body = body
      return this
    },
  }
  return res as unknown as ServerResponse & { statusCode: number; body: string }
}

function mockReq(url: string, method = 'GET'): IncomingMessage {
  return { url, method } as unknown as IncomingMessage
}

describe('affstorePostback handler', () => {
  beforeEach(() => {
    insertS2S.mockReset()
    hasFtdForTrader.mockReset()
    attributePostback.mockReset()
    notifySignupConfirmed.mockReset()
    insertS2S.mockResolvedValue(undefined)
    hasFtdForTrader.mockResolvedValue(false)
    findByIqTraderId.mockResolvedValue([])
  })

  const fakeTelegram = {} as never
  const handler = createAffstorePostbackHandler({ telegram: fakeTelegram })

  it('returns 401 when secret missing', async () => {
    const res = mockRes()
    await handler(mockReq('/affstore-postback?trader_id=T&postback_name=registration&clickid=NOX0000000000000001'), res)
    expect(res.statusCode).toBe(401)
    expect(insertS2S).not.toHaveBeenCalled()
  })

  it('allows requests when no secret is configured', async () => {
    loadEnv.mockReturnValueOnce({ AFFSTORE_POSTBACK_SECRET: '', NODE_ENV: 'test', LOG_LEVEL: 'silent' })
    attributePostback.mockResolvedValue({ matched: false, reason: 'unknown_click_id' })
    const res = mockRes()
    await handler(
      mockReq('/affstore-postback?event_id=e0&trader_id=T0&postback_name=registration&clickid=NOX0000000000000000'),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(insertS2S).toHaveBeenCalledWith(expect.objectContaining({
      traderId: 'T0',
      eventType: 'registration',
    }))
  })

  it('returns 401 on wrong secret', async () => {
    const res = mockRes()
    await handler(mockReq('/affstore-postback?secret=wrong&trader_id=T&postback_name=registration&clickid=NOX0'), res)
    expect(res.statusCode).toBe(401)
  })

  it('returns 405 on non-GET', async () => {
    const res = mockRes()
    await handler(mockReq('/affstore-postback?secret=test-secret', 'POST'), res)
    expect(res.statusCode).toBe(405)
  })

  it('returns 400 when trader_id missing', async () => {
    const res = mockRes()
    await handler(mockReq('/affstore-postback?secret=test-secret&postback_name=registration'), res)
    expect(res.statusCode).toBe(400)
  })

  it('persists registration + calls attribution + sends DM on matched', async () => {
    attributePostback.mockResolvedValue({ matched: true, telegramId: 42n, tierIntent: 'auto' })
    const res = mockRes()
    await handler(
      mockReq(
        '/affstore-postback?secret=test-secret&event_id=e1&trader_id=T1&postback_name=registration&clickid=NOX0000000000000001&afftrack=RolandxNOXA&country_code=NG',
      ),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(insertS2S).toHaveBeenCalledWith(expect.objectContaining({
      traderId: 'T1',
      eventType: 'registration',
      clickid: 'NOX0000000000000001',
      idempotencyKey: 'e1',
    }))
    expect(attributePostback).toHaveBeenCalledWith(
      { clickId: 'NOX0000000000000001', traderId: 'T1', eventType: 'registration' },
      's2s',
    )
    expect(notifySignupConfirmed).toHaveBeenCalledWith(fakeTelegram, 42n)
  })

  it('classifies first deposit as ftd and second as redeposit', async () => {
    attributePostback.mockResolvedValue({ matched: false, reason: 'wrong_event_type' })
    const res1 = mockRes()
    await handler(
      mockReq('/affstore-postback?secret=test-secret&event_id=e2&trader_id=T9&postback_name=deposit&amount=50'),
      res1,
    )
    expect(insertS2S).toHaveBeenLastCalledWith(expect.objectContaining({ eventType: 'ftd', amount: 50 }))

    hasFtdForTrader.mockResolvedValue(true)
    const res2 = mockRes()
    await handler(
      mockReq('/affstore-postback?secret=test-secret&event_id=e3&trader_id=T9&postback_name=deposit&amount=20'),
      res2,
    )
    expect(insertS2S).toHaveBeenLastCalledWith(expect.objectContaining({ eventType: 'redeposit', amount: 20 }))
  })

  it('classifies short affstore names used by NOXA', async () => {
    attributePostback.mockResolvedValue({ matched: false, reason: 'unknown_click_id' })

    const reg = mockRes()
    await handler(
      mockReq('/affstore-postback?secret=test-secret&event_id=e6&trader_id=T6&postback_name=Noxa%20reg&clickid=NOX0000000000000060'),
      reg,
    )
    expect(insertS2S).toHaveBeenLastCalledWith(expect.objectContaining({
      traderId: 'T6',
      eventType: 'registration',
    }))

    const redepo = mockRes()
    await handler(
      mockReq('/affstore-postback?secret=test-secret&event_id=e7&trader_id=T6&postback_name=Noxa%20Redepo&amount=25'),
      redepo,
    )
    expect(insertS2S).toHaveBeenLastCalledWith(expect.objectContaining({
      traderId: 'T6',
      eventType: 'redeposit',
      amount: 25,
    }))
  })

  it('responds 200 on unmatched registration (does not retry)', async () => {
    attributePostback.mockResolvedValue({ matched: false, reason: 'unknown_click_id' })
    const res = mockRes()
    await handler(
      mockReq('/affstore-postback?secret=test-secret&event_id=e4&trader_id=T2&postback_name=registration&clickid=NOXSTRANGE000000000'),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(notifySignupConfirmed).not.toHaveBeenCalled()
  })

  it('returns 200 even when insertS2S throws (avoids retry storm)', async () => {
    insertS2S.mockRejectedValue(new Error('db down'))
    const res = mockRes()
    await handler(
      mockReq('/affstore-postback?secret=test-secret&event_id=e5&trader_id=T7&postback_name=registration&clickid=NOX0000000000000010'),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(notifySignupConfirmed).not.toHaveBeenCalled()
  })
})
