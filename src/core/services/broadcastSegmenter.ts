export type Segment =
  | 'all'
  | 'demo'
  | 'auto'
  | 'pro'
  | 'new_today'
  | 'new_7d'
  | 'new_30d'
  | 'inactive_7d'

export const ALL_SEGMENTS: readonly Segment[] = [
  'all',
  'demo',
  'auto',
  'pro',
  'new_today',
  'new_7d',
  'new_30d',
  'inactive_7d',
] as const

export type SegmentQuery = { text: string; params: unknown[] }

export function buildSegmentCountQuery(segment: Segment): SegmentQuery {
  const inner = buildSegmentQuery(segment)
  return { text: `SELECT COUNT(*)::int AS count FROM (${inner.text}) sub`, params: inner.params }
}

export function buildSegmentQuery(segment: Segment): SegmentQuery {
  const baseSelect = "SELECT telegram_id FROM users WHERE status = 'active'"

  switch (segment) {
    case 'all':
      return { text: baseSelect, params: [] }
    case 'demo':
      return { text: `${baseSelect} AND tier = $1`, params: ['demo'] }
    case 'auto':
      return { text: `${baseSelect} AND tier = $1`, params: ['auto'] }
    case 'pro':
      return { text: `${baseSelect} AND tier = $1`, params: ['pro'] }
    case 'new_today':
      return {
        text: `${baseSelect} AND created_at > NOW() - INTERVAL '24 hours'`,
        params: [],
      }
    case 'new_7d':
      return {
        text: `${baseSelect} AND created_at > NOW() - INTERVAL '7 days'`,
        params: [],
      }
    case 'new_30d':
      return {
        text: `${baseSelect} AND created_at > NOW() - INTERVAL '30 days'`,
        params: [],
      }
    case 'inactive_7d':
      return {
        text: `${baseSelect} AND last_activity < NOW() - INTERVAL '7 days'`,
        params: [],
      }
    default:
      throw new Error(`unknown segment: ${segment as string}`)
  }
}
