import { Markup } from 'telegraf'

export function openingModeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🧪  Start with Demo', 'START_DEMO')],
    [Markup.button.callback('🚀  Real Account · Auto Mode', 'START_AUTO')],
    [Markup.button.callback('⚡  Real Account · PRO Mode', 'START_PRO')],
  ])
}

export function agreementKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Accept', 'AGREEMENT_ACCEPTED'),
      Markup.button.callback('Decline', 'AGREEMENT_DECLINED'),
    ],
  ])
}

export function iqAccountGateKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔗  Create my IQ Option account', 'IQ_CREATE_ACCOUNT')],
  ])
}

export function signupHelpKeyboard(signupUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.url('🔗  Open IQ Option — Create My Account', signupUrl)],
  ])
}

export function signupDoneKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅  Done — I Created My Account', 'IQ_SIGNUP_DONE')],
  ])
}

export function depositGateKeyboard(opts: { requestedTier: 'auto' | 'pro'; depositUrl: string }) {
  const openLabel =
    opts.requestedTier === 'pro'
      ? '💎  Deposit & Unlock PRO Mode'
      : '💰  Deposit & Unlock My Bot'
  const doneLabel =
    opts.requestedTier === 'pro'
      ? '✅  Done Depositing — Activate PRO'
      : '✅  Done Depositing — Activate NOXATRADING'

  return Markup.inlineKeyboard([
    [Markup.button.url(openLabel, opts.depositUrl)],
    [Markup.button.callback(doneLabel, 'DEPOSIT_DONE')],
  ])
}

export function restartOnboardingKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('↺  Start over', 'NPR_RESTART')]])
}

// The irreversible confirmation gate for /delete and the SELF_DELETE button.
export function confirmDeleteKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅  Yes, delete everything', 'SELF_DELETE_CONFIRM')],
    [Markup.button.callback('Cancel', 'SELF_DELETE_CANCEL')],
  ])
}

export function accountTypeKeyboard(showLive: boolean) {
  const buttons = [Markup.button.callback('Demo', 'ACCOUNT_DEMO')]
  if (showLive) {
    buttons.push(Markup.button.callback('Live', 'ACCOUNT_LIVE'))
  }
  return Markup.inlineKeyboard([buttons])
}

export function timeframeKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('30s', 'TIMEFRAME_30s'),
      Markup.button.callback('1m', 'TIMEFRAME_1m'),
    ],
    [
      Markup.button.callback('2m', 'TIMEFRAME_2m'),
      Markup.button.callback('5m', 'TIMEFRAME_5m'),
    ],
  ])
}

export function postTradeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Take Another', 'TAKE_ANOTHER')],
    [Markup.button.callback('View Stats', 'VIEW_STATS')],
    [Markup.button.callback('🏠  Main Menu', 'GO_HOME')],
    [Markup.button.callback('Stop', 'STOP')],
  ])
}

export function demoConversionKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💰  SWITCH TO LIVE — earn real money', 'SWITCH_TO_LIVE')],
    [Markup.button.callback('🧪  Continue DEMO — keep testing', 'STAY_DEMO')],
    [Markup.button.callback('📊  View Stats', 'VIEW_STATS')],
  ])
}

export function proUpsellKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Unlock PRO', 'UNLOCK_PRO')],
    [Markup.button.callback('Continue with AUTO', 'CONTINUE_AUTO')],
    [Markup.button.callback('View Stats', 'VIEW_STATS')],
  ])
}
