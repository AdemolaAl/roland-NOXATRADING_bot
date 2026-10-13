import { describe, expect, it } from '@jest/globals'
import { testPool, resetDb } from '../fixtures/testDb.js'
import { UserRepository } from '../../src/core/repositories/userRepo.js'
import { createActor } from 'xstate'
import { noxatradingMachine } from '../../src/core/stateMachine.js'

describe('onboarding flow integration', () => {
  it('moves from welcome to post-trade style path with deposit gating and login', async () => {
    await resetDb()
    const users = new UserRepository(testPool)
    const { user } = await users.createIfMissing(123n, 'alice')

    const actor = createActor(noxatradingMachine, {
      input: {
        tier: user.tier,
        accountMode: user.account_mode,
        agreementAccepted: user.agreement_accepted,
        liveWinCount: user.live_win_count,
        iqLoggedIn: false,
      },
    }).start()

    actor.send({ type: 'CHANNEL_GATE_PASSED' })
    actor.send({ type: 'PICKED_AUTO' })
    actor.send({ type: 'IQ_CREATE_ACCOUNT' })
    actor.send({ type: 'IQ_SIGNUP_DONE' })
    actor.send({ type: 'EMAIL_PROVIDED' })
    actor.send({ type: 'PASSWORD_PROVIDED' })
    actor.send({ type: 'IQ_LOGIN_SUCCESS_PARTNER' })
    actor.send({ type: 'AGREEMENT_ACCEPTED_AUTO' })
    actor.send({ type: 'DEPOSIT_CONFIRMED_AUTO' })
    actor.send({ type: 'ACCOUNT_TYPE_PICKED', mode: 'live' })
    actor.send({ type: 'TIMEFRAME_PICKED', timeframe: '1m' })
    actor.send({ type: 'PAIR_PICKED' })
    actor.send({ type: 'AMOUNT_PICKED' })
    actor.send({ type: 'TRADE_WON' })
    actor.send({ type: 'CELEBRATION_DONE' })

    expect(['DEMO_CONVERSION', 'POST_TRADE_MENU']).toContain(String(actor.getSnapshot().value))
  })
})
