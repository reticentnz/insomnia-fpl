type UnknownRecord = Record<string, unknown>

const finiteNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const bool = (value: unknown): boolean => value === true

export type RecommendationAccounting = {
  rawGain: number
  hitCost: number
  uncertaintyPenalty: number
  savedTransferValue: number
  netExpectedGain: number
}

export function recommendationAccounting(candidate: unknown): RecommendationAccounting | null {
  if (!candidate || typeof candidate !== 'object') return null
  const source = candidate as UnknownRecord
  const rawGain = finiteNumber(source.rawGain)
  const hitCost = finiteNumber(source.hitCost)
  const uncertaintyPenalty = finiteNumber(source.uncertaintyPenalty)
  const savedTransferValue = finiteNumber(source.savedTransferValue)
  const netExpectedGain = finiteNumber(source.netExpectedGain)
  if ([rawGain, hitCost, uncertaintyPenalty, savedTransferValue, netExpectedGain].some(value => value === null)) return null
  return { rawGain: rawGain!, hitCost: hitCost!, uncertaintyPenalty: uncertaintyPenalty!, savedTransferValue: savedTransferValue!, netExpectedGain: netExpectedGain! }
}

export function formatSigned(value: number, decimals = 2) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}`
}

export function formatAccounting(candidate: unknown): string | null {
  const accounting = recommendationAccounting(candidate)
  if (!accounting) return null
  const futureTerm = accounting.savedTransferValue >= 0
    ? `− roll option ${accounting.savedTransferValue.toFixed(2)}`
    : `+ future-structure advantage ${Math.abs(accounting.savedTransferValue).toFixed(2)}`
  return `Raw gain ${formatSigned(accounting.rawGain)} − hit ${accounting.hitCost.toFixed(2)} − uncertainty ${accounting.uncertaintyPenalty.toFixed(2)} ${futureTerm} = net ${formatSigned(accounting.netExpectedGain)} pts`
}

/** Normalizes optional server metadata without making older recommendation APIs unusable. */
export function recommendationSensitivity(candidate: unknown): string[] {
  if (!candidate || typeof candidate !== 'object') return []
  const source = candidate as UnknownRecord
  const nested = source.sensitivity && typeof source.sensitivity === 'object' ? source.sensitivity as UnknownRecord : {}
  const rawFlags = Array.isArray(source.sensitivityFlags) ? source.sensitivityFlags : Array.isArray(nested.flags) ? nested.flags : []
  const flags = rawFlags.filter((value): value is string => typeof value === 'string').map(flag => flag.toUpperCase())
  const earlySeason = bool(source.earlySeasonSensitive) || bool(source.earlySeason) || bool(nested.earlySeason) || flags.includes('EARLY_SEASON')
  const latestMatch = bool(source.latestMatchSensitive) || bool(source.latestMatchSensitivity) || bool(nested.latestMatch) || nested.latestMatchSensitivity === 'HIGH' || flags.includes('LATEST_MATCH') || flags.includes('LATEST_MATCH_SENSITIVE')
  return [
    ...(earlySeason ? ['EARLY-SEASON SENSITIVE'] : []),
    ...(latestMatch ? ['LATEST-MATCH SENSITIVE'] : []),
  ]
}

export function recommendationInputStatus(recommendation: unknown): string | null {
  if (!recommendation || typeof recommendation !== 'object') return null
  const source = recommendation as UnknownRecord
  const status = typeof source.inputChangeStatus === 'string' ? source.inputChangeStatus : typeof source.recomputeStatus === 'string' ? source.recomputeStatus : null
  if (status) return status.replaceAll('_', ' ').toLowerCase()
  if (source.cacheStatus === 'HIT') return 'reused stored result — inputs unchanged'
  if (source.cacheStatus === 'MISS') return 'new stored result'
  return null
}

export function optionalRecommendationLabel(candidate: unknown, keys: string[]): string | null {
  if (!candidate || typeof candidate !== 'object') return null
  const source = candidate as UnknownRecord
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.replaceAll('_', ' ')
  }
  return null
}

export type RecommendationTiming = { verdict: string; details: string[] }

/** Accepts a compact legacy string or the structured timing assessment when it is available. */
export function recommendationTiming(candidate: unknown): RecommendationTiming | null {
  if (!candidate || typeof candidate !== 'object') return null
  const source = candidate as UnknownRecord
  const direct = ['timingAdvice', 'timing'].map(key => source[key]).find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const priceTiming = source.priceTiming
  if (typeof priceTiming === 'string' && priceTiming.trim()) return { verdict: direct || priceTiming, details: [] }
  if (!priceTiming || typeof priceTiming !== 'object') return direct ? { verdict: direct, details: [] } : null
  const timing = priceTiming as UnknownRecord
  const verdict = direct || (typeof timing.verdict === 'string' ? timing.verdict : null)
  if (!verdict) return null
  const pressureDescription = (value: unknown) => value && typeof value === 'object' && typeof (value as UnknownRecord).description === 'string'
    ? (value as UnknownRecord).description as string
    : null
  const details = [
    pressureDescription(timing.incomingPressure),
    pressureDescription(timing.outgoingPressure),
    ...(Array.isArray(timing.reasons) ? timing.reasons.filter((reason): reason is string => typeof reason === 'string' && reason.trim().length > 0) : []),
  ].filter((value): value is string => Boolean(value))
  return { verdict: verdict.replaceAll('_', ' '), details: [...new Set(details)] }
}
