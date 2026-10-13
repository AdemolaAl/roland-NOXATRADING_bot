import { Scenes } from 'telegraf'
import type { BotContext } from '../index.js'
import { IqClient } from '../../trading/iqClient.js'
import { adoptClient } from '../../trading/iqSessionCache.js'
import { ensureUser, getUserFlowData, transitionAfterEvent } from './_bridge.js'
import { isPartnerVerified } from '../../core/services/partnerVerification.js'
import { finishLogin } from './_sceneHelpers.js'
import { pause, typing } from './_uxHelpers.js'
import { getEgressIp } from '../../infra/egressIp.js'
import { userRepo } from '../../core/repositories/index.js'

export const loginVerifyingScene = new Scenes.BaseScene<BotContext>('LOGIN_VERIFYING')

loginVerifyingScene.enter(async (ctx) => {
  const flow = await getUserFlowData(ctx)
  const email = String(flow.email ?? '')
  const password = String(flow.password ?? '')
  const loginAttempts = Number(flow.loginAttempts ?? 0)
  const user = await ensureUser(ctx)

  if (!email || !password) {
    await ctx.reply('Login data missing. Start again.')
    await ctx.scene.enter('LOGIN_EMAIL')
    return
  }

  // Multi-stage progress spectacle while the actual login runs in parallel.
  await typing(ctx, 500)
  const status = await ctx.reply('🔐 Connecting to IQ Option…')
  const editStatus = async (text: string) => {
    await ctx.telegram
      .editMessageText(status.chat.id, status.message_id, undefined, text)
      .catch(() => {})
  }

  const client = new IqClient()
  const loginPromise = client.login(email, password, BigInt(user.telegram_id))
  // The login can reject ~immediately for "authentication is failed", but we
  // don't await it for ~1.8s while we run the cosmetic stages below. Without
  // a synchronous catch attached now, Node 22 sees the rejection as
  // unhandled before the await in the try/catch fires and crashes the
  // entire process. Attaching a noop catch here registers a handler so
  // Node treats the rejection as handled; the await loginPromise below
  // still observes the rejection through the original promise chain and
  // hits the catch arm correctly.
  loginPromise.catch(() => {})

  // Cosmetic stages — login is normally 2-4s, this fills the visual gap.
  await pause(900)
  await editStatus('🔍 Authenticating…')
  await pause(900)
  await editStatus('📊 Reading your account…')

  let loginSucceeded = false
  try {
    const result = await loginPromise
    // Initial partner-verification read off the cached user row. The SDK
    // login never returns a partnerCode (iqClient.login sets it to null
    // unconditionally — the SDK's UserProfile facade doesn't expose
    // affiliate/partner info), so isPartnerVerified relies entirely on
    // the second branch: iq_account_confirmed_at + iq_promoter_link +
    // iq_trader_id === iqUserId. All three columns are written by
    // attributePostback → markIqAccountConfirmed when IQ's S2S postback
    // for our clickId arrives.
    let partnerVerified = isPartnerVerified({
      iqUserId: result.iqUserId,
      partnerCode: result.partnerCode,
      confirmedTraderId: user.iq_trader_id,
      confirmedAt: user.iq_account_confirmed_at,
      promoterLink: user.iq_promoter_link,
    })
    // If the user came through our clickId flow but the postback hasn't
    // landed yet, poll briefly for it before deciding. Fresh signups
    // often complete LOGIN_VERIFYING before IQ fires the registration
    // postback — rejecting them as non-partner here is the
    // "Account connected … ❌ not under our partner flow" loop we keep
    // seeing in support reports. The `currentClickId` flag (set in
    // iqSignupHelp.enter when we mint a clickid for this user) is the
    // signal that the user is on our funnel and a postback should
    // arrive. If polling exhausts with no postback, fall through to
    // the existing NON_PARTNER_REJECT path — a missing postback for
    // 8 seconds means they probably didn't actually sign up under our
    // afftrack and the rejection is correct.
    const userFlow = (user.flow_data ?? {}) as Record<string, unknown>
    const cameThroughOurFlow =
      typeof userFlow.currentClickId === 'string' && userFlow.currentClickId.length > 0
    if (!partnerVerified && cameThroughOurFlow && !user.iq_account_confirmed_at) {
      ctx.logger?.info(
        {
          event: 'login_verify_awaiting_postback',
          telegramId: user.telegram_id,
          iqUserId: result.iqUserId,
          clickId: userFlow.currentClickId,
        },
        'login succeeded before postback arrived — polling',
      )
      for (let attempt = 0; attempt < 8; attempt++) {
        await pause(1000)
        const refreshed = await userRepo.findById(BigInt(user.telegram_id))
        if (!refreshed) break
        partnerVerified = isPartnerVerified({
          iqUserId: result.iqUserId,
          partnerCode: result.partnerCode,
          confirmedTraderId: refreshed.iq_trader_id,
          confirmedAt: refreshed.iq_account_confirmed_at,
          promoterLink: refreshed.iq_promoter_link,
        })
        if (partnerVerified) {
          ctx.logger?.info(
            {
              event: 'login_verify_postback_arrived',
              telegramId: user.telegram_id,
              waitedMs: (attempt + 1) * 1000,
            },
            'postback arrived during poll — partner verified',
          )
          break
        }
      }
    }
    loginSucceeded = true
    await editStatus('✅ Logged in')
    await pause(450)
    await ctx.reply(
      [
        '*Account connected*',
        `📧  ${email}`,
        `💼  *$${result.initialBalance.demo.toFixed(2)}* demo · *$${result.initialBalance.live.toFixed(2)}* live`,
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
    await finishLogin(
      BigInt(user.telegram_id),
      email,
      result.sessionToken,
      result.iqUserId,
      result.initialBalance,
      partnerVerified,
      // Pass plaintext password so finishLogin can persist an
      // encrypted copy for silent re-auth. The password was already
      // in flow_data above; this just hands it to the storage path.
      password,
    )
    // Hand the freshly-warmed SDK to the cache so the user's first trade
    // (typically seconds away) doesn't pay another WS handshake.
    adoptClient(BigInt(user.telegram_id), client, user.account_mode ?? 'demo')
    await transitionAfterEvent(
      ctx,
      partnerVerified
        ? { type: 'IQ_LOGIN_SUCCESS_PARTNER' }
        : { type: 'IQ_LOGIN_SUCCESS_NON_PARTNER' },
      {
        flowDataPatch: { email, loginAttempts: 0 },
      },
    )
  } catch (err) {
    // Distinguish IQ-side credential rejection from a connectivity failure
    // (ETIMEDOUT, WebSocket handshake drop, etc.). Only the former is the
    // user's fault — blaming the user's email when the upstream API is
    // unreachable produced the "correct creds but Login failed" report
    // that prompted this code path's overhaul.
    const isAuthFailure =
      err instanceof Error && err.message === 'authentication is failed'

    if (isAuthFailure) {
      await editStatus('❌ Login failed.\nDouble-check your email and try again.')
      const nextAttempts = loginAttempts + 1
      await transitionAfterEvent(
        ctx,
        nextAttempts >= 3 ? { type: 'IQ_LOGIN_FAIL_LOCKED' } : { type: 'IQ_LOGIN_FAIL_RETRY' },
        {
          flowDataPatch: { email, loginAttempts: nextAttempts },
        },
      )
    } else {
      ctx.logger?.warn(
        {
          event: 'iq_login_connectivity_error',
          err,
          telegramId: user.telegram_id,
          // Stamp so the operator can grab the IP directly from this log
          // line when forwarding to IQ Option support.
          egressIp: getEgressIp(),
        },
        'IQ login failed at connectivity layer (not auth)',
      )
      await editStatus(
        "⚠️ We can't reach IQ Option right now.\nThis is on their side — please try again in a minute.",
      )
      // Don't increment loginAttempts: lockout is for wrong credentials,
      // not for upstream outages. Reuse the RETRY transition so the user
      // is sent back to LOGIN_EMAIL and can try again.
      await transitionAfterEvent(
        ctx,
        { type: 'IQ_LOGIN_FAIL_RETRY' },
        {
          flowDataPatch: { email, loginAttempts },
        },
      )
    }
  } finally {
    if (!loginSucceeded) {
      await client.logout().catch(() => {})
    }
  }
})
