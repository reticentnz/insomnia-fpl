import type { Position } from './domain.ts'

export const CALIBRATION_MINIMUM_OBSERVATIONS = 100
export const CALIBRATION_FACTOR_MIN = 0.85
export const CALIBRATION_FACTOR_MAX = 1.15

export type BacktestRow = {
  position: Position
  expectedPoints: number
  actualPoints: number
  p10Points?: number
  p90Points?: number
  horizon?: number
  minutesConfidence?: string
  strengthMethod?: string
  baselines?: Partial<Record<BaselineName, number>>
}

export type BaselineName = 'FPL_EP_NEXT' | 'FPL_FORM' | 'FPL_POINTS_PER_GAME'
export type BaselineMetric = { name: BaselineName; sampleSize: number; mae: number; rmse: number; bias: number; rankCorrelation: number | null }

export type CalibrationResult = {
  position: Position | 'ALL'
  sampleSize: number
  factor: number
  mae: number
  rmse: number
  bias: number
  intervalCoverage: number
  rankCorrelation: number | null
  calibrated: boolean
}

export type BacktestMetric = CalibrationResult & {
  horizon: number
  confidenceBand: string
  strengthMethod: string
}

const round = (value: number, digits = 6) => +value.toFixed(digits)
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function averageRanks(values: number[]) {
  const ranked = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
  const result = Array<number>(values.length)
  for (let start = 0; start < ranked.length;) {
    let end = start + 1
    while (end < ranked.length && ranked[end].value === ranked[start].value) end++
    const rank = (start + 1 + end) / 2
    for (let cursor = start; cursor < end; cursor++) result[ranked[cursor].index] = rank
    start = end
  }
  return result
}

/** Spearman rank correlation with average ranks for tied forecasts/results. */
export function spearmanRankCorrelation(predicted: number[], actual: number[]): number | null {
  if (predicted.length < 2 || predicted.length !== actual.length) return null
  const x = averageRanks(predicted)
  const y = averageRanks(actual)
  const meanX = x.reduce((sum, value) => sum + value, 0) / x.length
  const meanY = y.reduce((sum, value) => sum + value, 0) / y.length
  let numerator = 0; let left = 0; let right = 0
  for (let index = 0; index < x.length; index++) {
    const dx = x[index] - meanX; const dy = y[index] - meanY
    numerator += dx * dy; left += dx * dx; right += dy * dy
  }
  if (left === 0 || right === 0) return null
  return round(numerator / Math.sqrt(left * right))
}

export function summarizeBacktestRows(rows: BacktestRow[], dimensions: Pick<BacktestMetric, 'position' | 'horizon' | 'confidenceBand' | 'strengthMethod'>): BacktestMetric {
  if (!rows.length) return { ...dimensions, sampleSize: 0, factor: 1, mae: 0, rmse: 0, bias: 0, intervalCoverage: 0, rankCorrelation: null, calibrated: false }
  const errors = rows.map(row => row.expectedPoints - row.actualPoints)
  const predicted = rows.reduce((sum, row) => sum + row.expectedPoints, 0)
  const actual = rows.reduce((sum, row) => sum + row.actualPoints, 0)
  const sampleSize = rows.length
  const calibrated = sampleSize >= CALIBRATION_MINIMUM_OBSERVATIONS && predicted > 0
  const coveredRows = rows.filter(row => row.p10Points != null && row.p90Points != null)
  return {
    ...dimensions,
    sampleSize,
    // Factors are intentionally withheld below the documented evidence threshold.
    factor: calibrated ? round(clamp(actual / predicted, CALIBRATION_FACTOR_MIN, CALIBRATION_FACTOR_MAX), 6) : 1,
    mae: round(errors.reduce((sum, error) => sum + Math.abs(error), 0) / sampleSize),
    rmse: round(Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / sampleSize)),
    bias: round(errors.reduce((sum, error) => sum + error, 0) / sampleSize),
    intervalCoverage: coveredRows.length ? round(coveredRows.filter(row => row.actualPoints >= row.p10Points! && row.actualPoints <= row.p90Points!).length / coveredRows.length) : 0,
    rankCorrelation: spearmanRankCorrelation(rows.map(row => row.expectedPoints), rows.map(row => row.actualPoints)),
    calibrated,
  }
}

/** Full calibration groups used by the persisted, versioned calibration ledger. */
export function evaluateBacktestMetrics(rows: BacktestRow[]): BacktestMetric[] {
  const groups = new Map<string, BacktestRow[]>()
  for (const row of rows) {
    const horizon = row.horizon ?? 1
    const confidenceBand = row.minutesConfidence || 'UNKNOWN'
    const strengthMethod = row.strengthMethod || 'UNKNOWN'
    const key = [row.position, horizon, confidenceBand, strengthMethod].join('\u0000')
    const group = groups.get(key) || []
    group.push(row); groups.set(key, group)
  }
  return [...groups.entries()].map(([key, group]) => {
    const [position, horizon, confidenceBand, strengthMethod] = key.split('\u0000')
    return summarizeBacktestRows(group, { position: position as Position, horizon: Number(horizon), confidenceBand, strengthMethod })
  }).sort((left, right) => left.position.localeCompare(right.position) || left.horizon - right.horizon || left.confidenceBand.localeCompare(right.confidenceBand) || left.strengthMethod.localeCompare(right.strengthMethod))
}

/** Compare the model with simple values that were available before deadline. */
export function evaluateBaselineMetrics(rows: BacktestRow[]): BaselineMetric[] {
  return (['FPL_EP_NEXT', 'FPL_FORM', 'FPL_POINTS_PER_GAME'] as BaselineName[]).map(name => {
    const eligible = rows.flatMap(row => {
      const prediction = row.baselines?.[name]
      return Number.isFinite(prediction) ? [{ predicted: Number(prediction), actual: row.actualPoints }] : []
    })
    if (!eligible.length) return { name, sampleSize: 0, mae: 0, rmse: 0, bias: 0, rankCorrelation: null }
    const errors = eligible.map(row => row.predicted - row.actual)
    return {
      name, sampleSize: eligible.length,
      mae: round(errors.reduce((sum, error) => sum + Math.abs(error), 0) / eligible.length),
      rmse: round(Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / eligible.length)),
      bias: round(errors.reduce((sum, error) => sum + error, 0) / eligible.length),
      rankCorrelation: spearmanRankCorrelation(eligible.map(row => row.predicted), eligible.map(row => row.actual)),
    }
  })
}

/** Compatibility-facing position summaries now use the same threshold and caps. */
export function evaluateCalibration(rows: BacktestRow[]): CalibrationResult[] {
  return (['GK', 'DEF', 'MID', 'FWD'] as Position[]).map(position =>
    summarizeBacktestRows(rows.filter(row => row.position === position), { position, horizon: 1, confidenceBand: 'ALL', strengthMethod: 'ALL' }),
  ).concat(summarizeBacktestRows(rows, { position: 'ALL', horizon: 1, confidenceBand: 'ALL', strengthMethod: 'ALL' }))
}
