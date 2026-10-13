import { describe, expect, it } from '@jest/globals'
import { ALL_SEGMENTS, buildSegmentQuery } from './broadcastSegmenter.js'

describe('broadcastSegmenter', () => {
  it('exposes 8 segment names', () => {
    expect(ALL_SEGMENTS).toHaveLength(8)
    expect(ALL_SEGMENTS).toContain('all')
    expect(ALL_SEGMENTS).toContain('demo')
    expect(ALL_SEGMENTS).toContain('auto')
    expect(ALL_SEGMENTS).toContain('pro')
    expect(ALL_SEGMENTS).toContain('inactive_7d')
  })

  it('all → no tier filter', () => {
    const query = buildSegmentQuery('all')
    expect(query.text).toContain('FROM users')
    expect(query.text).not.toContain('tier =')
    expect(query.params).toEqual([])
  })

  it('demo → tier filter', () => {
    const query = buildSegmentQuery('demo')
    expect(query.text).toContain('tier = $1')
    expect(query.params).toEqual(['demo'])
  })

  it('inactive_7d → activity older than 7 days', () => {
    const query = buildSegmentQuery('inactive_7d')
    expect(query.text).toContain('last_activity <')
  })

  it('new_today → created_at within 24h', () => {
    const query = buildSegmentQuery('new_today')
    expect(query.text).toContain('created_at >')
  })

  it('throws on unknown segment', () => {
    expect(() => buildSegmentQuery('garbage' as never)).toThrow()
  })
})
