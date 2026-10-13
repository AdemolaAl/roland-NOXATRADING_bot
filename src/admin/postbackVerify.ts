import type { IqPostbackRepository, IqPostbackProfile } from '../core/repositories/iqPostbackRepo.js'
import { ROLAND_AFFTRACK } from '../core/services/leadVerification.js'

export type PostbackBadge = {
  line: string
  detail: string
  profile: IqPostbackProfile
  isOwned: boolean
  isMismatchedAfftrack: boolean
}

const fmtUSD = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (d: Date | null): string =>
  d ? new Date(d).toISOString().slice(0, 10) : 'unknown'

export async function buildPostbackBadge(
  repo: IqPostbackRepository,
  traderId: string,
): Promise<PostbackBadge> {
  const profile = await repo.lookupByTraderId(traderId)
  const isOwned = profile.afftracks.includes(ROLAND_AFFTRACK)
  const isMismatchedAfftrack = profile.inFunnel && profile.afftracks.length > 0 && !isOwned

  if (!profile.inFunnel) {
    return {
      line: '❌ Not in affiliate funnel — trader_id never registered through our link',
      detail: [
        '❌ *Affiliate verification failed*',
        '',
        'This trader_id has *no postback rows* in our funnel.',
        'They likely signed up directly on IQ Option without using our partner link,',
        'or the trader_id is wrong.',
      ].join('\n'),
      profile,
      isOwned: false,
      isMismatchedAfftrack: false,
    }
  }

  const owner = profile.afftracks[0] ?? '(unknown)'
  const ownerLabel = isOwned
    ? '✅ NOXATRADING-owned'
    : `⚠️ Owned by *${owner}* (different afftrack)`
  const depositLine = profile.hasDeposited
    ? `💰 Deposits: ${fmtUSD(profile.depositTotal)} across ${profile.depositCount} ${profile.depositCount === 1 ? 'event' : 'events'}`
    : '🪙 Registered but never deposited'

  return {
    line: `${ownerLabel}  ·  ${depositLine}`,
    detail: [
      `${ownerLabel}`,
      '',
      `🆔 Trader: \`${traderId}\``,
      `🏷  Afftrack: ${profile.afftracks.map((a) => `*${a}*`).join(', ') || '(none)'}`,
      `📅 Registered: ${fmtDate(profile.registeredAt)}`,
      profile.hasDeposited
        ? `💰 Lifetime deposits: *${fmtUSD(profile.depositTotal)}* across *${profile.depositCount}* events`
        : '🪙 Lifetime deposits: *$0.00* (registered, never deposited)',
      profile.lastDepositAt ? `🕒 Last deposit: ${fmtDate(profile.lastDepositAt)}` : null,
      profile.countryCode ? `🌍 Country: ${profile.countryCode}` : null,
      isMismatchedAfftrack
        ? '\n⚠️ *Mismatched afftrack* — this trader belongs to another afftrack, not NOXATRADING.'
        : null,
    ]
      .filter(Boolean)
      .join('\n'),
      profile,
      isOwned,
      isMismatchedAfftrack,
  }
}
