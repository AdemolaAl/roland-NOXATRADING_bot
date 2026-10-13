import { describe, expect, it } from '@jest/globals'
import { createActor } from 'xstate'
import { noxatradingMachine } from './stateMachine.js'

const ctx = (overrides = {}) => ({
  tier: 'demo' as const,
  accountMode: 'demo' as const,
  agreementAccepted: false,
  liveWinCount: 0,
  iqLoggedIn: false,
  ...overrides,
})

function startedAtWelcome(input = ctx()) {
  const actor = createActor(noxatradingMachine, { input }).start()
  actor.send({ type: 'CHANNEL_GATE_PASSED' })
  return actor
}

describe('noxatradingMachine', () => {
  it('starts at CHANNEL_GATE', () => {
    const actor = createActor(noxatradingMachine, { input: ctx() }).start()
    expect(actor.getSnapshot().value).toBe('CHANNEL_GATE')
  })

  it('CHANNEL_GATE → WELCOME on CHANNEL_GATE_PASSED', () => {
    const actor = createActor(noxatradingMachine, { input: ctx() }).start()
    actor.send({ type: 'CHANNEL_GATE_PASSED' })
    expect(actor.getSnapshot().value).toBe('WELCOME')
  })

  it('all entry modes go through IQ_ACCOUNT_GATE', () => {
    const demo = startedAtWelcome()
    demo.send({ type: 'PICKED_DEMO' })
    expect(demo.getSnapshot().value).toBe('IQ_ACCOUNT_GATE')

    const auto = startedAtWelcome()
    auto.send({ type: 'PICKED_AUTO' })
    expect(auto.getSnapshot().value).toBe('IQ_ACCOUNT_GATE')

    const pro = startedAtWelcome()
    pro.send({ type: 'PICKED_PRO' })
    expect(pro.getSnapshot().value).toBe('IQ_ACCOUNT_GATE')
  })

  it('signup path reaches LOGIN_EMAIL', () => {
    const actor = startedAtWelcome()
    actor.send({ type: 'PICKED_AUTO' })
    actor.send({ type: 'IQ_CREATE_ACCOUNT' })
    actor.send({ type: 'IQ_SIGNUP_DONE' })
    expect(actor.getSnapshot().value).toBe('LOGIN_EMAIL')
  })

  it('confirmed signup path reaches LOGIN_EMAIL', () => {
    const actor = startedAtWelcome()
    actor.send({ type: 'PICKED_PRO' })
    actor.send({ type: 'IQ_CREATE_ACCOUNT' })
    actor.send({ type: 'IQ_SIGNUP_CONFIRMED' })
    expect(actor.getSnapshot().value).toBe('LOGIN_EMAIL')
  })

  it('partner login reaches AGREEMENT', () => {
    const actor = startedAtWelcome()
    actor.send({ type: 'PICKED_AUTO' })
    actor.send({ type: 'IQ_CREATE_ACCOUNT' })
    actor.send({ type: 'IQ_SIGNUP_DONE' })
    actor.send({ type: 'EMAIL_PROVIDED' })
    actor.send({ type: 'PASSWORD_PROVIDED' })
    actor.send({ type: 'IQ_LOGIN_SUCCESS_PARTNER' })
    expect(actor.getSnapshot().value).toBe('AGREEMENT')
  })

  it('non-partner login reaches NON_PARTNER_REJECT', () => {
    const actor = startedAtWelcome()
    actor.send({ type: 'PICKED_AUTO' })
    actor.send({ type: 'IQ_CREATE_ACCOUNT' })
    actor.send({ type: 'IQ_SIGNUP_DONE' })
    actor.send({ type: 'EMAIL_PROVIDED' })
    actor.send({ type: 'PASSWORD_PROVIDED' })
    actor.send({ type: 'IQ_LOGIN_SUCCESS_NON_PARTNER' })
    expect(actor.getSnapshot().value).toBe('NON_PARTNER_REJECT')
  })

  it('login failure retries then locks to SUPPORT_HANDOFF', () => {
    const actor = startedAtWelcome()
    actor.send({ type: 'PICKED_AUTO' })
    actor.send({ type: 'IQ_CREATE_ACCOUNT' })
    actor.send({ type: 'IQ_SIGNUP_DONE' })
    actor.send({ type: 'EMAIL_PROVIDED' })
    actor.send({ type: 'PASSWORD_PROVIDED' })
    actor.send({ type: 'IQ_LOGIN_FAIL_RETRY' })
    expect(actor.getSnapshot().value).toBe('LOGIN_EMAIL')

    actor.send({ type: 'EMAIL_PROVIDED' })
    actor.send({ type: 'PASSWORD_PROVIDED' })
    actor.send({ type: 'IQ_LOGIN_FAIL_LOCKED' })
    expect(actor.getSnapshot().value).toBe('SUPPORT_HANDOFF')
  })

  it('agreement sends demo to ACCOUNT_TYPE and live tiers to DEPOSIT_GATE', () => {
    const demo = createActor(noxatradingMachine, { input: ctx({ iqLoggedIn: true }) }).start()
    demo.send({ type: 'GOTO_CELEBRATION' })
    demo.stop()

    const actorDemo = startedAtWelcome(ctx({ iqLoggedIn: true }))
    actorDemo.send({ type: 'PICKED_DEMO' })
    actorDemo.send({ type: 'IQ_CREATE_ACCOUNT' })
    actorDemo.send({ type: 'IQ_SIGNUP_DONE' })
    actorDemo.send({ type: 'EMAIL_PROVIDED' })
    actorDemo.send({ type: 'PASSWORD_PROVIDED' })
    actorDemo.send({ type: 'IQ_LOGIN_SUCCESS_PARTNER' })
    actorDemo.send({ type: 'AGREEMENT_ACCEPTED_DEMO' })
    expect(actorDemo.getSnapshot().value).toBe('ACCOUNT_TYPE')

    const actorAuto = startedAtWelcome()
    actorAuto.send({ type: 'PICKED_AUTO' })
    actorAuto.send({ type: 'IQ_CREATE_ACCOUNT' })
    actorAuto.send({ type: 'IQ_SIGNUP_DONE' })
    actorAuto.send({ type: 'EMAIL_PROVIDED' })
    actorAuto.send({ type: 'PASSWORD_PROVIDED' })
    actorAuto.send({ type: 'IQ_LOGIN_SUCCESS_PARTNER' })
    actorAuto.send({ type: 'AGREEMENT_ACCEPTED_AUTO' })
    expect(actorAuto.getSnapshot().value).toBe('DEPOSIT_GATE')
  })

  it('deposit confirmation promotes tier and reaches ACCOUNT_TYPE', () => {
    const auto = startedAtWelcome()
    auto.send({ type: 'PICKED_AUTO' })
    auto.send({ type: 'IQ_CREATE_ACCOUNT' })
    auto.send({ type: 'IQ_SIGNUP_DONE' })
    auto.send({ type: 'EMAIL_PROVIDED' })
    auto.send({ type: 'PASSWORD_PROVIDED' })
    auto.send({ type: 'IQ_LOGIN_SUCCESS_PARTNER' })
    auto.send({ type: 'AGREEMENT_ACCEPTED_AUTO' })
    auto.send({ type: 'DEPOSIT_CONFIRMED_AUTO' })
    expect(auto.getSnapshot().value).toBe('ACCOUNT_TYPE')
    expect(auto.getSnapshot().context.tier).toBe('auto')

    const pro = startedAtWelcome()
    pro.send({ type: 'PICKED_PRO' })
    pro.send({ type: 'IQ_CREATE_ACCOUNT' })
    pro.send({ type: 'IQ_SIGNUP_DONE' })
    pro.send({ type: 'EMAIL_PROVIDED' })
    pro.send({ type: 'PASSWORD_PROVIDED' })
    pro.send({ type: 'IQ_LOGIN_SUCCESS_PARTNER' })
    pro.send({ type: 'AGREEMENT_ACCEPTED_PRO' })
    pro.send({ type: 'DEPOSIT_CONFIRMED_PRO' })
    expect(pro.getSnapshot().value).toBe('ACCOUNT_TYPE')
    expect(pro.getSnapshot().context.tier).toBe('pro')
  })

  it('PRO tier routes pair selection to PAIR_SELECT_PRO_1', () => {
    const actor = createActor(noxatradingMachine, {
      input: ctx({ tier: 'pro', agreementAccepted: true }),
    }).start()
    actor.send({ type: 'GOTO_TIMEFRAME' })
    actor.send({ type: 'TIMEFRAME_PICKED', timeframe: '1m' })
    expect(actor.getSnapshot().value).toBe('PAIR_SELECT_PRO_1')
  })

  it('demo win → DEMO_CONVERSION', () => {
    const actor = createActor(noxatradingMachine, {
      input: ctx({ accountMode: 'demo' }),
    }).start()
    actor.send({ type: 'GOTO_CELEBRATION' })
    actor.send({ type: 'CELEBRATION_DONE' })
    expect(actor.getSnapshot().value).toBe('DEMO_CONVERSION')
  })

  it('SWITCH_TO_LIVE now routes to DEPOSIT_GATE', () => {
    const actor = createActor(noxatradingMachine, {
      input: ctx({ accountMode: 'demo' }),
    }).start()
    actor.send({ type: 'GOTO_CELEBRATION' })
    actor.send({ type: 'CELEBRATION_DONE' })
    actor.send({ type: 'SWITCH_TO_LIVE' })
    expect(actor.getSnapshot().value).toBe('DEPOSIT_GATE')
  })

  it('5th live win → PRO_UPSELL and UNLOCK_PRO routes to DEPOSIT_GATE', () => {
    const actor = createActor(noxatradingMachine, {
      input: ctx({ accountMode: 'live', tier: 'auto', liveWinCount: 5 }),
    }).start()
    actor.send({ type: 'GOTO_CELEBRATION' })
    actor.send({ type: 'CELEBRATION_DONE' })
    expect(actor.getSnapshot().value).toBe('PRO_UPSELL')
    actor.send({ type: 'UNLOCK_PRO' })
    expect(actor.getSnapshot().value).toBe('DEPOSIT_GATE')
  })
})
