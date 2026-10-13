import { createActor } from 'xstate'
import { funnelRepo, userRepo } from '../../core/repositories/index.js'
import { noxatradingMachine, type MachineEvent } from '../../core/stateMachine.js'
import type { UserRow } from '../../core/repositories/userRepo.js'
import type { BotContext } from '../index.js'

type FlowData = Record<string, unknown>

function canonicalStage(stage: string): string {
  return stage.trim().toUpperCase()
}

function machineInputFromUser(user: UserRow) {
  return {
    tier: user.tier,
    accountMode: user.account_mode,
    agreementAccepted: user.agreement_accepted,
    liveWinCount: user.live_win_count,
    iqLoggedIn: Boolean(user.iq_session_token),
  }
}

export async function ensureUser(ctx: BotContext): Promise<UserRow> {
  if (!ctx.from) {
    throw new Error('Telegram user missing')
  }

  // activityMw populates ctx.state.currentUser via createIfMissing's
  // RETURNING row on every Telegram update. Reuse it instead of running
  // INSERT...ON CONFLICT + SELECT a second (and third, fourth) time per
  // update — the most common per-update redundancy in the old hot path.
  const cached = ctx.state.currentUser
  if (cached) return cached

  // Defensive fallback: code paths that bypass middleware (admin command
  // handlers, jobs that lift ctx out of band) still need to work. We only
  // INSERT-on-conflict here if we truly have no cached row.
  await userRepo.createIfMissing(BigInt(ctx.from.id), ctx.from.username, ctx.from.first_name)
  const user = (await userRepo.findById(BigInt(ctx.from.id)))!
  ctx.state.currentUser = user
  return user
}

export async function getUserFlowData(ctx: BotContext): Promise<FlowData> {
  const user = await ensureUser(ctx)
  return user.flow_data ?? {}
}

export async function setFlowData(ctx: BotContext, data: FlowData): Promise<void> {
  const user = await ensureUser(ctx)
  await userRepo.updateFlowStage(BigInt(user.telegram_id), canonicalStage(user.flow_stage), data)
  user.flow_data = data
}

export async function mergeFlowData(ctx: BotContext, patch: FlowData): Promise<FlowData> {
  const user = await ensureUser(ctx)
  const next = { ...(user.flow_data ?? {}), ...patch }
  await userRepo.updateFlowStage(BigInt(user.telegram_id), canonicalStage(user.flow_stage), next)
  user.flow_data = next
  return next
}

// Pure state-machine transition. Takes a user row in, returns the next row
// + transition metadata. No ctx coupling, so it's safe to call from
// detached background work (e.g. the trade gale loop after the Telegraf
// scene has already returned).
async function applyEventToUser(
  user: UserRow,
  event: MachineEvent,
  options?: { flowDataPatch?: FlowData; replaceFlowData?: boolean },
) {
  const snapshot = noxatradingMachine.resolveState({
    value: canonicalStage(user.flow_stage),
    context: machineInputFromUser(user),
  })
  const actor = createActor(noxatradingMachine, {
    input: machineInputFromUser(user),
    snapshot,
  }).start()
  actor.send(event)
  const next = actor.getSnapshot()
  const nextStage = canonicalStage(String(next.value))
  const nextFlowData = options?.replaceFlowData
    ? { ...(options.flowDataPatch ?? {}) }
    : { ...(user.flow_data ?? {}), ...(options?.flowDataPatch ?? {}) }

  // Single batched UPDATE. The old fan-out did 1–4 separate UPDATEs per
  // transition (setTier + setAccountMode + setAgreementAccepted +
  // updateFlowStage) which under viral load held 4× as many pool slots
  // as needed. updateStateAndFlow only mutates the columns whose values
  // actually changed; flow_stage and flow_data always update because
  // every transition advances them.
  const patch: Parameters<typeof userRepo.updateStateAndFlow>[1] = {
    flowStage: nextStage,
    flowData: nextFlowData,
  }
  if (user.tier !== next.context.tier) patch.tier = next.context.tier
  if (user.account_mode !== next.context.accountMode) patch.accountMode = next.context.accountMode
  // Persist the durable tier-intent column whenever a tier pick comes
  // through (welcome.scene passes requestedTier in flowDataPatch on
  // PICKED_DEMO/AUTO/PRO). Writing it here keeps it atomic with the
  // transition. This is the durable backing that stops demo intent from
  // being lost on a later flow_data overwrite. See migration 019.
  const requestedTier = options?.flowDataPatch?.requestedTier
  if (requestedTier === 'demo' || requestedTier === 'auto' || requestedTier === 'pro') {
    if (user.requested_tier !== requestedTier) patch.requestedTier = requestedTier
  }
  if (user.agreement_accepted !== next.context.agreementAccepted) {
    patch.agreementAccepted = next.context.agreementAccepted
  }
  const updatedUser = await userRepo.updateStateAndFlow(BigInt(user.telegram_id), patch)

  // Funnel events live in a different table (append-only) so they stay
  // outside the batched UPDATE. Tier-up funnel records preserve the
  // exact behavior of the prior implementation.
  if (user.tier !== next.context.tier) {
    if (next.context.tier === 'auto' || next.context.tier === 'pro') {
      await funnelRepo.record(
        BigInt(user.telegram_id),
        next.context.tier === 'auto' ? 'auto_upgraded' : 'pro_upgraded',
      )
    }
  }

  return {
    previousStage: canonicalStage(user.flow_stage),
    nextStage,
    changed: nextStage !== canonicalStage(user.flow_stage),
    flowData: nextFlowData,
    user: updatedUser,
  }
}

export async function applyEvent(
  ctx: BotContext,
  event: MachineEvent,
  options?: { flowDataPatch?: FlowData; replaceFlowData?: boolean },
) {
  const user = await ensureUser(ctx)
  const result = await applyEventToUser(user, event, options)

  // Refresh the per-update cache so any subsequent ensureUser() call in
  // the same Telegraf update sees the post-transition row, not the stale
  // pre-transition one. Without this, a scene's enter handler that calls
  // ensureUser after transitionAfterEvent would read an outdated
  // flow_stage / tier / etc.
  ctx.state.currentUser = result.user

  return {
    previousStage: result.previousStage,
    nextStage: result.nextStage,
    changed: result.changed,
    flowData: result.flowData,
  }
}

// Detached state-machine transition for use from outside the Telegraf
// middleware chain (e.g. the trade gale loop running after the scene
// handler has returned). Looks up the user fresh, runs the same machine
// logic + batched UPDATE, returns the next stage so the caller can route
// the user back into the right scene via flow_stage on their next /start.
export async function applyEventDetached(
  telegramId: bigint,
  event: MachineEvent,
  options?: { flowDataPatch?: FlowData; replaceFlowData?: boolean },
) {
  const user = await userRepo.findById(telegramId)
  if (!user) {
    throw new Error(`applyEventDetached: user ${telegramId} not found`)
  }
  return applyEventToUser(user, event, options)
}

export async function transitionAfterEvent(
  ctx: BotContext,
  event: MachineEvent,
  options?: { flowDataPatch?: FlowData; replaceFlowData?: boolean },
) {
  const result = await applyEvent(ctx, event, options)
  if (result.changed) {
    await ctx.scene.enter(result.nextStage)
  }
  return result
}
