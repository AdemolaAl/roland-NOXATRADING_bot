import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { accountTypeScene } from './accountType.scene.js'
import { agreementScene } from './agreement.scene.js'
import { amountCustomScene, amountProScene, amountScene } from './amount.scene.js'
import { celebrationProScene, celebrationScene } from './celebration.scene.js'
import { channelGateScene } from './channelGate.scene.js'
import { demoConversionScene, proUpsellScene } from './demoConversion.scene.js'
import { depositGateScene } from './depositGate.scene.js'
import { helpFaqScene } from './helpFaq.scene.js'
import { homeHistoryScene } from './homeHistory.scene.js'
import { homeScene } from './home.scene.js'
import { iqAccountGateScene } from './iqAccountGate.scene.js'
import { iqSignupHelpScene } from './iqSignupHelp.scene.js'
import { loginEmailScene } from './loginEmail.scene.js'
import { loginPasswordScene } from './loginPassword.scene.js'
import { loginVerifyingScene } from './loginVerifying.scene.js'
import { pairSelectionScene } from './pairSelection.scene.js'
import { postTradeMenuScene, statsViewScene, idleScene } from './postTradeMenu.scene.js'
import { proPair1Scene, proPair2Scene, proPair3Scene } from './proPair1.scene.js'
import { nonPartnerRejectScene } from './nonPartnerReject.scene.js'
import { supportHandoffScene } from './supportHandoff.scene.js'
import { timeframeScene } from './timeframe.scene.js'
import { tradeExecutingProScene } from './tradeExecutingPro.scene.js'
import { tradeExecutingScene } from './tradeExecuting.scene.js'
import { welcomeScene } from './welcome.scene.js'

export const allScenes = [
  channelGateScene,
  welcomeScene,
  iqAccountGateScene,
  iqSignupHelpScene,
  loginEmailScene,
  loginPasswordScene,
  loginVerifyingScene,
  agreementScene,
  depositGateScene,
  nonPartnerRejectScene,
  supportHandoffScene,
  accountTypeScene,
  timeframeScene,
  pairSelectionScene,
  proPair1Scene,
  proPair2Scene,
  proPair3Scene,
  amountScene,
  amountCustomScene,
  amountProScene,
  tradeExecutingScene,
  tradeExecutingProScene,
  celebrationScene,
  celebrationProScene,
  demoConversionScene,
  proUpsellScene,
  postTradeMenuScene,
  statsViewScene,
  idleScene,
  homeScene,
  homeHistoryScene,
  helpFaqScene,
] satisfies Array<Scenes.BaseScene<BotContext>>

export function createStage() {
  return new Scenes.Stage<BotContext>(allScenes)
}
