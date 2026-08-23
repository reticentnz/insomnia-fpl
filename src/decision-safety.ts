import type { ForecastReadinessState } from './forecast-status.ts'

export type RecommendationAssumptions = {
  freeTransfersConfirmed: boolean
  exactSellingPrices: boolean
}

export type RecommendationSafety = {
  actionable: boolean
  confidence: 'HIGH' | 'MEDIUM' | 'PROVISIONAL' | 'BLOCKED'
  reasons: string[]
}

/**
 * Keeps a numerically valid recommendation from becoming prescriptive when
 * either its forecast inputs or the manager-specific transfer economics are
 * not trustworthy enough to execute.
 */
export function deriveRecommendationSafety(
  readiness: ForecastReadinessState,
  assumptions: RecommendationAssumptions,
  probabilityBeatsRoll: number | null = null,
): RecommendationSafety {
  const reasons: string[] = []
  if (readiness !== 'READY') {
    reasons.push(readiness === 'DEGRADED'
      ? 'Forecast inputs are degraded.'
      : readiness === 'RUNNING'
        ? 'The forecast is still refreshing.'
        : readiness === 'STALE'
          ? 'The forecast is stale.'
          : 'No current forecast is available.')
  }
  if (!assumptions.freeTransfersConfirmed) reasons.push('Free transfers have not been confirmed for this gameweek.')
  if (!assumptions.exactSellingPrices) reasons.push('Exact selling prices are unavailable for one or more owned players.')

  const actionable = reasons.length === 0
  if (!actionable) return { actionable: false, confidence: readiness === 'DEGRADED' ? 'PROVISIONAL' : 'BLOCKED', reasons }
  if (probabilityBeatsRoll !== null && probabilityBeatsRoll >= .75) return { actionable: true, confidence: 'HIGH', reasons }
  return { actionable: true, confidence: 'MEDIUM', reasons }
}
