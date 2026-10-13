import { query } from '../infra/db.js'

export type ActivationRange = 'today' | '7d' | 'this_week' | '30d' | 'all_time'
export type ActivationBreakdown = {
  range: ActivationRange
  demo: number
  auto: number
  pro: number
  total: number
}

const RANGE_SQL: Record<ActivationRange, string> = {
  today: "created_at >= date_trunc('day', now())",
  '7d': "created_at >= now() - interval '7 days'",
  this_week: "created_at >= date_trunc('week', now())",
  '30d': "created_at >= now() - interval '30 days'",
  all_time: 'TRUE',
}

export async function getActivationsBreakdown(
  range: ActivationRange,
): Promise<ActivationBreakdown> {
  const result = await query<{ tier: 'demo' | 'auto' | 'pro'; count: string }>(
    `SELECT tier, COUNT(*)::text AS count
     FROM users
     WHERE ${RANGE_SQL[range]}
     GROUP BY tier`,
  )

  const counts = new Map(result.rows.map((row) => [row.tier, Number(row.count)]))
  const demo = counts.get('demo') ?? 0
  const auto = counts.get('auto') ?? 0
  const pro = counts.get('pro') ?? 0

  return {
    range,
    demo,
    auto,
    pro,
    total: demo + auto + pro,
  }
}

export function renderActivationsBreakdown(breakdown: ActivationBreakdown): string {
  return [
    `Activations (${breakdown.range})`,
    `Demo: ${breakdown.demo}`,
    `AUTO: ${breakdown.auto}`,
    `PRO: ${breakdown.pro}`,
    `Total: ${breakdown.total}`,
  ].join('\n')
}
