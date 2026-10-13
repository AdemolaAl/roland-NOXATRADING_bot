import { query } from '../infra/db.js'

export type AdminQuickStats = {
  activationsToday: number
  tradesToday: number
  // P&L split — demo trades are theatrical (no real money on the line),
  // live trades are real IQ Option capital. Combining them in one
  // headline made admins misread an angry-looking number that was
  // mostly fake demo flow.
  netLiveToday: string
  netDemoToday: string
  liveTradersToday: number
  avgLiveResultPerUser: string
  // Proxy for "likely blew their IQ Option account": aborted live
  // trades. The gale executor aborts with reason='insufficient_balance'
  // when the next gale step exceeds the user's balance — but we only
  // persist final_outcome='aborted', not the reason. SDK-error aborts
  // exist too (rare) so this slightly over-counts, hence the "likely"
  // label in the rendered string. To make this precise we'd add an
  // abort_reason column; fine to defer until the count is meaningful.
  liveAbortsToday: number
  activeTickets: number
}

export async function getAdminQuickStats(): Promise<AdminQuickStats> {
  const activations = await query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM users WHERE created_at >= date_trunc('day', now())",
  )

  // Single trades-table scan returns every aggregate we need today.
  // Postgres FILTER clauses are O(1) per group on top of the base
  // sequential scan, so this is the same cost as one COUNT(*) + SUM().
  const trades = await query<{
    total_trades: string
    net_live: string
    net_demo: string
    live_traders: string
    live_aborts: string
  }>(
    `SELECT
       COUNT(*)::text AS total_trades,
       COALESCE(SUM(net_result) FILTER (WHERE account_mode = 'live'), 0)::text AS net_live,
       COALESCE(SUM(net_result) FILTER (WHERE account_mode = 'demo'), 0)::text AS net_demo,
       COUNT(DISTINCT user_telegram_id)
         FILTER (WHERE account_mode = 'live')::text AS live_traders,
       COUNT(*)
         FILTER (WHERE account_mode = 'live' AND final_outcome = 'aborted')::text
         AS live_aborts
     FROM trades
     WHERE started_at >= date_trunc('day', now())`,
  )

  const row = trades.rows[0]
  const liveTraders = Number(row?.live_traders ?? '0')
  const netLive = Number(row?.net_live ?? '0')
  const avgLive = liveTraders > 0 ? netLive / liveTraders : 0

  return {
    activationsToday: Number(activations.rows[0]?.count ?? '0'),
    tradesToday: Number(row?.total_trades ?? '0'),
    netLiveToday: (row?.net_live ?? '0').toString(),
    netDemoToday: (row?.net_demo ?? '0').toString(),
    liveTradersToday: liveTraders,
    avgLiveResultPerUser: avgLive.toFixed(2),
    liveAbortsToday: Number(row?.live_aborts ?? '0'),
    activeTickets: 0,
  }
}

// Format a numeric P&L string (which may be negative) with a sign and a
// fixed two-decimal scale. "-100.5" → "-$100.50", "200" → "+$200.00",
// "0" → "$0.00" (no sign for zero, less visually noisy).
function fmtSigned(value: string | number): string {
  const num = Number(value)
  if (!Number.isFinite(num) || num === 0) return '$0.00'
  return `${num > 0 ? '+' : '-'}$${Math.abs(num).toFixed(2)}`
}

export function renderAdminQuickStats(stats: AdminQuickStats): string {
  const liveLine = stats.liveTradersToday > 0
    ? `💰 Net (LIVE): ${fmtSigned(stats.netLiveToday)}  ·  ${stats.liveTradersToday} trader${stats.liveTradersToday === 1 ? '' : 's'}  ·  avg ${fmtSigned(stats.avgLiveResultPerUser)}/user`
    : `💰 Net (LIVE): ${fmtSigned(stats.netLiveToday)}  ·  no live traders today`
  const abortLine = stats.liveAbortsToday > 0
    ? `⚠️  Aborted live trades (likely blow-outs): ${stats.liveAbortsToday}`
    : '✅  No aborted live trades'
  return [
    '🔐 NOXATRADING ADMIN',
    '',
    'Today at a glance',
    `👥 Activations: ${stats.activationsToday}`,
    `📈 Trades: ${stats.tradesToday}`,
    liveLine,
    `🧪 Net (DEMO): ${fmtSigned(stats.netDemoToday)}  (theatrical, no real money)`,
    abortLine,
    `🎫 Open tickets: ${stats.activeTickets}`,
  ].join('\n')
}
