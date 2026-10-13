import type { Middleware } from 'telegraf'
import { userRepo } from '../../core/repositories/index.js'
import { scheduleInactivityPing } from '../../jobs/inactivityPing.js'
import type { BotContext } from '../index.js'
import { isAdminCached } from './adminCache.js'

// Threshold for treating a user as freshly active. If their last_activity
// was within this window, we skip the pg-boss inactivity-ping reschedule —
// the existing debounced job is still valid and resending it just churns
// the queue table.
const RECENT_ACTIVITY_MS = 60_000

// On every Telegram update we used to do FIVE Postgres ops sequentially:
// createIfMissing → touchActivity → resetNudgeState → adminRepo.findById →
// (sometimes) scheduleInactivityPing. That serialization aged Telegram
// callback queries out (~10s window) under viral load and starved the
// pool with ~50 connections held by the middleware before any handler ran.
//
// Now: ONE blocking write (createIfMissing — downstream needs the user row
// to exist), ONE coalesced background UPDATE (touchActivityAndResetNudge),
// admin lookup served from the in-memory cache, and inactivity-ping only
// rescheduled when the user has actually been idle. The user row from
// createIfMissing is stashed on `ctx.state.currentUser` so sceneRehydrateMw
// and scene handlers don't re-fetch.
export const activityMw: Middleware<BotContext> = async (ctx, next) => {
  if (ctx.from?.id) {
    const telegramId = BigInt(ctx.from.id)
    const { user, created } = await userRepo.createIfMissing(
      telegramId,
      ctx.from.username,
      ctx.from.first_name,
    )
    ctx.state.currentUser = user
    ctx.state.userIsNew = created

    // Coalesced fire-and-forget. Single UPDATE replaces the prior 2 (touch +
    // reset nudge state). Failures here are tolerable — we'll catch up on
    // the next interaction.
    void userRepo.touchActivityAndResetNudge(telegramId).catch(() => {})

    // Admin? Skip inactivity ping entirely (admins shouldn't get nudges).
    // Cache hit avoids the per-update SELECT against the admins table.
    if (!isAdminCached(telegramId)) {
      const lastActivityMs = user.last_activity ? new Date(user.last_activity).getTime() : 0
      const idleForMs = Date.now() - lastActivityMs
      // Only re-arm the inactivity ping when the user has been quiet for
      // longer than RECENT_ACTIVITY_MS. The pg-boss debounce key still
      // dedups, but skipping the call entirely is cheaper than enqueuing
      // a job we'll immediately replace.
      if (idleForMs > RECENT_ACTIVITY_MS) {
        void scheduleInactivityPing(telegramId).catch(() => {})
      }
    }
  }

  await next()
}
