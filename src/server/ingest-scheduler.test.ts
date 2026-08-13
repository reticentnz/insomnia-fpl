import { describe, expect, it } from 'vitest'
import { nextIngestSchedule, parseIngestIntervalHours } from './ingest-scheduler.ts'

describe('durable official-ingestion scheduling', () => {
  it('keeps the database-anchored due time across a container restart', () => {
    const lastSuccessfulAt = '2026-08-11T09:23:00.000Z'
    const restartedAt = Date.parse('2026-08-11T15:41:00.000Z')

    expect(nextIngestSchedule(lastSuccessfulAt, 12, restartedAt)).toEqual({
      lastIngestedAt: lastSuccessfulAt,
      nextIngestAt: '2026-08-11T21:23:00.000Z',
      delayMs: 5 * 60 * 60 * 1000 + 42 * 60 * 1000,
    })
  })

  it('runs immediately after restart when the persisted refresh is overdue', () => {
    const restartedAt = Date.parse('2026-08-12T09:41:00.000Z')
    const schedule = nextIngestSchedule('2026-08-11T09:23:00.000Z', 12, restartedAt)

    expect(schedule?.nextIngestAt).toBe('2026-08-12T09:41:00.000Z')
    expect(schedule?.delayMs).toBe(0)
  })

  it('anchors the next run to a completed manual refresh', () => {
    const completedAt = '2026-08-12T10:00:00.000Z'
    const schedule = nextIngestSchedule(completedAt, 12, Date.parse(completedAt))

    expect(schedule?.nextIngestAt).toBe('2026-08-12T22:00:00.000Z')
  })

  it('supports disabled and default intervals', () => {
    expect(parseIngestIntervalHours('0')).toBe(0)
    expect(parseIngestIntervalHours('invalid')).toBe(0)
    expect(parseIngestIntervalHours(undefined)).toBe(12)
    expect(parseIngestIntervalHours(undefined, 24)).toBe(24)
    expect(nextIngestSchedule(null, 0)).toBeNull()
  })
})
