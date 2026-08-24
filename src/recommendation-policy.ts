export const WATCHLIST_PROBABILITY = 0.60
export const ACTION_PROBABILITY = 0.75
export const MIN_ACTION_NET_GAIN = 2.0

export type RecommendationClassification =
  | 'ROBUST'
  | 'MARGINAL'
  | 'SENSITIVE'
  | 'INELIGIBLE'

export type RecommendationPolicyInput = {
  action: string
  affordabilityStatus: string
  netExpectedGain: number
  probabilityBeatsRoll: number | null
  actionable?: boolean
  roleLatestMatchSensitive?: boolean
  latestMatchSensitive?: boolean
  latestMatchSensitivity?: 'LOW' | 'MEDIUM' | 'HIGH'
}

export function classifyRecommendation(
  input: RecommendationPolicyInput,
): RecommendationClassification {
  if (
    input.action !== 'TRANSFER' ||
    input.actionable === false ||
    input.affordabilityStatus !== 'EXACT' ||
    input.probabilityBeatsRoll === null
  ) {
    return 'INELIGIBLE'
  }

  if (
    input.roleLatestMatchSensitive ||
    input.latestMatchSensitive ||
    input.latestMatchSensitivity === 'HIGH'
  ) {
    return 'SENSITIVE'
  }

  if (
    input.netExpectedGain >= MIN_ACTION_NET_GAIN &&
    input.probabilityBeatsRoll >= ACTION_PROBABILITY
  ) {
    return 'ROBUST'
  }

  return 'MARGINAL'
}
