import type { Telegraf } from 'telegraf'
import {
  BalanceType,
  ClientSdk,
  SsidAuthMethod,
} from '@tradecodehub/client-sdk-js'
import type { BotContext } from '../bot/index.js'
import { requireAdmin } from './permissions.js'

type LegResult =
  | { ok: true; ms: number; detail: string }
  | { ok: false; ms: number; detail: string }

function errString(e: unknown): string {
  if (e && typeof e === 'object') {
    const anyE = e as { code?: string; message?: string; name?: string; address?: string; port?: number }
    const parts = [
      anyE.name ?? 'Error',
      anyE.code ? `code=${anyE.code}` : undefined,
      anyE.address ? `addr=${anyE.address}:${anyE.port}` : undefined,
      anyE.message,
    ].filter(Boolean)
    return parts.join(' ')
  }
  return String(e)
}

export function registerDiagIqRoutes(bot: Telegraf<BotContext>): void {
  bot.command('diag_iq', requireAdmin, async (ctx) => {
    const httpUrl = process.env.IQ_SDK_HTTP_URL
    const wsUrl = process.env.IQ_SDK_WS_URL
    const platformId = Number(process.env.IQ_SDK_PLATFORM_ID ?? '82')
    const email = process.env.IQ_TEST_EMAIL
    const password = process.env.IQ_TEST_PASSWORD
    if (!httpUrl || !wsUrl) {
      await ctx.reply('IQ_SDK_HTTP_URL / IQ_SDK_WS_URL not set on this host.')
      return
    }
    if (!email || !password) {
      await ctx.reply('IQ_TEST_EMAIL / IQ_TEST_PASSWORD not set on this host.')
      return
    }

    const progress = await ctx.reply('🔬 Probing IQ Option from this host…')
    const editProgress = async (text: string) => {
      await ctx.telegram
        .editMessageText(progress.chat.id, progress.message_id, undefined, text, {
          parse_mode: 'Markdown',
        })
        .catch(() => {})
    }

    const legs: Record<string, LegResult> = {}
    let sdk: ClientSdk | null = null

    // Leg 0: Egress IP probe — the public IP that IQ Option (and every other
    // upstream) sees on connections from this container. Critical for IQ
    // support whitelisting and for diagnosing per-IP rate-limit / block
    // situations. Races two independent echo services so a single one being
    // down doesn't fail the report.
    {
      const t0 = Date.now()
      try {
        const ip = await Promise.any([
          fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5_000) }).then((r) => r.text()),
          fetch('https://ifconfig.me/ip', { signal: AbortSignal.timeout(5_000) }).then((r) => r.text()),
        ])
        legs.egress = { ok: true, ms: Date.now() - t0, detail: ip.trim() }
      } catch (e) {
        legs.egress = { ok: false, ms: Date.now() - t0, detail: errString(e) }
      }
    }

    // Leg 1: HTTP login
    let ssid: string | null = null
    {
      const t0 = Date.now()
      try {
        const res = await fetch(`${httpUrl}/v2/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'tradecodehub-client-sdk-js/1.3.0',
          },
          body: JSON.stringify({ identifier: email, password }),
          signal: AbortSignal.timeout(15_000),
        })
        const json = (await res.json().catch(() => ({}))) as {
          code?: string
          ssid?: string
        }
        const ms = Date.now() - t0
        if (!res.ok || json.code !== 'success' || !json.ssid) {
          legs.http = {
            ok: false,
            ms,
            detail: `http=${res.status} code=${json.code ?? 'none'}`,
          }
        } else {
          ssid = json.ssid
          legs.http = { ok: true, ms, detail: `http=${res.status}` }
        }
      } catch (e) {
        legs.http = { ok: false, ms: Date.now() - t0, detail: errString(e) }
      }
    }

    // Leg 2: WebSocket handshake via SDK
    if (ssid) {
      const t0 = Date.now()
      try {
        sdk = await Promise.race([
          ClientSdk.create(wsUrl, platformId, new SsidAuthMethod(ssid)),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('ws_handshake_timeout_15s')), 15_000),
          ),
        ])
        legs.ws = {
          ok: true,
          ms: Date.now() - t0,
          detail: `userId=${sdk.userProfile.userId}`,
        }
      } catch (e) {
        legs.ws = { ok: false, ms: Date.now() - t0, detail: errString(e) }
      }
    }

    // Leg 3: Balance fetch
    if (sdk) {
      const t0 = Date.now()
      try {
        const balances = await Promise.race([
          sdk.balances(),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('balances_timeout_10s')), 10_000),
          ),
        ])
        const demo = balances.getBalances().find((b) => b.type === BalanceType.Demo)
        const live = balances.getBalances().find((b) => b.type === BalanceType.Real)
        legs.balance = {
          ok: true,
          ms: Date.now() - t0,
          detail: `demo=$${demo?.amount ?? '?'} live=$${live?.amount ?? '?'}`,
        }
      } catch (e) {
        legs.balance = { ok: false, ms: Date.now() - t0, detail: errString(e) }
      }
    }

    await sdk?.shutdown().catch(() => {})

    const lines = ['*IQ Option probe (from bot host)*', '']
    for (const [name, r] of Object.entries(legs)) {
      const icon = r.ok ? '✅' : '❌'
      lines.push(`${icon} *${name}* — ${r.ms}ms — \`${r.detail}\``)
    }
    if (!legs.http) lines.push('— skipped (no leg ran)')
    if (legs.http?.ok && !legs.ws)
      lines.push('— ws skipped (http failed before ssid)')
    if (legs.ws?.ok === false) lines.push('\n⚠️ WS leg failed — egress likely blocked.')
    if (legs.http?.ok === false)
      lines.push('\n⚠️ HTTP leg failed — DNS / TCP / TLS to auth.iqoption.com unreachable.')

    await editProgress(lines.join('\n'))
  })
}
