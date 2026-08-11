export type ForecastReadinessState = 'READY' | 'RUNNING' | 'STALE' | 'FAILED' | 'MISSING'

export type ForecastStatusInput = {
  reachable?: boolean
  status: 'initializing' | 'seeding' | 'ready' | 'error'
  isSeeding: boolean
  isIngesting?: boolean
  ingestIntervalHours?: number
}

export type ForecastSummaryInput = {
  asOf: string
  createdAt: string
  horizon: number
  gameweeks: number[]
  players: Array<{ fixtureCount: number }>
}

export function deriveForecastReadiness(system: ForecastStatusInput | null, forecast: ForecastSummaryInput | null, now = Date.now()) {
  const intervalHours = Number(system?.ingestIntervalHours || 0)
  const staleAfterHours = Math.max(24, intervalHours > 0 ? intervalHours * 2 : 24)
  const asOfMs = forecast ? Date.parse(forecast.asOf) : Number.NaN
  const ageHours = Number.isFinite(asOfMs) ? Math.max(0, (now - asOfMs) / 3_600_000) : null
  const running = Boolean(system?.isSeeding || system?.isIngesting || system?.status === 'initializing' || system?.status === 'seeding')
  let state: ForecastReadinessState
  if (system?.reachable === false || system?.status === 'error') state = 'FAILED'
  else if (running) state = 'RUNNING'
  else if (!forecast) state = 'MISSING'
  else if (ageHours === null || ageHours > staleAfterHours) state = 'STALE'
  else state = 'READY'
  return {
    state,
    ageHours,
    staleAfterHours,
    playerCount: forecast?.players.length || 0,
    fixtureCount: forecast?.players.reduce((sum, player) => sum + Number(player.fixtureCount || 0), 0) || 0,
    coveredGameweeks: forecast?.gameweeks.length || 0,
  }
}
