import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Telegram } from 'telegraf'
import { iqPostbackRepo, userRepo } from '../core/repositories/index.js'
import { attributePostback } from '../core/services/affstoreAttribution.js'
import { handlePostbackNotifications } from '../core/services/affstoreDepositNotifier.js'
import { notifySignupConfirmed } from '../core/services/signupConfirmedNotifier.js'
import { loadEnv } from '../infra/env.js'
import { getLogger } from '../infra/logger.js'

export type AffstorePostbackHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

type PostbackEventType = 'registration' | 'ftd' | 'redeposit' | 'payout' | 'other'

// Normalises Affstore's free-form 'postback_name' field into our fixed
// event_type enum. Affstore sends things like 'Registration',
// 'first_deposit', 're-deposit', 'payout', sometimes with mixed case.
// FTD vs redeposit is finalised after the DB check (first one wins).
function classifyEvent(postbackName: string, amount: number | null): PostbackEventType {
  const name = postbackName.toLowerCase().replace(/[-_\s]/g, '')
  if (
    name.includes('registration') ||
    name === 'signup' ||
    name.endsWith('reg') ||
    name === 'reg'
  ) return 'registration'
  if (name.includes('payout') || name.includes('withdraw')) return 'payout'
  if (name.includes('redepo') || name.includes('redeposit')) {
    return 'redeposit'
  }
  if (name.includes('deposit') || name.includes('ftd')) {
    // The handler will downgrade to 'redeposit' if a prior FTD exists.
    return 'ftd'
  }
  if (amount !== null && amount > 0) return 'ftd'
  return 'other'
}

function constantTimeEquals(a: string, b: string): boolean {
  // Hash both sides to a fixed-length digest so timingSafeEqual receives
  // equal-length buffers regardless of input length. Without this, the
  // length-mismatch short-circuit leaks the correct secret length via
  // observable timing differences.
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

// Factory so tests can inject a mock Telegram instance.
export function createAffstorePostbackHandler(deps: { telegram: Telegram }): AffstorePostbackHandler {
  return async function handle(req, res) {
    const logger = getLogger()

    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const query = url.searchParams

    const env = loadEnv()
    const expected = env.AFFSTORE_POSTBACK_SECRET ?? ''
    const got = query.get('secret') ?? ''
    if (expected && !constantTimeEquals(expected, got)) {
      logger.warn(
        { event: 'postback_s2s_auth_failed', hasSecret: Boolean(got) },
        'affstore postback rejected — secret mismatch',
      )
      res.writeHead(401).end()
      return
    }

    const traderId = query.get('trader_id') ?? ''
    const postbackName = query.get('postback_name') ?? ''
    if (!traderId || !postbackName) {
      logger.warn(
        { event: 'postback_parse_failed', traderId, postbackName },
        'affstore postback missing trader_id or postback_name',
      )
      res.writeHead(400).end()
      return
    }

    try {
      const clickid = query.get('clickid') || null
      const afftrack = query.get('afftrack') || null
      const countryCode = query.get('country_code') || null
      const rawAmount = query.get('amount')
      const amount = rawAmount !== null && rawAmount !== '' ? Number(rawAmount) : null
      const eventId = query.get('event_id') ?? `${traderId}:${postbackName}:${rawAmount ?? ''}`

      let eventType = classifyEvent(postbackName, amount)
      if (eventType === 'ftd' && (await iqPostbackRepo.hasFtdForTrader(traderId))) {
        eventType = 'redeposit'
      }

      logger.info(
        {
          event: 'postback_s2s_received',
          traderId,
          eventType,
          clickid,
          afftrack,
          amount,
          countryCode,
        },
        'affstore S2S postback received',
      )

      await iqPostbackRepo.insertS2S({
        traderId,
        eventType,
        rawEvent: postbackName,
        amount: Number.isFinite(amount) ? amount : null,
        countryCode,
        afftrack,
        clickid,
        rawText: req.url ?? '',
        idempotencyKey: eventId,
      })

      if (eventType === 'registration') {
        const result = await attributePostback(
          { clickId: clickid ?? '', traderId, eventType },
          's2s',
        )
        if (result.matched) {
          logger.info(
            {
              event: 'attribution_confirmed',
              telegramId: result.telegramId.toString(),
              traderId,
              tierIntent: result.tierIntent,
            },
            'attribution confirmed; sending signup-confirmed DM',
          )
          await notifySignupConfirmed(deps.telegram, result.telegramId)
        } else {
          logger.info(
            {
              event: 'attribution_skipped',
              reason: result.reason,
              traderId,
              clickid,
            },
            `attribution skipped — ${result.reason}`,
          )
        }
      }

      // Deposit attribution. FTD/redeposit postbacks don't carry a
      // clickid (only the registration postback does), so we resolve
      // trader_id → telegram_id via the users table directly. This is
      // a no-op for traders we haven't matched to a Telegram user via
      // a prior registration postback.
      if (eventType === 'ftd' || eventType === 'redeposit') {
        const matches = await userRepo.findByIqTraderId(traderId)
        for (const user of matches) {
          const wasFirstSet = await userRepo
            .markFirstDeposit(BigInt(user.telegram_id), 'postback')
            .catch((err) => {
              logger.warn(
                { err, event: 'first_deposit_mark_failed_postback', traderId, telegramId: user.telegram_id },
                'failed to mark first_deposit_at from postback',
              )
              return false
            })
          if (wasFirstSet) {
            logger.info(
              {
                event: 'first_deposit_recorded',
                source: 'postback',
                telegramId: user.telegram_id,
                traderId,
                eventType,
              },
              'first deposit recorded from postback',
            )
          }
        }
      }

      await handlePostbackNotifications(deps.telegram, {
        traderId,
        eventType,
        amount: Number.isFinite(amount) ? amount : null,
        currency: query.get('currency') || null,
        country: countryCode,
        afftrack,
        clickId: clickid,
      })
    } catch (err) {
      logger.error(
        { err, event: 'postback_s2s_persist_failed', traderId, postbackName },
        'affstore postback processing failed — returning 200 anyway to prevent retry storm',
      )
    }

    // Always 200 on successful parse — even for unattributable rows or transient
    // DB errors. Affstore retries non-2xx forever; dropping the event is better
    // than triggering a retry storm.
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('OK')
  }
}
