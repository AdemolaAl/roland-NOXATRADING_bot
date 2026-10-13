import { assign, setup } from 'xstate'
import type { FullTier } from './services/tierService.js'

export type MachineContext = {
  tier: FullTier
  accountMode: 'demo' | 'live'
  agreementAccepted: boolean
  liveWinCount: number
  iqLoggedIn: boolean
}

export type MachineEvent =
  | { type: 'CHANNEL_GATE_PASSED' }
  | { type: 'PICKED_DEMO' }
  | { type: 'PICKED_AUTO' }
  | { type: 'PICKED_PRO' }
  | { type: 'IQ_CREATE_ACCOUNT' }
  | { type: 'IQ_SIGNUP_DONE' }
  | { type: 'IQ_SIGNUP_CONFIRMED' }
  | { type: 'EMAIL_PROVIDED' }
  | { type: 'PASSWORD_PROVIDED' }
  | { type: 'IQ_LOGIN_SUCCESS_PARTNER' }
  | { type: 'IQ_LOGIN_SUCCESS_NON_PARTNER' }
  | { type: 'IQ_LOGIN_FAIL_RETRY' }
  | { type: 'IQ_LOGIN_FAIL_LOCKED' }
  | { type: 'AGREEMENT_ACCEPTED_DEMO' }
  | { type: 'AGREEMENT_ACCEPTED_AUTO' }
  | { type: 'AGREEMENT_ACCEPTED_PRO' }
  | { type: 'AGREEMENT_DECLINED' }
  | { type: 'DEPOSIT_CONFIRMED_AUTO' }
  | { type: 'DEPOSIT_CONFIRMED_PRO' }
  | { type: 'NPR_RESTART' }
  | { type: 'ACCOUNT_TYPE_PICKED'; mode: 'demo' | 'live' }
  | { type: 'TIMEFRAME_PICKED'; timeframe: '30s' | '1m' | '2m' | '5m' }
  | { type: 'PAIR_PICKED' }
  | { type: 'PRO_PAIR_1_PICKED' }
  | { type: 'PRO_PAIR_2_PICKED' }
  | { type: 'PRO_PAIR_3_PICKED' }
  | { type: 'AMOUNT_PICKED' }
  | { type: 'AMOUNT_CUSTOM_REQUESTED' }
  | { type: 'CUSTOM_AMOUNT_PROVIDED' }
  | { type: 'TRADE_WON' }
  | { type: 'TRADE_LOST' }
  | { type: 'CELEBRATION_DONE' }
  | { type: 'TAKE_ANOTHER' }
  | { type: 'STOP' }
  | { type: 'SWITCH_TO_LIVE' }
  | { type: 'STAY_DEMO' }
  | { type: 'UNLOCK_PRO' }
  | { type: 'CONTINUE_AUTO' }
  | { type: 'GOTO_TIMEFRAME' }
  | { type: 'GOTO_CELEBRATION' }

export const noxatradingMachine = setup({
  types: {} as {
    context: MachineContext
    events: MachineEvent
    input: MachineContext
  },
  guards: {
    iqLoggedIn: ({ context }) => context.iqLoggedIn,
    iqNotLoggedIn: ({ context }) => !context.iqLoggedIn,
    isPro: ({ context }) => context.tier === 'pro',
    notPro: ({ context }) => context.tier !== 'pro',
    isDemoMode: ({ context }) => context.accountMode === 'demo',
    fifthLiveWin: ({ context }) =>
      context.accountMode === 'live' &&
      context.tier === 'auto' &&
      context.liveWinCount % 5 === 0 &&
      context.liveWinCount > 0,
  },
  actions: {
    setAutoTier: assign({
      tier: () => 'auto',
    }),
    setProTier: assign({
      tier: () => 'pro',
    }),
    setIqLoggedIn: assign({
      iqLoggedIn: () => true,
    }),
    setAgreementAccepted: assign({
      agreementAccepted: () => true,
    }),
    setMode: assign({
      accountMode: ({ event }) =>
        (event as Extract<MachineEvent, { type: 'ACCOUNT_TYPE_PICKED' }>).mode,
    }),
  },
}).createMachine({
  id: 'noxatrading',
  initial: 'CHANNEL_GATE',
  context: ({ input }) => input,
  on: {
    GOTO_TIMEFRAME: '.TIMEFRAME',
    GOTO_CELEBRATION: '.CELEBRATION',
  },
  states: {
    CHANNEL_GATE: {
      on: {
        CHANNEL_GATE_PASSED: 'WELCOME',
      },
    },
    WELCOME: {
      on: {
        PICKED_DEMO: 'IQ_ACCOUNT_GATE',
        PICKED_AUTO: 'IQ_ACCOUNT_GATE',
        PICKED_PRO: 'IQ_ACCOUNT_GATE',
      },
    },
    IQ_ACCOUNT_GATE: {
      on: {
        IQ_CREATE_ACCOUNT: 'IQ_SIGNUP_HELP',
      },
    },
    IQ_SIGNUP_HELP: {
      on: {
        IQ_SIGNUP_DONE: 'LOGIN_EMAIL',
        IQ_SIGNUP_CONFIRMED: 'LOGIN_EMAIL',
      },
    },
    LOGIN_EMAIL: {
      on: {
        EMAIL_PROVIDED: 'LOGIN_PASSWORD',
      },
    },
    LOGIN_PASSWORD: {
      on: {
        PASSWORD_PROVIDED: 'LOGIN_VERIFYING',
      },
    },
    LOGIN_VERIFYING: {
      on: {
        IQ_LOGIN_SUCCESS_PARTNER: { target: 'AGREEMENT', actions: 'setIqLoggedIn' },
        IQ_LOGIN_SUCCESS_NON_PARTNER: { target: 'NON_PARTNER_REJECT', actions: 'setIqLoggedIn' },
        IQ_LOGIN_FAIL_RETRY: 'LOGIN_EMAIL',
        IQ_LOGIN_FAIL_LOCKED: 'SUPPORT_HANDOFF',
      },
    },
    AGREEMENT: {
      on: {
        AGREEMENT_ACCEPTED_DEMO: { target: 'ACCOUNT_TYPE', actions: 'setAgreementAccepted' },
        AGREEMENT_ACCEPTED_AUTO: { target: 'DEPOSIT_GATE', actions: 'setAgreementAccepted' },
        AGREEMENT_ACCEPTED_PRO: { target: 'DEPOSIT_GATE', actions: 'setAgreementAccepted' },
        AGREEMENT_DECLINED: 'WELCOME',
      },
    },
    DEPOSIT_GATE: {
      on: {
        DEPOSIT_CONFIRMED_AUTO: { target: 'ACCOUNT_TYPE', actions: 'setAutoTier' },
        DEPOSIT_CONFIRMED_PRO: { target: 'ACCOUNT_TYPE', actions: 'setProTier' },
      },
    },
    NON_PARTNER_REJECT: {
      on: {
        NPR_RESTART: 'WELCOME',
      },
    },
    SUPPORT_HANDOFF: {
      on: {
        NPR_RESTART: 'WELCOME',
      },
    },
    ACCOUNT_TYPE: {
      on: {
        ACCOUNT_TYPE_PICKED: { target: 'TIMEFRAME', actions: 'setMode' },
      },
    },
    TIMEFRAME: {
      on: {
        TIMEFRAME_PICKED: [
          { target: 'PAIR_SELECT_PRO_1', guard: 'isPro' },
          { target: 'PAIR_SELECTION', guard: 'notPro' },
        ],
      },
    },
    PAIR_SELECTION: {
      on: {
        PAIR_PICKED: 'AMOUNT',
      },
    },
    PAIR_SELECT_PRO_1: {
      on: {
        PRO_PAIR_1_PICKED: 'PAIR_SELECT_PRO_2',
      },
    },
    PAIR_SELECT_PRO_2: {
      on: {
        PRO_PAIR_2_PICKED: 'PAIR_SELECT_PRO_3',
      },
    },
    PAIR_SELECT_PRO_3: {
      on: {
        PRO_PAIR_3_PICKED: 'AMOUNT_PRO',
      },
    },
    AMOUNT: {
      on: {
        AMOUNT_PICKED: 'TRADE_EXECUTING',
        AMOUNT_CUSTOM_REQUESTED: 'AMOUNT_CUSTOM',
      },
    },
    AMOUNT_CUSTOM: {
      on: {
        CUSTOM_AMOUNT_PROVIDED: 'TRADE_EXECUTING',
      },
    },
    AMOUNT_PRO: {
      on: {
        AMOUNT_PICKED: 'TRADE_EXECUTING_PRO',
      },
    },
    TRADE_EXECUTING: {
      on: {
        TRADE_WON: 'CELEBRATION',
        TRADE_LOST: 'CELEBRATION',
      },
    },
    TRADE_EXECUTING_PRO: {
      on: {
        TRADE_WON: 'CELEBRATION_PRO',
        TRADE_LOST: 'CELEBRATION_PRO',
      },
    },
    CELEBRATION: {
      on: {
        CELEBRATION_DONE: [
          { target: 'DEMO_CONVERSION', guard: 'isDemoMode' },
          { target: 'PRO_UPSELL', guard: 'fifthLiveWin' },
          { target: 'POST_TRADE_MENU' },
        ],
      },
    },
    CELEBRATION_PRO: {
      on: {
        CELEBRATION_DONE: 'POST_TRADE_MENU',
      },
    },
    DEMO_CONVERSION: {
      on: {
        SWITCH_TO_LIVE: 'DEPOSIT_GATE',
        STAY_DEMO: 'TIMEFRAME',
      },
    },
    PRO_UPSELL: {
      on: {
        UNLOCK_PRO: 'DEPOSIT_GATE',
        CONTINUE_AUTO: 'TIMEFRAME',
      },
    },
    POST_TRADE_MENU: {
      on: {
        TAKE_ANOTHER: 'TIMEFRAME',
        STOP: 'IDLE',
      },
    },
    IDLE: {
      on: {},
    },
  },
})
