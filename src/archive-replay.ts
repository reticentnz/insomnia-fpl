import { selectLineup, type LineupPosition, type StoredForecast } from './core/lineup.ts'

export type ArchiveReplayPlayer = {
  playerId: string
  name: string
  position: LineupPosition
  expectedPoints: number
  expectedPointsWithoutBonus?: number
  selectionScore?: number
  actualPoints: number
  actualMinutes: number
  startProbability: number
  noShowProbability: number
  baselines: Partial<Record<'FPL_EP_NEXT' | 'FPL_FORM' | 'FPL_POINTS_PER_GAME', number>>
}

export type TopKDecisionMetric = {
  k: number
  eligiblePlayers: number
  recall: number
  realizedPoints: number
  oraclePoints: number
  regretPoints: number
  meanRegret: number
}

export type ReplayDecisionMetric = {
  eligiblePlayers: number
  topK: TopKDecisionMetric[]
  formationGlobalXI: null | {
    selectedPlayerIds: string[]
    oraclePlayerIds: string[]
    recall: number
    realizedPoints: number
    oraclePoints: number
    regretPoints: number
    captainId: string | null
    viceCaptainId: string | null
    captainBonusRealized: number
    captainOracleBonusWithinXI: number
    captainRegretWithinXI: number
    captainTop1Hit: boolean
    captainTop3Hit: boolean
    captainNoShow: boolean
    viceFallback: boolean
    teamRegret: number
  }
}

const finite = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null
const round = (value: number, digits = 6) => +value.toFixed(digits)
const compare = (score: (row: ArchiveReplayPlayer) => number) => (left: ArchiveReplayPlayer, right: ArchiveReplayPlayer) =>
  score(right) - score(left) || left.playerId.localeCompare(right.playerId)

function topKMetric(rows: ArchiveReplayPlayer[], score: (row: ArchiveReplayPlayer) => number, k: number): TopKDecisionMetric | null {
  if (rows.length < k || k <= 0) return null
  const predicted = [...rows].sort(compare(score)).slice(0, k)
  const actual = [...rows].sort(compare(row => row.actualPoints))
  const threshold = actual[k - 1].actualPoints
  const actualAtThreshold = new Set(actual.filter(row => row.actualPoints >= threshold).map(row => row.playerId))
  const realizedPoints = predicted.reduce((sum, row) => sum + row.actualPoints, 0)
  const oraclePoints = actual.slice(0, k).reduce((sum, row) => sum + row.actualPoints, 0)
  const regretPoints = oraclePoints - realizedPoints
  return {
    k,
    eligiblePlayers: rows.length,
    recall: round(predicted.filter(row => actualAtThreshold.has(row.playerId)).length / k),
    realizedPoints: round(realizedPoints),
    oraclePoints: round(oraclePoints),
    regretPoints: round(regretPoints),
    meanRegret: round(regretPoints / k),
  }
}

const positionalMaximum: Record<LineupPosition, number> = { GK: 1, DEF: 5, MID: 5, FWD: 3 }

function formationPool(rows: ArchiveReplayPlayer[], score: (row: ArchiveReplayPlayer) => number) {
  return (Object.keys(positionalMaximum) as LineupPosition[]).flatMap(position => rows
    .filter(row => row.position === position)
    .sort(compare(score))
    .slice(0, positionalMaximum[position]))
}

function lineupRows(rows: ArchiveReplayPlayer[], score: (row: ArchiveReplayPlayer) => number): StoredForecast[] {
  return formationPool(rows, score).map(row => ({
    playerId: row.playerId,
    gameweekId: 'archive-replay',
    position: row.position,
    meanPoints: score(row),
    standardDeviation: 0,
    p10Points: score(row),
    p50Points: score(row),
    p90Points: score(row),
    startProbability: row.startProbability,
    noShowProbability: row.noShowProbability,
  }))
}

function thresholdHit(values: number[], candidate: number, rank: number) {
  if (!values.length) return false
  const threshold = [...values].sort((left, right) => right - left)[Math.min(rank, values.length) - 1]
  return candidate >= threshold
}

/** Decision-quality metrics for a single player/gameweek episode. */
export function evaluateReplayDecisionMetrics(
  input: ArchiveReplayPlayer[],
  score: (row: ArchiveReplayPlayer) => number = row => row.expectedPoints,
  topKs = [1, 3, 5, 10, 20],
): ReplayDecisionMetric {
  const rows = input.filter(row => finite(score(row)) != null && finite(row.actualPoints) != null)
  const topK = topKs.flatMap(k => topKMetric(rows, score, k) || [])
  const positionCounts = new Map<LineupPosition, number>()
  for (const row of rows) positionCounts.set(row.position, (positionCounts.get(row.position) || 0) + 1)
  const enoughForXI = (positionCounts.get('GK') || 0) >= 1 && (positionCounts.get('DEF') || 0) >= 3 && (positionCounts.get('MID') || 0) >= 2 && (positionCounts.get('FWD') || 0) >= 1 && rows.length >= 11
  if (!enoughForXI) return { eligiblePlayers: rows.length, topK, formationGlobalXI: null }

  const selected = selectLineup(lineupRows(rows, score))
  const oracle = selectLineup(lineupRows(rows, row => row.actualPoints))
  if (selected.starters.length !== 11 || oracle.starters.length !== 11) return { eligiblePlayers: rows.length, topK, formationGlobalXI: null }
  const byId = new Map(rows.map(row => [row.playerId, row]))
  const selectedActuals = selected.starters.map(id => byId.get(id)!).filter(Boolean)
  const oracleActuals = oracle.starters.map(id => byId.get(id)!).filter(Boolean)
  const selectedIds = new Set(selected.starters)
  const realizedPoints = selectedActuals.reduce((sum, row) => sum + row.actualPoints, 0)
  const oraclePoints = oracleActuals.reduce((sum, row) => sum + row.actualPoints, 0)
  const captain = selected.captainId ? byId.get(selected.captainId) || null : null
  const vice = selected.viceCaptainId ? byId.get(selected.viceCaptainId) || null : null
  const captainNoShow = Boolean(captain && captain.actualMinutes <= 0)
  const viceFallback = Boolean(captainNoShow && vice && vice.actualMinutes > 0)
  const captainBonusRealized = captainNoShow ? (viceFallback ? vice!.actualPoints : 0) : (captain?.actualPoints || 0)
  const playingStarterPoints = selectedActuals.filter(row => row.actualMinutes > 0).map(row => row.actualPoints)
  const captainOracleBonusWithinXI = playingStarterPoints.length ? Math.max(...playingStarterPoints) : 0
  const captainActual = captainNoShow ? Number.NEGATIVE_INFINITY : (captain?.actualPoints ?? Number.NEGATIVE_INFINITY)
  const oracleCaptainBonus = Math.max(0, ...oracleActuals.filter(row => row.actualMinutes > 0).map(row => row.actualPoints))
  const xiRegret = oraclePoints - realizedPoints
  const captainRegret = captainOracleBonusWithinXI - captainBonusRealized

  return {
    eligiblePlayers: rows.length,
    topK,
    formationGlobalXI: {
      selectedPlayerIds: selected.starters,
      oraclePlayerIds: oracle.starters,
      recall: round(oracle.starters.filter(id => selectedIds.has(id)).length / 11),
      realizedPoints: round(realizedPoints),
      oraclePoints: round(oraclePoints),
      regretPoints: round(xiRegret),
      captainId: selected.captainId,
      viceCaptainId: selected.viceCaptainId,
      captainBonusRealized: round(captainBonusRealized),
      captainOracleBonusWithinXI: round(captainOracleBonusWithinXI),
      captainRegretWithinXI: round(captainRegret),
      captainTop1Hit: thresholdHit(playingStarterPoints, captainActual, 1),
      captainTop3Hit: thresholdHit(playingStarterPoints, captainActual, 3),
      captainNoShow,
      viceFallback,
      teamRegret: round((oraclePoints + oracleCaptainBonus) - (realizedPoints + captainBonusRealized)),
    },
  }
}

export function evaluateReplayBaselines(rows: ArchiveReplayPlayer[]) {
  return Object.fromEntries((['FPL_EP_NEXT', 'FPL_FORM', 'FPL_POINTS_PER_GAME'] as const).map(name => {
    const eligible = rows.filter(row => finite(row.baselines[name]) != null)
    return [name, evaluateReplayDecisionMetrics(eligible, row => Number(row.baselines[name]))]
  }))
}
