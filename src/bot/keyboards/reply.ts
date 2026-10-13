import { Markup } from 'telegraf'
import type { PairWithRate } from '../../core/services/pairGenerator.js'

export function mainMenuKeyboard() {
  return Markup.keyboard([['Main Menu']]).resize()
}

export function pairKeyboard(pairs: PairWithRate[]) {
  return Markup.keyboard([
    pairs.slice(0, 2).map((pair) => `${pair.label} ${pair.winRate}%`),
    pairs.slice(2, 4).map((pair) => `${pair.label} ${pair.winRate}%`),
    ['Main Menu'],
  ]).resize()
}

// Demo gets a small fixed range — paper money, capped at $20 so the gale
// ladder (×2.3 per step) still feels meaningful without burning their
// $10k demo balance in two trades. No Custom — keeps demo bounded.
const DEMO_AMOUNTS = ['$1', '$2', '$5', '$10', '$20']

// Live gets the larger spread plus a Custom escape hatch.
const LIVE_AMOUNTS = ['$10', '$20', '$50', '$100', '$200', '$500']

export const DEMO_MAX_STAKE = 20

export function amountKeyboard(mode: 'demo' | 'live') {
  if (mode === 'demo') {
    return Markup.keyboard([DEMO_AMOUNTS.slice(0, 3), DEMO_AMOUNTS.slice(3), ['Main Menu']]).resize()
  }
  return Markup.keyboard([
    LIVE_AMOUNTS.slice(0, 3),
    LIVE_AMOUNTS.slice(3),
    ['Custom'],
    ['Main Menu'],
  ]).resize()
}
