export type ForecastReadinessState = 'READY' | 'DEGRADED' | 'RUNNING' | 'STALE' | 'FAILED' | 'MISSING'

export type ForecastQualityInput = {
  fallbackFixtureRatio: number
  lowMinutesFixtureRatio: number
  underlyingPlayerRatio: number
  marketFixtureRatio: number
}

export type ForecastStatusInput = {
  reachable?: boolean
  status: 'initializing' | 'seeding' | 'ready' | 'error'
  isSeeding: boolean
  isIngesting?: boolean
  isRecalculating?: boolean
  ingestIntervalHours?: number
}

export type ForecastSummaryInput = {
  asOf: string
  createdAt: string
  horizon: number
  gameweeks: number[]
  players: Array<{ fixtureCount: number }>
  quality?: ForecastQualityInput
}

export function deriveForecastReadiness(system: ForecastStatusInput | null, forecast: ForecastSummaryInput | null, now = Date.now()) {
  const intervalHours = Number(system?.ingestIntervalHours || 0)
  const staleAfterHours = Math.max(24, intervalHours > 0 ? intervalHours * 2 : 24)
  const asOfMs = forecast ? Date.parse(forecast.asOf) : Number.NaN
  const ageHours = Number.isFinite(asOfMs) ? Math.max(0, (now - asOfMs) / 3_600_000) : null
  const running = Boolean(system?.isSeeding || system?.isIngesting || system?.isRecalculating || system?.status === 'initializing' || system?.status === 'seeding')
  let state: ForecastReadinessState
  if (system?.reachable === false || system?.status === 'error') state = 'FAILED'
  else if (running) state = 'RUNNING'
  else if (!forecast) state = 'MISSING'
  else if (ageHours === null || ageHours > staleAfterHours) state = 'STALE'
  else if ((forecast.quality?.fallbackFixtureRatio ?? 0) >= .5 || (forecast.quality?.lowMinutesFixtureRatio ?? 0) >= .25) state = 'DEGRADED'
  else state = 'READY'
  const warnings: string[] = []
  if (forecast?.quality && forecast.quality.fallbackFixtureRatio >= .5) warnings.push(`${Math.round(forecast.quality.fallbackFixtureRatio * 100)}% of fixture forecasts use FDR fallback strength.`)
  if (forecast?.quality && forecast.quality.lowMinutesFixtureRatio >= .25) warnings.push(`${Math.round(forecast.quality.lowMinutesFixtureRatio * 100)}% of fixture forecasts have low minutes confidence.`)
  if (forecast?.quality && forecast.quality.underlyingPlayerRatio === 0) warnings.push('Underlying performance data is missing.')
  return {
    state,
    ageHours,
    staleAfterHours,
    playerCount: forecast?.players.length || 0,
    fixtureCount: forecast?.players.reduce((sum, player) => sum + Number(player.fixtureCount || 0), 0) || 0,
    coveredGameweeks: forecast?.gameweeks.length || 0,
    warnings,
  }
}
