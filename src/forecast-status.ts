export type ForecastReadinessState = 'READY' | 'DEGRADED' | 'RUNNING' | 'STALE' | 'FAILED' | 'MISSING'

export type ForecastQualityInput = {
  fallbackFixtureRatio: number
  lowMinutesFixtureRatio: number
  underlyingPlayerRatio: number
  marketFixtureRatio: number
  nearTermFallbackFixtureRatio?: number
  nearTermMarketFixtureRatio?: number
  derivedStrengthFixtureRatio?: number
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

export function forecastQualityMetrics(quality?: ForecastQualityInput) {
  if (!quality) return []
  return [
    { id: 'fallback', label: 'FDR fallback', value: Math.round(quality.fallbackFixtureRatio * 100), limited: quality.fallbackFixtureRatio >= .5 },
    { id: 'minutes', label: 'Low minutes confidence', value: Math.round(quality.lowMinutesFixtureRatio * 100), limited: quality.lowMinutesFixtureRatio >= .25 },
    { id: 'underlying', label: 'Underlying coverage', value: Math.round(quality.underlyingPlayerRatio * 100), limited: quality.underlyingPlayerRatio < .5 },
    { id: 'market', label: 'Next-GW market', value: Math.round((quality.nearTermMarketFixtureRatio ?? quality.marketFixtureRatio) * 100), limited: (quality.nearTermMarketFixtureRatio ?? quality.marketFixtureRatio) < .5 },
  ]
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
  else if ((forecast.quality?.nearTermFallbackFixtureRatio ?? forecast.quality?.fallbackFixtureRatio ?? 0) >= .5 || (forecast.quality?.lowMinutesFixtureRatio ?? 0) >= .25) state = 'DEGRADED'
  else state = 'READY'
  const warnings: string[] = []
  const nearTermFallback = forecast?.quality ? forecast.quality.nearTermFallbackFixtureRatio ?? forecast.quality.fallbackFixtureRatio : 0
  const nearTermMarket = forecast?.quality ? forecast.quality.nearTermMarketFixtureRatio ?? forecast.quality.marketFixtureRatio : 0
  if (forecast?.quality && nearTermFallback >= .5) warnings.push(`${Math.round(nearTermFallback * 100)}% of next-GW fixture forecasts use FDR fallback strength.`)
  if (forecast?.quality && forecast.quality.lowMinutesFixtureRatio >= .25) warnings.push(`${Math.round(forecast.quality.lowMinutesFixtureRatio * 100)}% of fixture forecasts have low minutes confidence.`)
  if (forecast?.quality && forecast.quality.underlyingPlayerRatio < .5) warnings.push(`Underlying performance coverage is only ${Math.round(forecast.quality.underlyingPlayerRatio * 100)}%.`)
  if (forecast?.quality && nearTermMarket < .5) warnings.push(`Next-GW market-strength coverage is only ${Math.round(nearTermMarket * 100)}%.`)
  const recommendedActions: string[] = []
  if (forecast?.quality && (nearTermFallback >= .5 || nearTermMarket < .5)) recommendedActions.push('Run Admin → Sync performance + odds and check the odds feed configuration.')
  if (forecast?.quality && forecast.quality.underlyingPlayerRatio < .5) recommendedActions.push('Run Admin → Sync performance + odds and review unmatched Understat players.')
  if (forecast?.quality && forecast.quality.lowMinutesFixtureRatio >= .25) recommendedActions.push('Review current role and availability evidence in Signals.')
  return {
    state,
    ageHours,
    staleAfterHours,
    playerCount: forecast?.players.length || 0,
    fixtureCount: forecast?.players.reduce((sum, player) => sum + Number(player.fixtureCount || 0), 0) || 0,
    coveredGameweeks: forecast?.gameweeks.length || 0,
    warnings,
    recommendedActions,
    qualityMetrics: forecastQualityMetrics(forecast?.quality),
  }
}

export type ForecastReadiness = ReturnType<typeof deriveForecastReadiness>
