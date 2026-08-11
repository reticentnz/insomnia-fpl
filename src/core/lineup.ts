export type LineupPosition = 'GK' | 'DEF' | 'MID' | 'FWD'

export type StoredForecast = {
  playerId: string
  gameweekId: string
  position: LineupPosition
  meanPoints: number
  standardDeviation: number
  p10Points: number
  p50Points: number
  p90Points: number
  startProbability: number
  noShowProbability: number
}

export type Lineup = {
  starters: string[]
  bench: string[]
  captainId: string | null
  viceCaptainId: string | null
  expectedPoints: number
  standardDeviation: number
  p10Points: number
  p50Points: number
  p90Points: number
}

const required: Record<LineupPosition, number> = { GK: 1, DEF: 3, MID: 2, FWD: 1 }
const combinations = <T>(values: T[], count: number): T[][] => {
  if (count === 0) return [[]]
  if (values.length < count) return []
  return values.flatMap((value, index) => combinations(values.slice(index + 1), count - 1).map(rest => [value, ...rest]))
}
const sum = (rows: StoredForecast[], key: keyof Pick<StoredForecast, 'meanPoints' | 'standardDeviation' | 'p10Points' | 'p50Points' | 'p90Points'>) => rows.reduce((total, row) => total + Number(row[key] || 0), 0)

/** Selects a legal FPL XI from the stored, gameweek-aggregated forecasts. */
export function selectLineup(rows: StoredForecast[]): Lineup {
  const byPosition = (position: LineupPosition) => rows.filter(row => row.position === position).sort((a, b) => b.meanPoints - a.meanPoints || a.playerId.localeCompare(b.playerId))
  const keepers = byPosition('GK'), defenders = byPosition('DEF'), midfielders = byPosition('MID'), forwards = byPosition('FWD')
  let best: StoredForecast[] | null = null
  for (const defCount of [3, 4, 5]) for (const midCount of [2, 3, 4, 5]) {
    const forwardCount = 11 - 1 - defCount - midCount
    if (forwardCount < 1 || forwardCount > 3) continue
    for (const defs of combinations(defenders, defCount)) for (const mids of combinations(midfielders, midCount)) for (const fwds of combinations(forwards, forwardCount)) {
      const candidate = [...keepers.slice(0, required.GK), ...defs, ...mids, ...fwds]
      if (candidate.length !== 11) continue
      if (!best || sum(candidate, 'meanPoints') > sum(best, 'meanPoints')) best = candidate
    }
  }
  const starters = best || []
  const starterIds = new Set(starters.map(row => row.playerId))
  const bench = rows.filter(row => !starterIds.has(row.playerId)).sort((a, b) => b.meanPoints - a.meanPoints || a.playerId.localeCompare(b.playerId))
  const captainCandidates = [...starters].sort((a, b) => (b.meanPoints * (1 - b.noShowProbability)) - (a.meanPoints * (1 - a.noShowProbability)) || a.playerId.localeCompare(b.playerId))
  const captain = captainCandidates[0] || null, vice = captainCandidates.find(row => row.playerId !== captain?.playerId) || null
  // Expected automatic substitutions are represented conservatively: the first
  // legal bench option covers a starter's no-show probability.
  const cover = starters.reduce((total, starter) => total + starter.noShowProbability * (bench[0]?.meanPoints || 0) / Math.max(1, starters.length), 0)
  const captainBonus = captain ? captain.meanPoints * (1 - captain.noShowProbability) + (vice?.meanPoints || 0) * captain.noShowProbability * (1 - (vice?.noShowProbability || 0)) : 0
  return {
    starters: starters.map(row => row.playerId), bench: bench.map(row => row.playerId), captainId: captain?.playerId || null, viceCaptainId: vice?.playerId || null,
    expectedPoints: sum(starters, 'meanPoints') + captainBonus + cover,
    standardDeviation: Math.sqrt(starters.reduce((total, row) => total + row.standardDeviation ** 2, 0)),
    p10Points: sum(starters, 'p10Points'), p50Points: sum(starters, 'p50Points'), p90Points: sum(starters, 'p90Points'),
  }
}
