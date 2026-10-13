import { Markup, type Middleware, type Telegraf } from 'telegraf'
import type { BotContext } from '../bot/index.js'
import {
  adminRepo,
  auditRepo,
  broadcastRepo,
  tradeRepo,
  userRepo,
  systemStateRepo,
  funnelRepo,
  iqPostbackRepo,
} from '../core/repositories/index.js'
import type { BroadcastMediaKind } from '../core/repositories/broadcastRepo.js'
import { ALL_SEGMENTS, buildSegmentCountQuery, type Segment } from '../core/services/broadcastSegmenter.js'
import {
  PLACEHOLDER_HINT,
  personalizeMessage,
} from '../core/services/messagePersonalize.js'
import { query } from '../infra/db.js'
import { getBoss } from '../jobs/boss.js'
import { requireAdmin } from './permissions.js'
import { getActivationsBreakdown, renderActivationsBreakdown } from './activations.js'
import { renderSystemStatus } from './system.js'
import { getAdminQuickStats, renderAdminQuickStats } from './stats.js'
import { searchUsers } from './users.js'
import { buildPostbackBadge } from './postbackVerify.js'
import { registerDiagIqRoutes } from './diagIq.js'

type AdminFlow = NonNullable<BotContext['session']['adminFlow']>

function backRow() {
  return [Markup.button.callback('Back', 'ADMIN_HOME')]
}

function usersBackRow() {
  return [Markup.button.callback('Back', 'ADMIN_USERS')]
}

function setAdminFlow(ctx: BotContext, kind: string, data?: Record<string, string>) {
  ctx.session.adminFlow = { kind, data }
}

function clearAdminFlow(ctx: BotContext) {
  delete ctx.session.adminFlow
}

function currentFlow(ctx: BotContext): AdminFlow | null {
  return ctx.session.adminFlow ?? null
}

// Runs BEFORE stage.middleware() in the global middleware chain. When
// an admin has an active adminFlow (e.g. they tapped Approve and are
// being asked for a verified balance), their next text message must
// reach handleAdminTextInput — NOT a leftover user-side scene that
// might validate the input as an email / IQ ID / amount and reply
// with garbage. Without this priority, admins who'd been promoted
// from user accounts would have their replies silently consumed by
// LOGIN_EMAIL / TOKEN_PENDING / AMOUNT scene handlers.
//
// Defensive about the negative space: only fires when ALL of:
//   - this update is a text message (not callback / photo / poll)
//   - the sender has an active adminFlow in session
//   - the sender is currently an active admin
// Anything else falls through to scene routing as before.
export const adminFlowPriorityMw: Middleware<BotContext> = async (ctx, next) => {
  if (!ctx.from || !ctx.message || !('text' in ctx.message)) {
    return next()
  }
  // Admin flow state is only meaningful in the bot's private chat with
  // the admin. Anything an admin types in a group/channel (e.g. the
  // alert channel) must fall through to normal handling — never be
  // captured as admin-flow input, which would echo confirmations back
  // into the group.
  if (ctx.chat?.type !== 'private') {
    return next()
  }
  if (!currentFlow(ctx)) {
    return next()
  }
  const admin = await adminRepo.findById(BigInt(ctx.from.id))
  if (!admin || admin.removed_at) {
    return next()
  }
  await adminRepo.touchLastActive(BigInt(ctx.from.id))
  ;(ctx as BotContext & { admin?: typeof admin }).admin = admin
  await handleAdminTextInput(ctx)
  // Intentionally no next() — admin-flow input is fully consumed here.
}

async function sendUsersMenu(ctx: BotContext) {
  clearAdminFlow(ctx)
  await ctx.reply(
    'Users',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('Search', 'ADMIN_USERS_SEARCH'),
        Markup.button.callback('Browse', 'ADMIN_USERS_BROWSE:0'),
      ],
      [
        Markup.button.callback('Force Demo', 'ADMIN_USERS_FORCE_DEMO'),
        Markup.button.callback('Pause', 'ADMIN_USERS_PAUSE'),
        Markup.button.callback('Suspend', 'ADMIN_USERS_SUSPEND'),
      ],
      [
        Markup.button.callback('Trade History', 'ADMIN_USERS_HISTORY'),
        Markup.button.callback('Send DM', 'ADMIN_USERS_DM'),
      ],
      [Markup.button.callback('Hard Delete', 'ADMIN_USERS_DELETE')],
      backRow(),
    ]),
  )
}

function renderUserCard(user: {
  telegram_id: string
  telegram_username: string | null
  telegram_first_name: string | null
  iq_user_id: string | null
  iq_email: string | null
  tier: string
  status: string
  account_mode: string
  created_at: Date
  last_activity: Date
}) {
  const displayName = user.telegram_first_name ?? '(no name)'
  const username = user.telegram_username ? `@${user.telegram_username}` : '(no username)'
  return [
    '👤 USER',
    `Name: ${displayName}`,
    `Telegram: ${username}`,
    `Telegram ID: ${user.telegram_id}`,
    `IQ User ID: ${user.iq_user_id ?? '-'}`,
    `Email: ${user.iq_email ?? '-'}`,
    `Tier: ${user.tier.toUpperCase()}`,
    `Status: ${user.status.toUpperCase()}`,
    `Mode: ${user.account_mode.toUpperCase()}`,
    `Joined: ${new Date(user.created_at).toLocaleString()}`,
    `Last activity: ${new Date(user.last_activity).toLocaleString()}`,
  ].join('\n')
}

function compactUserLabel(user: {
  telegram_id: string
  telegram_username: string | null
  telegram_first_name: string | null
}) {
  const base =
    user.telegram_username
      ? `@${user.telegram_username}`
      : user.telegram_first_name
        ? user.telegram_first_name
        : user.telegram_id
  return base.length > 28 ? `${base.slice(0, 25)}…` : base
}

async function sendUserBrowsePage(ctx: BotContext, page: number) {
  clearAdminFlow(ctx)
  const pageSize = 6
  const total = await userRepo.countAll()
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(Math.max(0, page), totalPages - 1)
  const users = await userRepo.listRecent({ limit: pageSize, offset: currentPage * pageSize })

  const rows = users.map((user) => [
    Markup.button.callback(
      compactUserLabel(user),
      `ADMIN_USER_VIEW:${user.telegram_id}:${currentPage}`,
    ),
  ])

  const nav: ReturnType<typeof Markup.button.callback>[] = []
  if (currentPage > 0) {
    nav.push(Markup.button.callback('← Prev', `ADMIN_USERS_BROWSE:${currentPage - 1}`))
  }
  if (currentPage < totalPages - 1) {
    nav.push(Markup.button.callback('Next →', `ADMIN_USERS_BROWSE:${currentPage + 1}`))
  }
  if (nav.length) rows.push(nav)
  rows.push(usersBackRow())

  await ctx.reply(
    [
      `Users — page ${currentPage + 1}/${totalPages}`,
      `Total users: ${total}`,
      '',
      'Tap a user to open actions.',
    ].join('\n'),
    Markup.inlineKeyboard(rows),
  )
}

async function sendUserDetail(ctx: BotContext, telegramId: bigint, page = 0) {
  const user = await userRepo.findById(telegramId)
  if (!user) {
    await ctx.reply('User not found.')
    return
  }

  await ctx.reply(
    renderUserCard(user),
    Markup.inlineKeyboard([
      [
        Markup.button.callback('Force Demo', `ADMIN_USER_FORCE_DEMO:${telegramId}`),
        Markup.button.callback('Pause', `ADMIN_USER_PAUSE:${telegramId}`),
      ],
      [
        Markup.button.callback('Suspend', `ADMIN_USER_SUSPEND:${telegramId}`),
        Markup.button.callback('History', `ADMIN_USER_HISTORY:${telegramId}`),
      ],
      [
        Markup.button.callback('DM', `ADMIN_USER_DM:${telegramId}`),
        Markup.button.callback('Delete', `ADMIN_USER_DELETE:${telegramId}`),
      ],
      [Markup.button.callback('Back to List', `ADMIN_USERS_BROWSE:${page}`)],
    ]),
  )
}

async function sendSystemMenu(ctx: BotContext) {
  clearAdminFlow(ctx)
  await ctx.reply(
    await renderSystemStatus(),
    Markup.inlineKeyboard([
      [
        Markup.button.callback('All On', 'ADMIN_SYSTEM_SET:all:on'),
        Markup.button.callback('All Off', 'ADMIN_SYSTEM_SET:all:off'),
      ],
      [
        Markup.button.callback('AUTO On', 'ADMIN_SYSTEM_SET:auto:on'),
        Markup.button.callback('AUTO Off', 'ADMIN_SYSTEM_SET:auto:off'),
      ],
      [
        Markup.button.callback('PRO On', 'ADMIN_SYSTEM_SET:pro:on'),
        Markup.button.callback('PRO Off', 'ADMIN_SYSTEM_SET:pro:off'),
      ],
      backRow(),
    ]),
  )
}

async function sendBroadcastMenu(ctx: BotContext) {
  clearAdminFlow(ctx)
  await ctx.reply(
    'Broadcasts',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('Send Now', 'ADMIN_BROADCAST_MODE:now'),
        Markup.button.callback('Schedule', 'ADMIN_BROADCAST_MODE:later'),
      ],
      backRow(),
    ]),
  )
}

async function sendManageAdminsMenu(ctx: BotContext) {
  clearAdminFlow(ctx)
  const admins = await adminRepo.listActive()
  await ctx.reply(
    admins.length === 0
      ? 'No active admins.'
      : admins.map((admin) => `${admin.telegram_id} ${admin.role} ${admin.display_name}`).join('\n'),
    Markup.inlineKeyboard([
      [
        Markup.button.callback('Add Admin', 'ADMIN_MANAGE_ADD'),
        Markup.button.callback('Remove Admin', 'ADMIN_MANAGE_REMOVE'),
      ],
      backRow(),
    ]),
  )
}

// Friendly labels per segment (callback data still uses the raw segment name).
const SEGMENT_LABELS: Record<Segment, string> = {
  all: '👥  All users',
  demo: '🧪  Demo users',
  auto: '🚀  AUTO users',
  pro: '⚡  PRO users',
  new_today: '🆕  New today',
  new_7d: '🆕  New 7 days',
  new_30d: '🆕  New 30 days',
  inactive_7d: '⏰  Inactive 7d+',
}

async function countSegment(segment: Segment): Promise<number> {
  const q = buildSegmentCountQuery(segment)
  const result = await query<{ count: number }>(q.text, q.params)
  return result.rows[0]?.count ?? 0
}

async function promptBroadcastSegments(ctx: BotContext, mode: 'now' | 'later') {
  clearAdminFlow(ctx)
  // Fetch all counts in parallel — small, cheap queries, fine for an admin tap.
  const counts = await Promise.all(ALL_SEGMENTS.map((s) => countSegment(s)))

  // Lay out 2 buttons per row so labels don't truncate.
  const rows: Array<ReturnType<typeof Markup.button.callback>[]> = []
  for (let i = 0; i < ALL_SEGMENTS.length; i += 2) {
    const left = ALL_SEGMENTS[i]!
    const right = ALL_SEGMENTS[i + 1]
    const row = [
      Markup.button.callback(
        `${SEGMENT_LABELS[left]} (${counts[i]})`,
        `ADMIN_BROADCAST_SEGMENT:${mode}:${left}`,
      ),
    ]
    if (right) {
      row.push(
        Markup.button.callback(
          `${SEGMENT_LABELS[right]} (${counts[i + 1]})`,
          `ADMIN_BROADCAST_SEGMENT:${mode}:${right}`,
        ),
      )
    }
    rows.push(row)
  }
  rows.push(backRow())

  const header =
    mode === 'now'
      ? '📣 *Send broadcast now*\n\nPick a recipient segment 👇'
      : '⏰ *Schedule broadcast*\n\nPick a recipient segment 👇'

  await ctx.reply(header, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(rows),
  })
}

// Shared finalize step used by both the text broadcast path and the media
// broadcast path. Creates the broadcast row, queues the worker, and sends
// the admin a confirmation + personalized preview.
async function finalizeBroadcast(
  ctx: BotContext,
  params: {
    segment: Segment
    messageText: string
    mediaKind?: BroadcastMediaKind | null
    mediaFileId?: string | null
    delaySeconds?: number | null
  },
) {
  const samplePreview = personalizeMessage(params.messageText, {
    firstName: ctx.from?.first_name ?? null,
    username: ctx.from?.username ?? null,
  })
  const scheduledFor = params.delaySeconds
    ? new Date(Date.now() + params.delaySeconds * 1000)
    : undefined

  const row = await broadcastRepo.create({
    createdByAdminId: BigInt(ctx.from!.id),
    segment: params.segment,
    recipientCount: 0,
    messageText: params.messageText,
    mediaKind: params.mediaKind ?? null,
    mediaFileId: params.mediaFileId ?? null,
    scheduledFor,
  })

  const boss = await getBoss()
  const mediaTag = params.mediaKind ? ` (with ${params.mediaKind})` : ''

  if (scheduledFor) {
    await boss.send(
      'broadcast-send',
      { broadcastId: row.id },
      { startAfter: scheduledFor.toISOString() },
    )
    await ctx.reply(
      [
        `⏰ *Broadcast scheduled${mediaTag}* for ${scheduledFor.toLocaleString()}.`,
        '',
        '_Caption preview (using your own name)_',
        samplePreview || '_(no caption)_',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
  } else {
    await boss.send('broadcast-send', { broadcastId: row.id })
    await ctx.reply(
      [
        `📣 *Broadcast queued${mediaTag}.*`,
        'Progress will appear in this chat.',
        '',
        '_Caption preview (using your own name)_',
        samplePreview || '_(no caption)_',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
  }
}

// Handles photo / video / document / animation messages while the admin is
// in the broadcast-message compose step. Pulls the file_id and caption,
// then routes through the same finalize as text broadcasts.
async function handleAdminMediaInput(ctx: BotContext) {
  const flow = currentFlow(ctx)
  if (!flow || flow.kind !== 'broadcast-message' || !ctx.message) return
  const segment = flow.data!.segment as Segment
  const delay = flow.data?.delaySeconds ? Number(flow.data.delaySeconds) : null
  clearAdminFlow(ctx)

  const msg = ctx.message
  let mediaKind: BroadcastMediaKind | null = null
  let mediaFileId: string | null = null
  let caption = ''

  if ('photo' in msg && msg.photo && msg.photo.length > 0) {
    // photo array is sorted small→large; use the largest for best quality
    mediaKind = 'photo'
    mediaFileId = msg.photo[msg.photo.length - 1]!.file_id
    caption = msg.caption ?? ''
  } else if ('video' in msg && msg.video) {
    mediaKind = 'video'
    mediaFileId = msg.video.file_id
    caption = msg.caption ?? ''
  } else if ('animation' in msg && msg.animation) {
    mediaKind = 'animation'
    mediaFileId = msg.animation.file_id
    caption = msg.caption ?? ''
  } else if ('document' in msg && msg.document) {
    mediaKind = 'document'
    mediaFileId = msg.document.file_id
    caption = msg.caption ?? ''
  }

  if (!mediaKind || !mediaFileId) {
    await ctx.reply("Couldn't read that media. Try sending it again as a photo, video, GIF, or document.")
    return
  }

  await finalizeBroadcast(ctx, {
    segment,
    messageText: caption,
    mediaKind,
    mediaFileId,
    delaySeconds: delay,
  })
}

async function handleAdminTextInput(ctx: BotContext) {
  if (!ctx.message || !('text' in ctx.message)) {
    return
  }

  const flow = currentFlow(ctx)
  if (!flow) {
    return
  }

  const text = ctx.message.text.trim()

  switch (flow.kind) {
    case 'user-search': {
      clearAdminFlow(ctx)
      const results = await searchUsers(text)
      if (results.length === 0) {
        await ctx.reply('No user or token matched that query.')
        return
      }
      for (const result of results.slice(0, 5)) {
        const keyboard =
          result.type === 'user' && result.telegramId
            ? Markup.inlineKeyboard([
                [Markup.button.callback('Open User', `ADMIN_USER_VIEW:${result.telegramId}:0`)],
                [
                  Markup.button.callback('Force Demo', `ADMIN_USER_FORCE_DEMO:${result.telegramId}`),
                  Markup.button.callback('Pause', `ADMIN_USER_PAUSE:${result.telegramId}`),
                ],
                [
                  Markup.button.callback('Suspend', `ADMIN_USER_SUSPEND:${result.telegramId}`),
                  Markup.button.callback('History', `ADMIN_USER_HISTORY:${result.telegramId}`),
                ],
                [
                  Markup.button.callback('DM', `ADMIN_USER_DM:${result.telegramId}`),
                  Markup.button.callback('Delete', `ADMIN_USER_DELETE:${result.telegramId}`),
                ],
              ])
            : undefined
        await ctx.reply(result.lines.join('\n'), keyboard)
      }
      return
    }
    case 'postback-verify': {
      clearAdminFlow(ctx)
      const badge = await buildPostbackBadge(iqPostbackRepo, text)
      await ctx.reply(badge.detail, { parse_mode: 'Markdown' })
      return
    }
    case 'user-suspend': {
      const telegramId = BigInt(flow.data?.telegramId ?? '')
      clearAdminFlow(ctx)
      await userRepo.setStatus(telegramId, 'suspended', text)
      await auditRepo.record({
        adminTelegramId: BigInt(ctx.from!.id),
        actionType: 'suspend_user',
        targetType: 'user',
        targetId: telegramId.toString(),
        payload: { reason: text },
      })
      await ctx.reply(`User ${telegramId} suspended.`)
      return
    }
    case 'user-dm': {
      const telegramId = BigInt(flow.data?.telegramId ?? '')
      clearAdminFlow(ctx)
      await ctx.telegram.sendMessage(Number(telegramId), text)
      await auditRepo.record({
        adminTelegramId: BigInt(ctx.from!.id),
        actionType: 'dm_user',
        targetType: 'user',
        targetId: telegramId.toString(),
        payload: { message: text },
      })
      await ctx.reply(`Message sent to ${telegramId}.`)
      return
    }
    case 'broadcast-delay': {
      const delaySeconds = Number(text)
      if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
        await ctx.reply("That isn't a valid delay. Send a positive number of seconds.")
        return
      }
      setAdminFlow(ctx, 'broadcast-message', { ...flow.data, delaySeconds: String(delaySeconds) })
      await ctx.reply(
        [
          '📝 Send the broadcast now 👇',
          '— text, photo, video, GIF, or document',
          '— caption supports placeholders',
          '',
          PLACEHOLDER_HINT,
        ].join('\n'),
        { parse_mode: 'Markdown' },
      )
      return
    }
    case 'broadcast-message': {
      const segment = flow.data!.segment as (typeof ALL_SEGMENTS)[number]
      clearAdminFlow(ctx)
      await finalizeBroadcast(ctx, {
        segment,
        messageText: text,
        delaySeconds: flow.data?.delaySeconds ? Number(flow.data.delaySeconds) : null,
      })
      return
    }
    case 'admin-add-id': {
      setAdminFlow(ctx, 'admin-add-name', { telegramId: text })
      await ctx.reply('Send the display name for the new admin.')
      return
    }
    case 'admin-add-name': {
      const telegramId = BigInt(flow.data?.telegramId ?? '')
      clearAdminFlow(ctx)
      await adminRepo.add({
        telegramId,
        displayName: text,
        addedBy: BigInt(ctx.from!.id),
      })

      const existingUser = await userRepo.findById(telegramId)
      if (existingUser) {
        await userRepo.updateFlowStage(telegramId, 'WELCOME', {})
      }

      await ctx.reply(`Admin ${telegramId} added.`)
      return
    }
    case 'admin-remove-id': {
      clearAdminFlow(ctx)
      await adminRepo.softRemove(BigInt(text), BigInt(ctx.from!.id))
      await ctx.reply(`Admin ${text} removed.`)
      return
    }
  }
}

export async function sendAdminHome(ctx: BotContext): Promise<void> {
  clearAdminFlow(ctx)
  const stats = await getAdminQuickStats()
  await ctx.reply(
    renderAdminQuickStats(stats),
    Markup.inlineKeyboard([
      [
        Markup.button.callback('📊 Today', 'ADMIN_STATS'),
        Markup.button.callback('👥 Activations', 'ADMIN_ACTIVATIONS'),
      ],
      [
        Markup.button.callback('🔍 Find User', 'ADMIN_USERS'),
        Markup.button.callback('⚙️ System', 'ADMIN_SYSTEM'),
      ],
      [
        Markup.button.callback('📣 Broadcasts', 'ADMIN_BROADCASTS'),
        Markup.button.callback('🛡️ Admins', 'ADMIN_MANAGE_ADMINS'),
      ],
      [
        Markup.button.callback('🏆 Top Traders', 'ADMIN_TOP_TRADERS'),
        Markup.button.callback('📈 Funnel', 'ADMIN_FUNNEL'),
      ],
      [
        Markup.button.callback('🔎 Postback Verify', 'ADMIN_POSTBACK_VERIFY'),
        Markup.button.callback('📋 Audit', 'ADMIN_AUDIT'),
      ],
      [
        Markup.button.callback('🏠 Refresh', 'ADMIN_HOME'),
      ],
    ]),
  )
}

export function registerAdminRoutes(bot: Telegraf<BotContext>): void {
  bot.command('admin', requireAdmin, async (ctx) => {
    await sendAdminHome(ctx)
  })

  registerDiagIqRoutes(bot)

  // Achievement-routing escape hatches for support. Replaces the
  // pre-refactor practice of editing `flow_stage` directly via SQL
  // to recover a stuck user — that no longer affects routing now
  // that whereShouldUserBe reads achievement columns + lockout_reason
  // instead. Each command parses a telegramId arg, audits the
  // action, and reports the result.

  bot.command('admin_unlock', requireAdmin, async (ctx) => {
    const [arg] = ctx.message.text.split(' ').slice(1)
    if (!arg || !/^\d+$/.test(arg)) {
      await ctx.reply('Usage: /admin_unlock <telegramId>')
      return
    }
    const telegramId = BigInt(arg)
    const target = await userRepo.findById(telegramId)
    if (!target) {
      await ctx.reply(`User ${telegramId} not found.`)
      return
    }
    const previousReason = target.lockout_reason
    await userRepo.clearLockout(telegramId)
    await auditRepo.record({
      adminTelegramId: BigInt(ctx.from!.id),
      actionType: 'unlock_user',
      targetType: 'user',
      targetId: telegramId.toString(),
      payload: { previousReason },
    })
    await ctx.reply(
      previousReason
        ? `Cleared lockout (was: ${previousReason}) for ${telegramId}.`
        : `User ${telegramId} was not locked. No change.`,
    )
  })

  bot.command('admin_reset_journey', requireAdmin, async (ctx) => {
    const [arg] = ctx.message.text.split(' ').slice(1)
    if (!arg || !/^\d+$/.test(arg)) {
      await ctx.reply('Usage: /admin_reset_journey <telegramId>')
      return
    }
    const telegramId = BigInt(arg)
    const target = await userRepo.findById(telegramId)
    if (!target) {
      await ctx.reply(`User ${telegramId} not found.`)
      return
    }
    await userRepo.resetJourney(telegramId)
    await auditRepo.record({
      adminTelegramId: BigInt(ctx.from!.id),
      actionType: 'reset_journey',
      targetType: 'user',
      targetId: telegramId.toString(),
      // Snapshot the state we wiped so the audit row is forensically
      // useful — an admin reviewing later can see exactly what
      // achievement state the user had at reset time.
      payload: {
        cleared: {
          channel_joined_at: target.channel_joined_at,
          iq_account_confirmed_at: target.iq_account_confirmed_at,
          had_iq_session_token: Boolean(target.iq_session_token),
          agreement_accepted: target.agreement_accepted,
          first_deposit_at: target.first_deposit_at,
          lockout_reason: target.lockout_reason,
          tier: target.tier,
          account_mode: target.account_mode,
          flow_stage: target.flow_stage,
        },
      },
    })
    await ctx.reply(
      `Journey reset for ${telegramId}. Next /start will land them at CHANNEL_GATE.`,
    )
  })

  // Admin text handling now runs as adminFlowPriorityMw BEFORE
  // stage.middleware() — see bot/index.ts. Without that priority,
  // any leftover user-side scene (LOGIN_EMAIL, TOKEN_PENDING, etc.)
  // would consume the admin's reply (e.g. typing "50" as a verified
  // balance got eaten by LOGIN_EMAIL's "doesn't look like a valid
  // email" handler).

  // Media handlers — only intercept when the active admin flow is a broadcast
  // compose step. All other media uploads (e.g. PRO chart) fall through.
  const mediaHandler = async (ctx: BotContext, next: () => Promise<void>) => {
    if (!ctx.from) {
      await next()
      return
    }
    // Broadcast-compose only ever happens in the admin's private chat —
    // a photo in the alert channel must not be consumed as broadcast media.
    if (ctx.chat?.type !== 'private') {
      await next()
      return
    }
    const flow = currentFlow(ctx)
    if (!flow || flow.kind !== 'broadcast-message') {
      await next()
      return
    }
    const admin = await adminRepo.findById(BigInt(ctx.from.id))
    if (!admin || admin.removed_at) {
      await next()
      return
    }
    await adminRepo.touchLastActive(BigInt(ctx.from.id))
    await handleAdminMediaInput(ctx)
  }
  bot.on('photo', mediaHandler)
  bot.on('video', mediaHandler)
  bot.on('document', mediaHandler)
  bot.on('animation', mediaHandler)

  bot.action('ADMIN_HOME', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await sendAdminHome(ctx)
  })

  bot.action('ADMIN_STATS', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.reply(renderAdminQuickStats(await getAdminQuickStats()), Markup.inlineKeyboard([backRow()]))
  })

  bot.action('ADMIN_ACTIVATIONS', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.reply(renderActivationsBreakdown(await getActivationsBreakdown('7d')), Markup.inlineKeyboard([backRow()]))
  })

  bot.action('ADMIN_USERS', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await sendUsersMenu(ctx)
  })
  bot.action('ADMIN_USERS_SEARCH', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    setAdminFlow(ctx, 'user-search')
    await ctx.reply('Send a username, IQ user ID, or email to search.')
  })
  bot.action(/^ADMIN_USERS_BROWSE:(\d+)$/, requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await sendUserBrowsePage(ctx, Number(ctx.match[1] ?? '0'))
  })
  bot.action('ADMIN_USERS_FORCE_DEMO', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    setAdminFlow(ctx, 'user-search')
    await ctx.reply('Search for the user first, then use the Force Demo button on the result card.')
  })
  bot.action('ADMIN_USERS_PAUSE', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    setAdminFlow(ctx, 'user-search')
    await ctx.reply('Search for the user first, then use the Pause button on the result card.')
  })
  bot.action('ADMIN_USERS_SUSPEND', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    setAdminFlow(ctx, 'user-search')
    await ctx.reply('Search for the user first, then use the Suspend button on the result card.')
  })
  bot.action('ADMIN_USERS_HISTORY', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    setAdminFlow(ctx, 'user-search')
    await ctx.reply('Search for the user first, then use the History button on the result card.')
  })
  bot.action('ADMIN_USERS_DELETE', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    setAdminFlow(ctx, 'user-search')
    await ctx.reply('Search for the user first, then use the Delete button on the result card.')
  })
  bot.action('ADMIN_USERS_DM', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    setAdminFlow(ctx, 'user-search')
    await ctx.reply('Search for the user first, then use the DM button on the result card.')
  })

  bot.action(/^ADMIN_USER_FORCE_DEMO:(.+)$/, requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const telegramId = BigInt(ctx.match[1]!)
    await userRepo.setStatus(telegramId, 'force_demo')
    await auditRepo.record({
      adminTelegramId: BigInt(ctx.from!.id),
      actionType: 'force_demo',
      targetType: 'user',
      targetId: telegramId.toString(),
    })
    await ctx.reply(`User ${telegramId} forced into demo mode.`)
  })
  bot.action(/^ADMIN_USER_VIEW:(\d+):(\d+)$/, requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await sendUserDetail(ctx, BigInt(ctx.match[1]!), Number(ctx.match[2] ?? '0'))
  })
  bot.action(/^ADMIN_USER_PAUSE:(.+)$/, requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const telegramId = BigInt(ctx.match[1]!)
    await userRepo.setStatus(telegramId, 'paused')
    await auditRepo.record({
      adminTelegramId: BigInt(ctx.from!.id),
      actionType: 'pause_user',
      targetType: 'user',
      targetId: telegramId.toString(),
    })
    await ctx.reply(`User ${telegramId} paused.`)
  })
  bot.action(/^ADMIN_USER_SUSPEND:(.+)$/, requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    setAdminFlow(ctx, 'user-suspend', { telegramId: ctx.match[1]! })
    await ctx.reply(`Send the suspension reason for ${ctx.match[1]!}.`)
  })
  bot.action(/^ADMIN_USER_HISTORY:(.+)$/, requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const telegramId = BigInt(ctx.match[1]!)
    const trades = await tradeRepo.findRecentByUser(telegramId, 5)
    await ctx.reply(
      trades.length === 0
        ? 'No trades found.'
        : trades.map((trade) => `${trade.pair_code} ${trade.direction} ${trade.final_outcome ?? 'pending'} ${trade.net_result ?? '-'}`).join('\n'),
    )
  })
  bot.action(/^ADMIN_USER_DM:(.+)$/, requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    setAdminFlow(ctx, 'user-dm', { telegramId: ctx.match[1]! })
    await ctx.reply(`Send the message to deliver to ${ctx.match[1]!}.`)
  })
  bot.action(/^ADMIN_USER_DELETE:(.+)$/, requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const telegramId = ctx.match[1]!
    await ctx.reply(
      [
        '⚠️ HARD DELETE USER',
        '',
        `Telegram ID: ${telegramId}`,
        '',
        'This permanently deletes the user row, trades, and funnel history.',
        'It cannot be undone.',
      ].join('\n'),
      Markup.inlineKeyboard([
        [
          Markup.button.callback('Confirm Delete', `ADMIN_USER_DELETE_CONFIRM:${telegramId}`),
          Markup.button.callback('Cancel', 'ADMIN_USERS'),
        ],
      ]),
    )
  })
  bot.action(/^ADMIN_USER_DELETE_CONFIRM:(.+)$/, requireAdmin, async (ctx) => {
    await ctx.answerCbQuery('Deleting user')
    const telegramId = BigInt(ctx.match[1]!)
    await userRepo.hardDelete(telegramId)
    await auditRepo.record({
      adminTelegramId: BigInt(ctx.from!.id),
      actionType: 'hard_delete_user',
      targetType: 'user',
      targetId: telegramId.toString(),
    })
    await ctx.reply(`User ${telegramId} was hard deleted.`)
  })

  bot.action('ADMIN_SYSTEM', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await sendSystemMenu(ctx)
  })
  bot.action(/^ADMIN_SYSTEM_SET:(all|auto|pro):(on|off)$/, requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const fieldMap = { all: 'paused_all', auto: 'paused_auto', pro: 'paused_pro' } as const
    const field = fieldMap[ctx.match[1] as 'all' | 'auto' | 'pro']
    const enabled = ctx.match[2] === 'on'
    await systemStateRepo.setPaused(field, enabled, BigInt(ctx.from!.id))
    await auditRepo.record({
      adminTelegramId: BigInt(ctx.from!.id),
      actionType: enabled ? `pause_${ctx.match[1]}` : `resume_${ctx.match[1]}`,
      targetType: 'system',
      targetId: field,
    })
    await sendSystemMenu(ctx)
  })

  bot.action('ADMIN_BROADCASTS', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await sendBroadcastMenu(ctx)
  })
  bot.action(/^ADMIN_BROADCAST_MODE:(now|later)$/, requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await promptBroadcastSegments(ctx, ctx.match[1] as 'now' | 'later')
  })
  bot.action(/^ADMIN_BROADCAST_SEGMENT:(now|later):(.+)$/, requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const mode = ctx.match[1] as 'now' | 'later'
    const segment = ctx.match[2]!
    if (!ALL_SEGMENTS.includes(segment as never)) {
      await ctx.reply('Invalid segment.')
      return
    }
    if (mode === 'later') {
      setAdminFlow(ctx, 'broadcast-delay', { segment })
      await ctx.reply(
        `⏰ Send delay in seconds for *${segment}* (e.g. \`3600\` = 1 hour).`,
        { parse_mode: 'Markdown' },
      )
      return
    }
    setAdminFlow(ctx, 'broadcast-message', { segment })
    await ctx.reply(
      [
        `📝 Compose broadcast for *${segment}*`,
        '',
        'Send the message now 👇',
        '— text, photo, video, GIF, or document',
        '— caption supports placeholders',
        '',
        PLACEHOLDER_HINT,
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
  })

  bot.action('ADMIN_TOP_TRADERS', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const rows = await tradeRepo.topByVolumeLast30d(20)
    await ctx.reply(
      rows.length === 0
        ? 'No trade volume in last 30 days.'
        : rows.map((row, index) => `${index + 1}. ${row.user_telegram_id} - $${row.total_volume}`).join('\n'),
      Markup.inlineKeyboard([backRow()]),
    )
  })

  bot.action('ADMIN_FUNNEL', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const rows = await funnelRepo.funnelLast7d()
    await ctx.reply(rows.map((row) => `${row.eventType}: ${row.count}`).join('\n'), Markup.inlineKeyboard([backRow()]))
  })

  bot.action('ADMIN_AUDIT', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const rows = await auditRepo.listRecent(50)
    await ctx.reply(
      rows.length === 0
        ? 'No audit log rows.'
        : rows.map((row) => `${row.created_at.toISOString()} ${row.admin_telegram_id} ${row.action_type} ${row.target_type ?? '-'}:${row.target_id ?? '-'}`).join('\n'),
      Markup.inlineKeyboard([backRow()]),
    )
  })

  bot.action('ADMIN_POSTBACK_VERIFY', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    setAdminFlow(ctx, 'postback-verify')
    await ctx.reply('Send the IQ trader_id to verify.')
  })

  bot.action('ADMIN_MANAGE_ADMINS', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await sendManageAdminsMenu(ctx)
  })
  bot.action('ADMIN_MANAGE_ADD', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    setAdminFlow(ctx, 'admin-add-id')
    await ctx.reply('Send the Telegram ID of the new admin.')
  })
  bot.action('ADMIN_MANAGE_REMOVE', requireAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    setAdminFlow(ctx, 'admin-remove-id')
    await ctx.reply('Send the Telegram ID to remove.')
  })
}

export * from './permissions.js'
export * from './stats.js'
export * from './activations.js'
export * from './users.js'
export * from './system.js'
export * from './broadcast.js'
export * from './topTraders.js'
export * from './funnel.js'
export * from './audit.js'
export * from './manageAdmins.js'
export * from './postbackVerify.js'
