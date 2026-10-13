import type { Telegram } from 'telegraf'
import type { PgBoss } from 'pg-boss'
import { getBoss } from './boss.js'
import { userRepo } from '../core/repositories/index.js'
import { applyEventDetached } from '../bot/scenes/_bridge.js'
import { refreshUserBalance } from '../bot/scenes/_sceneHelpers.js'
import { requiredBalanceFor } from '../core/services/tierService.js'
import { getLogger } from '../infra/logger.js'

const QUEUE_NAME = 'deposit-poll'
const POLL_INTERVAL_SECONDS = 30
export const DEPOSIT_POLL_MAX_ATTEMPTS = 40

type JobData = { telegramId: string; attempt: number }

export async function scheduleDepositPoll(
  telegramId: bigint,
  attempt = 1,
  delaySeconds = POLL_INTERVAL_SECONDS,
): Promise<void> {
  const boss = await getBoss()
  await boss.send(
    QUEUE_NAME,
    { telegramId: telegramId.toString(), attempt },
    {
      startAfter: delaySeconds,
      singletonKey: telegramId.toString(),
    },
  )
}

export async function cancelDepositPoll(_telegramId: bigint): Promise<void> {
  void _telegramId
}

const DEPOSIT_POLL_CONCURRENCY = 10

export function registerDepositPollWorker(boss: PgBoss, telegram: Telegram) {
  return boss.work<JobData>(
    QUEUE_NAME,
    { batchSize: 1, localConcurrency: DEPOSIT_POLL_CONCURRENCY },
    async (jobs) => {
      const job = jobs[0]
      if (!job) return
      const telegramId = BigInt(job.data.telegramId)
      const attempt = Number(job.data.attempt ?? 1)
      const log = getLogger().child({
        event: 'deposit_poll',
        telegramId: telegramId.toString(),
        attempt,
      })

      const user = await userRepo.findById(telegramId)
      if (!user) return
      if ((user.flow_stage || '').toUpperCase() !== 'DEPOSIT_GATE') {
        log.debug({ flowStage: user.flow_stage }, 'deposit poll: user no longer at gate, stopping')
        return
      }

      const flow = user.flow_data ?? {}
      const requestedTier =
        flow.requestedTier === 'pro' ? 'pro' : flow.requestedTier === 'auto' ? 'auto' : 'auto'
      const threshold = requiredBalanceFor(requestedTier)

      let balance = 0
      try {
        balance = await refreshUserBalance(telegramId, 'live')
      } catch (err) {
        log.warn({ err }, 'deposit poll: balance refresh failed')
        balance = Number(user.iq_balance_cached ?? 0)
      }

      if (balance >= threshold) {
        log.info({ balance, threshold }, 'deposit poll: balance met threshold, confirming')
        try {
          // Achievement flag write — fires before the state-machine
          // transition because the routing model treats first_deposit_at
          // as the canonical "user has funded" signal. Idempotent at
          // the repo layer; the boolean tells us whether this is the
          // first time we've recorded it.
          const wasFirstSet = await userRepo
            .markFirstDeposit(telegramId, 'balance_poll')
            .catch(() => false)
          if (wasFirstSet) {
            log.info(
              { event: 'first_deposit_recorded', source: 'balance_poll', balance },
              'first deposit recorded from balance poll',
            )
          }
          const result = await applyEventDetached(
            telegramId,
            requestedTier === 'pro'
              ? { type: 'DEPOSIT_CONFIRMED_PRO' }
              : { type: 'DEPOSIT_CONFIRMED_AUTO' },
            {
              flowDataPatch: {
                desiredAccountMode: 'live',
                depositConfirmedAt: new Date().toISOString(),
                loginAttempts: 0,
              },
            },
          )
          await telegram
            .sendMessage(
              Number(telegramId),
              [
                requestedTier === 'pro' ? '💎 PRO deposit confirmed.' : '🔥 AUTO deposit confirmed.',
                '',
                'Tap below to continue.',
              ].join('\n'),
              {
                reply_markup: {
                  inline_keyboard: [[{ text: 'Continue', callback_data: 'DEPOSIT_CONFIRMED_CONTINUE' }]],
                },
              },
            )
            .catch(() => {})
          log.debug({ nextStage: result.nextStage }, 'deposit poll: detached transition succeeded')
        } catch (err) {
          log.error({ err }, 'deposit poll: detached transition failed')
        }
        return
      }

      if (attempt >= DEPOSIT_POLL_MAX_ATTEMPTS) {
        log.info(
          { balance, threshold, max: DEPOSIT_POLL_MAX_ATTEMPTS },
          'deposit poll: max attempts reached, stopping; user must use manual tap',
        )
        return
      }

      await scheduleDepositPoll(telegramId, attempt + 1)
    },
  )
}
