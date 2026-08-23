import { describe, expect, it } from 'vitest'
import { deriveForecastReadiness } from './forecast-status'

const readySystem = { reachable: true, status: 'ready' as const, isSeeding: false, isIngesting: false, ingestIntervalHours: 12 }
const forecast = { asOf: '2026-08-11T00:00:00Z', createdAt: '2026-08-11T00:01:00Z', horizon: 5, gameweeks: [1, 2, 3], players: [{ fixtureCount: 3 }, { fixtureCount: 2 }] }

describe('forecast operational readiness', () => {
  it('reports ready with explicit player, fixture, and gameweek coverage', () => {
    expect(deriveForecastReadiness(readySystem, forecast, Date.parse('2026-08-11T12:00:00Z'))).toMatchObject({ state: 'READY', playerCount: 2, fixtureCount: 5, coveredGameweeks: 3 })
  })

  it('distinguishes running, stale, failed, and missing states', () => {
    expect(deriveForecastReadiness({ ...readySystem, isIngesting: true }, forecast).state).toBe('RUNNING')
    expect(deriveForecastReadiness(readySystem, forecast, Date.parse('2026-08-13T00:01:00Z')).state).toBe('STALE')
    expect(deriveForecastReadiness({ ...readySystem, status: 'error' }, forecast).state).toBe('FAILED')
    expect(deriveForecastReadiness(readySystem, null).state).toBe('MISSING')
  })

  it('marks a fresh forecast degraded when fallback or minutes-risk coverage is excessive', () => {
    const degraded = { ...forecast, quality: { fallbackFixtureRatio: 1, lowMinutesFixtureRatio: .31, underlyingPlayerRatio: 0, marketFixtureRatio: 0 } }
    const result = deriveForecastReadiness(readySystem, degraded, Date.parse('2026-08-11T12:00:00Z'))
    expect(result.state).toBe('DEGRADED')
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('100% of fixture forecasts use FDR fallback'),
      expect.stringContaining('Underlying performance coverage is only 0%'),
      expect.stringContaining('Market-strength coverage is only 0%'),
    ]))
    expect(result.recommendedActions).toEqual(expect.arrayContaining([expect.stringContaining('Sync performance + odds')]))
  })
})
