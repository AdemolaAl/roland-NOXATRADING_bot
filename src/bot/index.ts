import { Scenes, Telegraf, session } from 'telegraf'
import type { Context } from 'telegraf'
import { createStage } from './scenes/index.js'
import { loadEnv } from '../infra/env.js'
import { getLogger } from '../infra/logger.js'
import { activityMw } from './middleware/activity.js'
import { correlationMw } from './middleware/correlation.js'
import { earlyAckMw } from './middleware/earlyAck.js'
import { errorHandlerMw } from './middleware/errorHandler.js'
import { idempotencyMw } from './middleware/idempotency.js'
import { latencyMw } from './middleware/latency.js'
import { loggingMw } from './middleware/logging.js'
import { sceneRehydrateMw } from './middleware/sceneRehydrate.js'
import { adminRepo, userRepo, funnelRepo } from '../core/repositories/index.js'
import type { UserRow } from '../core/repositories/userRepo.js'
import { analyzeChartFake } from '../chartTheatre/analyzer.js'
import { adminFlowPriorityMw, registerAdminRoutes, sendAdminHome } from '../admin/index.js'
import { registerPostbackChannelListener } from '../jobs/postbackChannel.js'
import { replyWithHandoffImage } from './media.js'
import { applyEventDetached, ensureUser, getUserFlowData, setFlowData } from './scenes/_bridge.js'
import { whereShouldUserBe, getRequestedTier, isIqAccountConfirmed } from '../core/services/userJourney.js'
import { invalidateCachedClient } from '../trading/iqSessionCache.js'
import { confirmDeleteKeyboard } from './keyboards/inline.js'

export type SessionData = {
  correlationId?: string
  sceneState?: Record<string, unknown>
  adminFlow?: {
    kind: string
    data?: Record<string, string>
  }
}

// Per-update state (NOT persisted across updates — that's `session`). Used
// by the middleware chain to share work: activityMw populates currentUser
// from createIfMissing's RETURNING row so sceneRehydrateMw + scene handlers
// don't have to re-fetch the same row.
export type RequestState = {
  currentUser?: UserRow
  // True iff activityMw's createIfMissing actually inserted the row
  // on this update (i.e. the user is brand-new). Used by handleStartCommand
  // to gate one-time onboarding side effects (channel-gate seed, funnel
  // 'started' event). Reset every update — never persisted.
  userIsNew?: boolean
}

export type BotContext = Context &
  Scenes.SceneContext & {
    session: SessionData
    state: RequestState
    logger?: ReturnType<typeof getLogger>
  }

export function createBot(): Telegraf<BotContext> {
  const env = loadEnv()
  // Telegraf wraps every update's middleware chain in `p-timeout` defaulting
  // to 90 seconds. Our gale executor can legitimately run for up to ~30min
  // (5m timeframe × 6 gale steps), so the default kills real trades. Every
  // long-running call inside (IQ SDK awaitResult, gale loop, message edits)
  // has its own bounded timeout, so the global one is just a footgun.
  const bot = new Telegraf<BotContext>(env.BOT_TOKEN, { handlerTimeout: Infinity })
  const stage = createStage()

  bot.use(session())
  // Idempotency runs next. Webhook retries can
  // re-deliver the same update_id; we claim it atomically in the DB and
  // short-circuit the whole chain on duplicates so we don't double-fire
  // any side effects (trades, messages, scene transitions). Under
  // polling this is a cheap no-op — every update_id is fresh — but the
  // dedup table is shared so polling-mode bots also benefit if they ever
  // see a duplicate from the same getUpdates session.
  bot.use(idempotencyMw)
  // Early ACK runs next so callback spinners clear in <100ms regardless
  // of how slow the rest of the chain is. Has to be before correlation /
  // logging too — those don't touch Telegram but every microsecond saved
  // before the API call helps when we're catching up from a backlog.
  bot.use(earlyAckMw)
  // Latency timing wraps everything below it so the >500ms log captures
  // the full handler cost (DB, scene, IQ, replies).
  bot.use(latencyMw)
  bot.use(correlationMw)
  bot.use(loggingMw)
  bot.use(activityMw)
  bot.use(errorHandlerMw)
  // Admin-flow text precedence: when an admin has an active adminFlow
  // (e.g. typing a verified balance after tapping Approve), their reply
  // must reach handleAdminTextInput, not a leftover user-side scene
  // (LOGIN_EMAIL / TOKEN_PENDING / AMOUNT) that might validate it as
  // an email / IQ ID / number and short-circuit the chain. Runs before
  // sceneRehydrateMw + stage.middleware() so scene routing never sees
  // the message in the first place.
  bot.use(adminFlowPriorityMw)
  // Must run BEFORE stage.middleware() so the rehydrated scene is visible to it.
  bot.use(sceneRehydrateMw)

  // /start handler — extracted so we can register it BOTH at the stage
  // level (catches /start while user is in any scene with on('text'), e.g.
  // LOGIN_EMAIL where /start would otherwise be parsed as an email) AND at
  // the bot level (catches /start when the user is not in any scene). The
  // stage-level registration MUST happen before stage.middleware() so the
  // command handler runs before individual scene text handlers.
  const handleStartCommand = async (ctx: BotContext): Promise<void> => {
    if (ctx.from) {
      const admin = await adminRepo.findById(BigInt(ctx.from.id))
      if (admin && !admin.removed_at) {
        await adminRepo.touchLastActive(BigInt(ctx.from.id))
        // Drop any leftover scene state so admins always land on admin home.
        await ctx.scene.leave().catch(() => {})
        await sendAdminHome(ctx)
        return
      }

      // activityMw already ran createIfMissing and stashed `userIsNew`
      // on ctx.state. Re-checking via findById here would always return
      // truthy because the row was just inserted by activityMw — that's
      // why this branch was silently dead before, sending brand-new
      // users straight to WELCOME and skipping the channel gate.
      if (ctx.state.userIsNew) {
        await userRepo.updateFlowStage(BigInt(ctx.from.id), 'CHANNEL_GATE', {})
        await funnelRepo.record(BigInt(ctx.from.id), 'started')
      }
      await userRepo.resetLiveWinCount(BigInt(ctx.from.id))

      const refreshed = (await userRepo.findById(BigInt(ctx.from.id)))!
      // /start routing rules:
      //   - Brand-new user → WELCOME (the onboarding entry)
      //   - User mid-onboarding (no IQ session yet) → resume flow_stage so
      //     they can finish login/agreement/etc.
      //   - Fully onboarded user (has IQ session) → HOME hub regardless of
      //     where they last were — /start is "open the bot", not "resume".
      // Phase 3c: routing target derived from achievement state.
      // Replaces the legacy "if iq_session_token → HOME else
      // recovered flow_stage" block. The function handles every
      // case: brand-new users land at CHANNEL_GATE, mid-onboarding
      // users land at the next unmet gate, fully-onboarded users
      // land at HOME, session-expired-but-deposited users land at
      // LOGIN_EMAIL (and then HOME after re-login, skipping the
      // agreement and deposit screens they've already done).
      const target = whereShouldUserBe(refreshed)
      // /start is also the user's escape hatch for any stuck state.
      // Strip the trade-in-flight bookkeeping flags on every /start
      // so a user whose previous trade got interrupted (background
      // crash, bot restart, network blip) can always reset
      // themselves with /start instead of needing admin
      // intervention.
      const resetFlow = { ...(refreshed.flow_data ?? {}) } as Record<string, unknown>
      delete resetFlow.tradeInFlight
      delete resetFlow.tradeInFlightAt
      // Persist the derived stage to flow_stage so the state machine
      // (which still reads flow_stage as its current-state input)
      // resolves cleanly on the next event. flow_stage is now a
      // hint, not the source of routing truth, but it still needs to
      // be valid for the sub-flow machine transitions inside e.g.
      // TIMEFRAME → PAIR_SELECTION → AMOUNT.
      await userRepo.updateFlowStage(BigInt(ctx.from.id), target, resetFlow)
      ctx.logger?.info(
        { event: 'start_routed', target, telegramId: ctx.from.id.toString() },
        '/start routed by achievement state',
      )
      await ctx.scene.enter(target)
      return
    }
    await ctx.scene.enter('WELCOME')
  }

  // Shared confirmation prompt for the self-service account wipe. Reached
  // from /delete and from the SELF_DELETE inline button (help/FAQ +
  // support-handoff screens). Nothing is erased here — the actual wipe is
  // gated behind the SELF_DELETE_CONFIRM tap.
  const sendDeleteConfirmation = async (ctx: BotContext): Promise<void> => {
    await ctx.reply(
      [
        '⚠️ *Delete your account?*',
        '',
        'This permanently erases everything we have for you — your progress,',
        'trade history, and login session. It cannot be undone.',
        '',
        'After deleting, tap /start to begin again as a brand-new user.',
      ].join('\n'),
      { parse_mode: 'Markdown', ...confirmDeleteKeyboard() },
    )
  }

  // /delete — user-facing self-service reset. Dual-registered (stage + bot)
  // exactly like /start so it intercepts even while the user is mid-scene in
  // a text-capturing scene (LOGIN_EMAIL etc.). Admins are exempt: we never
  // let an admin nuke their own row through the user flow — route them home.
  const handleDeleteCommand = async (ctx: BotContext): Promise<void> => {
    if (!ctx.from) return
    const admin = await adminRepo.findById(BigInt(ctx.from.id))
    if (admin && !admin.removed_at) {
      await adminRepo.touchLastActive(BigInt(ctx.from.id))
      await ctx.scene.leave().catch(() => {})
      await sendAdminHome(ctx)
      return
    }
    await sendDeleteConfirmation(ctx)
  }

  const handleAdminCommand = async (ctx: BotContext): Promise<void> => {
    if (!ctx.from) return
    const admin = await adminRepo.findById(BigInt(ctx.from.id))
    if (!admin || admin.removed_at) {
      await ctx.reply('Admin access only.')
      return
    }
    await adminRepo.touchLastActive(BigInt(ctx.from.id))
    await ctx.scene.leave().catch(() => {})
    await sendAdminHome(ctx)
  }

  const handleMainMenu = async (ctx: BotContext): Promise<void> => {
    if (!ctx.from) return

    const user = await userRepo.findById(BigInt(ctx.from.id))
    if (!user) {
      await ctx.scene.enter('WELCOME')
      return
    }

    const resetFlow = { ...(user.flow_data ?? {}) } as Record<string, unknown>
    delete resetFlow.tradeInFlight
    delete resetFlow.tradeInFlightAt

    // Phase 3e: same achievement-routing treatment as /start. The
    // legacy isLoggedIn ? HOME : WELCOME split couldn't tell the
    // difference between "fresh user" (→ CHANNEL_GATE) and "user
    // who never finished onboarding" (→ wherever they left off);
    // both got dumped at WELCOME. The derivation function handles
    // every case.
    const target = whereShouldUserBe(user)
    await userRepo.updateFlowStage(BigInt(ctx.from.id), target, resetFlow)
    ctx.state.currentUser = { ...user, flow_stage: target, flow_data: resetFlow }
    await ctx.scene.enter(target)
  }

  // Register /start at the stage level FIRST so it intercepts the command
  // before any scene's on('text') handler can swallow it. Without this,
  // users in LOGIN_EMAIL / TOKEN_INPUT / AMOUNT etc. who type /start get
  // their command parsed as scene input (an "invalid email" / "Token
  // invalid" reply or, worse, no reply at all) and feel stuck.
  stage.command('start', handleStartCommand)
  stage.command('delete', handleDeleteCommand)
  stage.command('admin', handleAdminCommand)
  stage.hears('Main Menu', handleMainMenu)
  bot.use(stage.middleware())
  registerAdminRoutes(bot)
  // Fallback for users not in any scene (rare — sceneRehydrateMw normally
  // puts everyone into one). Same handler so behavior is identical.
  bot.command('start', handleStartCommand)
  bot.command('delete', handleDeleteCommand)
  bot.command('admin', handleAdminCommand)
  bot.hears('Main Menu', handleMainMenu)

  // Self-service account wipe. SELF_DELETE (from the inline reset button)
  // shows the same confirmation as /delete; SELF_DELETE_CONFIRM performs the
  // irreversible purge; SELF_DELETE_CANCEL backs out. After a confirmed
  // delete the next /start re-creates a fresh row (activityMw.createIfMissing)
  // and routes the user through onboarding as brand-new.
  bot.action('SELF_DELETE', async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    if (!ctx.from) return
    await sendDeleteConfirmation(ctx)
  })
  bot.action('SELF_DELETE_CANCEL', async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    await ctx.reply('Cancelled — nothing was deleted.')
  })
  bot.action('SELF_DELETE_CONFIRM', async (ctx) => {
    await ctx.answerCbQuery('Deleting your account…')
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    if (!ctx.from) return
    const telegramId = BigInt(ctx.from.id)
    // Admins can reach this only by tapping a stale button — never wipe an
    // admin row through the self-service path.
    const admin = await adminRepo.findById(telegramId)
    if (admin && !admin.removed_at) {
      await ctx.reply('Admin accounts cannot be self-deleted.')
      return
    }
    // Drop the in-memory IQ session before the row goes, then purge all
    // persisted data. Leave any scene so no rehydrated handler fires against
    // the now-deleted user.
    await invalidateCachedClient(telegramId).catch(() => {})
    await ctx.scene.leave().catch(() => {})
    await userRepo.hardDelete(telegramId)
    ctx.logger?.info(
      { event: 'self_delete', telegramId: telegramId.toString() },
      'user self-deleted account via /delete',
    )
    await ctx.reply('✅ Your account and data have been erased.\n\nTap /start to begin fresh.')
  })

  // Catch-all for plain text that wasn't consumed by an active scene's
  // on('text') handler. This typically means the user's session was lost
  // (bot restart, scene rehydrate miss after a crash) and their message
  // would otherwise disappear silently. Route through /start for a known
  // recovery point.
  bot.on('text', async (ctx) => {
    const cfg = loadEnv()
    if (cfg.AFFSTORE_POSTBACK_CHANNEL_ID && ctx.chat?.id === Number(cfg.AFFSTORE_POSTBACK_CHANNEL_ID)) {
      return
    }
    ctx.logger?.info(
      { event: 'orphan_text_fallback', preview: ctx.message.text.slice(0, 80) },
      'orphan text outside any scene — routing to start',
    )
    await handleStartCommand(ctx)
  })

  // NOTE: a previous version of this file registered a global
  // bot.action regex covering START_DEMO/AUTO/PRO, IQ_CREATE_ACCOUNT,
  // IQ_SIGNUP_DONE, AGREEMENT_*, DEPOSIT_DONE, and ACCOUNT_* as a
  // "stale button safety net." That layer is INCOMPATIBLE with
  // Telegraf's stage middleware: stage.middleware() calls next()
  // after a scene-bound .action() handler finishes, so the global
  // ran ON TOP of the legitimate scene handler — overwriting a
  // correct ctx.scene.enter() with a whereShouldUserBe re-route
  // and producing tight loops (e.g. ACCOUNT_TYPE picking ACCOUNT_LIVE
  // → scene handler advances to TIMEFRAME → global re-enters
  // DEPOSIT_GATE → DEPOSIT_GATE.enter() balance-passes back to
  // ACCOUNT_TYPE → repeat). The welcome.scene flowDataPatch fix
  // already handles the original requestedTier-wipe bug at root, so
  // the defensive layer is unnecessary. If you need to handle stale
  // buttons from old chat history later, gate the global on the
  // PRE-stage scene captured by a middleware ahead of stage.middleware
  // — not the post-transition scene that the global itself observes.

  // Legacy callback from old token-era approval DMs. Phase 3d: route
  // via whereShouldUserBe so old buttons land users at the correct
  // gate regardless of what flow_stage manipulation has happened.
  bot.action('POST_APPROVAL_CONTINUE', async (ctx) => {
    await ctx.answerCbQuery()
    if (!ctx.from) return
    const user = await userRepo.findById(BigInt(ctx.from.id))
    if (!user) {
      await ctx.scene.enter('WELCOME')
      return
    }
    await ctx.scene.enter(whereShouldUserBe(user))
  })

  // Tapped from the post-registration DM sent by signupConfirmedNotifier.
  // We still fire IQ_SIGNUP_CONFIRMED through the state machine (which
  // writes flow.iqAccountConfirmed=true — the postback-race tolerance
  // flag the derivation function consults) — but for routing we use
  // whereShouldUserBe on the refreshed row, not the machine's
  // nextStage. This ensures the user lands wherever their full
  // achievement state says they belong, even if the DM was delayed
  // past other events.
  bot.action('IQ_SIGNUP_CONFIRMED_CONTINUE', async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    if (!ctx.from) return
    const telegramId = BigInt(ctx.from.id)
    // Same defense as iqSignupHelpScene.action('IQ_SIGNUP_DONE'): wipe
    // any pre-existing IQ session and stored credentials so the user
    // must log in fresh with the account that just registered under
    // the partner link. Without this, a user who had an old IQ session
    // tied to a different account (e.g. from prior testing) would
    // skip LOGIN_EMAIL entirely and end up with iq_trader_id (new
    // postback-confirmed account) != iqUserId (resumed old session),
    // failing isPartnerVerified at LOGIN_VERIFYING or wrong_affiliate
    // at DEPOSIT_DONE.
    await invalidateCachedClient(telegramId).catch(() => {})
    await userRepo.clearIqSession(telegramId).catch(() => {})
    await userRepo.clearIqCredentials(telegramId).catch(() => {})
    await applyEventDetached(
      telegramId,
      { type: 'IQ_SIGNUP_CONFIRMED' },
      { flowDataPatch: { iqAccountConfirmed: true } },
    )
    const refreshed = await userRepo.findById(telegramId)
    if (!refreshed) {
      await ctx.scene.enter('WELCOME')
      return
    }
    await ctx.scene.enter(whereShouldUserBe(refreshed))
  })

  bot.action('DEPOSIT_CONFIRMED_CONTINUE', async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    if (!ctx.from) return
    const user = await userRepo.findById(BigInt(ctx.from.id))
    if (!user) {
      await ctx.scene.enter('WELCOME')
      return
    }
    await ctx.scene.enter(whereShouldUserBe(user))
  })

  // "Create my IQ Option account" (IQ_ACCOUNT_GATE). Registered GLOBALLY,
  // not as a scene-bound action, and this is the ONLY handler for the
  // callback (the scene-bound version was removed). Why: every update runs
  // through sceneRehydrateMw, which forces __scenes.current to
  // whereShouldUserBe(user) BEFORE stage.middleware dispatches the tap. If
  // that derived target had drifted off IQ_ACCOUNT_GATE (bot restart wiped
  // the in-memory session, a flow_data write dropped requestedTier, or the
  // user tapped a stale button from old chat history), the scene-bound
  // handler never fired — the user just watched the Telegram loading
  // spinner time out with nothing happening. A single global handler fires
  // no matter which scene the rehydrate landed them in. It runs exactly
  // once (no scene-bound twin), so it can't recreate the stage.middleware
  // double-execution loop that forced the earlier regex catch-all to be
  // reverted.
  bot.action('IQ_CREATE_ACCOUNT', async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    if (!ctx.from) return
    const telegramId = BigInt(ctx.from.id)
    const user = await userRepo.findById(telegramId)
    if (!user) {
      await ctx.scene.enter('WELCOME')
      return
    }

    // Stale button: they already have a confirmed IQ account. Send them
    // wherever their achievement state says they belong now.
    if (isIqAccountConfirmed(user)) {
      await ctx.scene.enter(whereShouldUserBe(user))
      return
    }

    // Tier intent missing. requestedTier lives only in the volatile
    // flow_data blob (demo intent has no durable column), so any overwrite
    // that drops it de-gates the user back to WELCOME and was killing this
    // button. We can't safely guess demo vs auto vs pro — a pre-deposit
    // auto/pro user also reports null here — so route them back to the tier
    // picker to re-choose instead of leaving a dead button. Log the row so
    // we can find the upstream writer that's clobbering flow_data.
    if (!getRequestedTier(user)) {
      ctx.logger?.warn(
        {
          event: 'iq_create_account_tier_lost',
          telegramId: ctx.from.id.toString(),
          flowStage: user.flow_stage,
          accountMode: user.account_mode,
          tier: user.tier,
          flowDataKeys: Object.keys(user.flow_data ?? {}),
        },
        'IQ_CREATE_ACCOUNT tapped but tier intent missing — routing back to WELCOME to re-pick',
      )
      await ctx.scene.enter('WELCOME')
      return
    }

    // Normal path: advance into the signup-help sub-flow. Persist the stage
    // directly — the state machine reads flow_stage, which rehydrate may
    // have just rewritten, so we don't route the event through the machine
    // (it would no-op from the wrong starting state). This mirrors how the
    // other global recovery handlers (NUDGE_TRADE / TAKE_ANOTHER) advance.
    await userRepo.updateFlowStage(telegramId, 'IQ_SIGNUP_HELP', user.flow_data ?? {})
    await ctx.scene.enter('IQ_SIGNUP_HELP')
  })

  // Tapped from an inactivity nudge. Intent: "if you can trade, go
  // straight to TIMEFRAME; otherwise resume wherever you should be."
  // The achievement check handles both cases — when the user is at
  // HOME-level we hardwire TIMEFRAME (the trading-flow entry), and
  // when they're earlier in the journey we send them to the right
  // gate to make progress.
  bot.action('NUDGE_TRADE', async (ctx) => {
    await ctx.answerCbQuery('Loading signal ⚡')
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    if (!ctx.from) return
    const user = await userRepo.findById(BigInt(ctx.from.id))
    if (!user) {
      await ctx.scene.enter('WELCOME')
      return
    }
    const homeOrEarlier = whereShouldUserBe(user)
    const target = homeOrEarlier === 'HOME' ? 'TIMEFRAME' : homeOrEarlier
    // Tapping a nudge is also an unstick — strip in-flight flags so
    // a user with a stuck flag from an interrupted trade can recover.
    const resetFlow = { ...(user.flow_data ?? {}) } as Record<string, unknown>
    delete resetFlow.tradeInFlight
    delete resetFlow.tradeInFlightAt
    // Persist the new stage so the state machine has a fresh starting
    // point on the next user event. Without this, picking a timeframe
    // silently no-ops because applyEvent resolves from the OLD
    // flow_stage.
    await userRepo.updateFlowStage(BigInt(ctx.from.id), target, resetFlow)
    await ctx.scene.enter(target)
  })

  // Vestigial handler — the Pause Notifications button no longer ships with
  // new nudges, but old nudge messages already in users' chats still have
  // it. We answer the callback silently (so the loading spinner clears),
  // strip the keyboard, and gently push them toward action instead of
  // honouring the pause request.
  bot.action('NUDGE_PAUSE_NOTIFS', async (ctx) => {
    await ctx.answerCbQuery("I'm always on — let's trade instead 🚀")
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
  })

  // Post-trade cards can remain visible after the user navigates
  // elsewhere (e.g. tap /start and land on HOME). Handle these
  // globally so older inline buttons still work instead of
  // appearing dead.
  //
  // Each handler has a hardwired post-trade target (TIMEFRAME /
  // STATS_VIEW / IDLE / HOME) but guards on whereShouldUserBe(user):
  // if the user has slipped below HOME-level since the post-trade
  // card was sent (session expired, admin downgraded, etc.) we
  // redirect them to the right gate instead of landing them in a
  // scene they can't progress from.
  bot.action('TAKE_ANOTHER', async (ctx) => {
    await ctx.answerCbQuery('Loading next signal ⚡')
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    if (!ctx.from) return
    const user = await userRepo.findById(BigInt(ctx.from.id))
    if (!user) {
      await ctx.scene.enter('WELCOME')
      return
    }
    const homeOrEarlier = whereShouldUserBe(user)
    if (homeOrEarlier !== 'HOME') {
      await ctx.scene.enter(homeOrEarlier)
      return
    }
    await userRepo.updateFlowStage(BigInt(ctx.from.id), 'TIMEFRAME', user.flow_data ?? {})
    await ctx.scene.enter('TIMEFRAME')
  })

  bot.action('VIEW_STATS', async (ctx) => {
    await ctx.answerCbQuery()
    if (!ctx.from) return
    const user = await userRepo.findById(BigInt(ctx.from.id))
    if (!user) {
      await ctx.scene.enter('WELCOME')
      return
    }
    const homeOrEarlier = whereShouldUserBe(user)
    if (homeOrEarlier !== 'HOME') {
      await ctx.scene.enter(homeOrEarlier)
      return
    }
    await userRepo.updateFlowStage(BigInt(ctx.from.id), 'STATS_VIEW', user.flow_data ?? {})
    await ctx.scene.enter('STATS_VIEW')
  })

  bot.action('STOP', async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    if (!ctx.from) return
    const user = await userRepo.findById(BigInt(ctx.from.id))
    if (!user) {
      await ctx.scene.enter('WELCOME')
      return
    }
    const homeOrEarlier = whereShouldUserBe(user)
    if (homeOrEarlier !== 'HOME') {
      await ctx.scene.enter(homeOrEarlier)
      return
    }
    await userRepo.updateFlowStage(BigInt(ctx.from.id), 'IDLE', user.flow_data ?? {})
    await ctx.scene.enter('IDLE')
  })

  // Quick path back to the main menu (HOME) from any scene that
  // surfaces the post-trade keyboard. HOME is the proper hub — shows
  // tier/mode/balance/stats and exposes mode toggle + take-a-trade —
  // but it was previously only reachable via /start.
  bot.action('GO_HOME', async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.editMessageReplyMarkup(undefined).catch(() => {})
    if (ctx.from) {
      const flow = await getUserFlowData(ctx)
      await userRepo.updateFlowStage(BigInt(ctx.from.id), 'HOME', flow)
    }
    await ctx.scene.enter('HOME')
  })

  bot.on('photo', async (ctx) => {
    const user = await ensureUser(ctx)
    if (user.tier !== 'pro') {
      return
    }

    const flow = await getUserFlowData(ctx)
    const today = new Date().toISOString().slice(0, 10)
    const usageDate = String(flow.chartUsageDate ?? '')
    const usageCount = Number(flow.chartUsageCount ?? 0)
    const nextCount = usageDate === today ? usageCount + 1 : 1

    if (nextCount > loadEnv().PRO_DAILY_CHART_LIMIT) {
      await ctx.reply('Daily PRO chart analysis limit reached.')
      return
    }

    const analysis = await analyzeChartFake({
      send: async (text) => {
        const sent = await ctx.reply(text)
        return { messageId: sent.message_id }
      },
      edit: async (messageId, text) => {
        await ctx.telegram.editMessageText(ctx.chat!.id, messageId, undefined, text)
      },
      sleep: async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms))
      },
    })

    await setFlowData(ctx, {
      ...flow,
      chartUsageDate: today,
      chartUsageCount: nextCount,
      lastChartAnalysis: analysis,
    })

    await replyWithHandoffImage(
      ctx,
      analysis.direction === 'call' ? '17-bullish-signal.jpg' : '18-bearish-signal.jpg',
      [
        `Chart signal: ${analysis.direction.toUpperCase()}`,
        `Confidence: ${analysis.confidence}%`,
        `Suggested timeframe: ${analysis.suggestedTimeframe}`,
        analysis.reasoning,
      ].join('\n'),
    )
  })
  bot.catch((err, ctx) => {
    // Surface Telegram-API failures so we can see rate-limits / payload
    // errors / kicked-from-chat / message-too-old by their error_code
    // instead of opaque error objects. TelegramError carries response,
    // on, and parameters fields that have the actionable fields.
    // ctx may be undefined for polling errors raised outside an update
    // (e.g. getUpdates 409 / network blips), so optional-chain through.
    const e = err as { code?: number; description?: string; on?: unknown; parameters?: { retry_after?: number; migrate_to_chat_id?: number } }
    getLogger().error(
      {
        err,
        telegramId: ctx?.from?.id,
        event: 'bot_error',
        tg_error_code: e?.code,
        tg_description: e?.description,
        tg_retry_after: e?.parameters?.retry_after,
        tg_on: e?.on,
      },
      'unhandled bot error',
    )
  })

  registerPostbackChannelListener(bot)

  return bot
}
