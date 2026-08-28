export type DecisionRankingInput = {
  playerId: string
  expectedPoints: number
  expectedPointsWithoutBonus?: number | null
  pointsPerGame?: number | null
}

export const DECISION_RANKING_VERSION = 'elite-selection-rank-v1'
export const DECISION_RANKING_WEIGHTS = { expectedPoints: .6, expectedPointsWithoutBonus: .3, pointsPerGame: .1 } as const

/** Average percentile ranks preserve ties and make differently-scaled inputs comparable. */
export function averagePercentileRanks<T>(rows: T[], value: (row: T) => number | null | undefined) {
  const ranked = rows.map((row, index) => ({ index, value: Number(value(row)) })).filter(row => Number.isFinite(row.value)).sort((left, right) => left.value - right.value)
  const result = new Array<number | null>(rows.length).fill(null)
  if (ranked.length < 2 || ranked[0].value === ranked[ranked.length - 1].value) return result
  for (let start = 0; start < ranked.length;) {
    let end = start + 1
    while (end < ranked.length && ranked[end].value === ranked[start].value) end += 1
    const percentile = ((start + end - 1) / 2) / (ranked.length - 1)
    for (let index = start; index < end; index += 1) result[ranked[index].index] = percentile
    start = end
  }
  return result
}

/**
 * Selection utility only. Never use this value as expected points, calibration
 * input, hit economics, or a robustness threshold.
 */
export function decisionRankingScores(rows: DecisionRankingInput[]) {
  const features = {
    expectedPoints: averagePercentileRanks(rows, row => row.expectedPoints),
    expectedPointsWithoutBonus: averagePercentileRanks(rows, row => row.expectedPointsWithoutBonus),
    pointsPerGame: averagePercentileRanks(rows, row => row.pointsPerGame),
  }
  return new Map(rows.map((row, index) => {
    let weighted = 0, availableWeight = 0
    for (const key of Object.keys(DECISION_RANKING_WEIGHTS) as Array<keyof typeof DECISION_RANKING_WEIGHTS>) {
      const percentile = features[key][index]
      if (percentile == null) continue
      weighted += DECISION_RANKING_WEIGHTS[key] * percentile
      availableWeight += DECISION_RANKING_WEIGHTS[key]
    }
    return [row.playerId, availableWeight ? weighted / availableWeight : 0] as const
  }))
}
