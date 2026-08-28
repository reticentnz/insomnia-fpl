import { combineSampleStreams, summarizeSampleDistribution } from './uncertainty.ts'

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
  /** Percentile ensemble used only for elite candidate search/order. */
  selectionScore?: number
  expectedPointsWithoutBonus?: number
  pointsPerGame?: number
  samples?: readonly number[]
  minuteSamples?: readonly number[]
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
  samples?: readonly number[]
}

const required: Record<LineupPosition, number> = { GK: 1, DEF: 3, MID: 2, FWD: 1 }
const combinations = <T>(values: T[], count: number): T[][] => {
  if (count === 0) return [[]]
  if (values.length < count) return []
  return values.flatMap((value, index) => combinations(values.slice(index + 1), count - 1).map(rest => [value, ...rest]))
}
const sum = (rows: StoredForecast[], key: keyof Pick<StoredForecast, 'meanPoints' | 'standardDeviation' | 'p10Points' | 'p50Points' | 'p90Points'>) => rows.reduce((total, row) => total + Number(row[key] || 0), 0)

function captainPairBonus(captain: StoredForecast, vice: StoredForecast | null) {
  if (vice && captain.samples?.length && captain.minuteSamples?.length === captain.samples.length && vice.samples?.length === captain.samples.length && vice.minuteSamples?.length === captain.samples.length) {
    return captain.samples.reduce((total, points, index) => total + ((captain.minuteSamples![index] ?? 0) > 0
      ? points
      : (vice.minuteSamples![index] ?? 0) > 0 ? (vice.samples![index] ?? 0) : 0), 0) / captain.samples.length
  }
  // meanPoints is already unconditional and therefore already contains the
  // player's own no-show mass. Only the vice fallback needs to be added.
  return captain.meanPoints + captain.noShowProbability * (vice?.meanPoints || 0)
}

function selectCaptainPair(starters: StoredForecast[]) {
  let best: { captain: StoredForecast; vice: StoredForecast | null; bonus: number } | null = null
  for (const captain of starters) {
    const viceOptions = starters.filter(row => row.playerId !== captain.playerId)
    for (const vice of viceOptions.length ? viceOptions : [null]) {
      const bonus = captainPairBonus(captain, vice)
      const key = `${captain.playerId}:${vice?.playerId || ''}`
      const bestKey = best ? `${best.captain.playerId}:${best.vice?.playerId || ''}` : ''
      const viceMean = vice?.meanPoints || 0, bestViceMean = best?.vice?.meanPoints || 0
      if (!best || bonus > best.bonus || bonus === best.bonus && (viceMean > bestViceMean || viceMean === bestViceMean && key.localeCompare(bestKey) < 0)) best = { captain, vice, bonus }
    }
  }
  return best
}

/** Selects a legal FPL XI from the stored, gameweek-aggregated forecasts. */
export function selectLineup(rows: StoredForecast[]): Lineup {
  // Aggregate multi-fixture (DGW) forecasts per unique playerId before selection
  const uniquePlayerMap = new Map<string, StoredForecast>()
  for (const row of rows) {
    const existing = uniquePlayerMap.get(row.playerId)
    if (!existing) {
      uniquePlayerMap.set(row.playerId, { ...row })
    } else {
      const combinedSamples = (existing.samples && row.samples) ? combineSampleStreams([existing.samples, row.samples]) : undefined
      const combinedMinutes = (existing.minuteSamples && row.minuteSamples) ? combineSampleStreams([existing.minuteSamples, row.minuteSamples]) : undefined
      const meanPoints = existing.meanPoints + row.meanPoints
      const variance = existing.standardDeviation ** 2 + row.standardDeviation ** 2
      const standardDeviation = Math.sqrt(variance)
      const summary = combinedSamples ? summarizeSampleDistribution(combinedSamples, combinedMinutes) : null
      uniquePlayerMap.set(row.playerId, {
        playerId: row.playerId,
        gameweekId: row.gameweekId,
        position: row.position,
        meanPoints,
        standardDeviation,
        p10Points: summary ? summary.p10 : existing.p10Points + row.p10Points,
        p50Points: summary ? summary.p50 : existing.p50Points + row.p50Points,
        p90Points: summary ? summary.p90 : existing.p90Points + row.p90Points,
        startProbability: 1 - (1 - existing.startProbability) * (1 - row.startProbability),
        noShowProbability: existing.noShowProbability * row.noShowProbability,
        samples: combinedSamples,
        minuteSamples: combinedMinutes,
      })
    }
  }
  const distinctRows = [...uniquePlayerMap.values()]

  const byPosition = (position: LineupPosition) => distinctRows.filter(row => row.position === position).sort((a, b) => b.meanPoints - a.meanPoints || a.playerId.localeCompare(b.playerId))
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
  const bench = distinctRows.filter(row => !starterIds.has(row.playerId)).sort((a, b) => b.meanPoints - a.meanPoints || a.playerId.localeCompare(b.playerId))
  const captainPair = selectCaptainPair(starters)
  const captain = captainPair?.captain || null, vice = captainPair?.vice || null

  const allStartersHaveSamples = starters.length > 0 && starters.every(row => row.samples && row.samples.length > 0)
  if (allStartersHaveSamples) {
    const sampleCount = starters[0].samples!.length
    const squadSamples = new Array<number>(sampleCount).fill(0)
    for (let i = 0; i < sampleCount; i++) {
      let starterSum = 0
      const missingStarters: StoredForecast[] = []
      for (const starter of starters) {
        const pts = starter.samples![i] ?? 0
        const mins = starter.minuteSamples ? (starter.minuteSamples[i] ?? 0) : (starter.samples![i] !== 0 || starter.noShowProbability === 0 ? 90 : 0)
        starterSum += pts
        if (mins <= 0) {
          missingStarters.push(starter)
        }
      }

      // Automatic substitutions maintaining formation rules (DEF >= 3, MID >= 2, FWD >= 1, GK = 1)
      let subPoints = 0
      const usedBenchIndices = new Set<number>()
      const activeFormation = starters.map(s => s.position)

      for (const missing of missingStarters) {
        if (missing.position === 'GK') {
          const gkIndex = bench.findIndex((b, idx) => b.position === 'GK' && !usedBenchIndices.has(idx))
          if (gkIndex !== -1) {
            const benchGK = bench[gkIndex]
            const benchMins = benchGK.minuteSamples ? (benchGK.minuteSamples[i] ?? 0) : (benchGK.samples?.[i] !== 0 || benchGK.noShowProbability === 0 ? 90 : 0)
            if (benchMins > 0) {
              usedBenchIndices.add(gkIndex)
              subPoints += benchGK.samples?.[i] ?? 0
            }
          }
        } else {
          for (let bIdx = 0; bIdx < bench.length; bIdx++) {
            const bPlayer = bench[bIdx]
            if (bPlayer.position === 'GK' || usedBenchIndices.has(bIdx)) continue
            const bMins = bPlayer.minuteSamples ? (bPlayer.minuteSamples[i] ?? 0) : (bPlayer.samples?.[i] !== 0 || bPlayer.noShowProbability === 0 ? 90 : 0)
            if (bMins <= 0) continue

            // Test if replacing missing starter with bPlayer leaves a legal formation
            const missingIdx = activeFormation.indexOf(missing.position)
            if (missingIdx !== -1) {
              const testFormation = [...activeFormation]
              testFormation.splice(missingIdx, 1, bPlayer.position)
              const defCount = testFormation.filter(p => p === 'DEF').length
              const midCount = testFormation.filter(p => p === 'MID').length
              const fwdCount = testFormation.filter(p => p === 'FWD').length
              if (defCount >= 3 && midCount >= 2 && fwdCount >= 1) {
                activeFormation.splice(missingIdx, 1, bPlayer.position)
                usedBenchIndices.add(bIdx)
                subPoints += bPlayer.samples?.[i] ?? 0
                break
              }
            }
          }
        }
      }

      // Captaincy doubled contribution with vice-captain fallback
      const captainMins = captain?.minuteSamples ? (captain.minuteSamples[i] ?? 0) : (captain?.samples?.[i] !== 0 || captain?.noShowProbability === 0 ? 90 : 0)
      const captainPts = captain?.samples?.[i] ?? 0
      let captainBonus = 0
      if (captainMins > 0) {
        captainBonus = captainPts
      } else {
        const viceMins = vice?.minuteSamples ? (vice.minuteSamples[i] ?? 0) : (vice?.samples?.[i] !== 0 || vice?.noShowProbability === 0 ? 90 : 0)
        const vicePts = vice?.samples?.[i] ?? 0
        if (viceMins > 0) {
          captainBonus = vicePts
        }
      }

      squadSamples[i] = starterSum + subPoints + captainBonus
    }
    const summary = summarizeSampleDistribution(squadSamples)
    return {
      starters: starters.map(row => row.playerId), bench: bench.map(row => row.playerId), captainId: captain?.playerId || null, viceCaptainId: vice?.playerId || null,
      expectedPoints: summary.mean,
      standardDeviation: summary.standardDeviation,
      p10Points: summary.p10,
      p50Points: summary.p50,
      p90Points: summary.p90,
      samples: squadSamples,
    }
  }

  // Expected automatic substitutions are represented conservatively: the first
  // legal bench option covers a starter's no-show probability.
  const cover = starters.reduce((total, starter) => total + starter.noShowProbability * (bench[0]?.meanPoints || 0) / Math.max(1, starters.length), 0)
  const captainBonus = captainPair?.bonus || 0
  const expectedPoints = sum(starters, 'meanPoints') + captainBonus + cover
  const standardDeviation = Math.sqrt(starters.reduce((total, row) => total + row.standardDeviation ** 2, 0))
  const p10Points = sum(starters, 'p10Points')
  const p50Points = sum(starters, 'p50Points')
  const p90Points = sum(starters, 'p90Points')
  return {
    starters: starters.map(row => row.playerId), bench: bench.map(row => row.playerId), captainId: captain?.playerId || null, viceCaptainId: vice?.playerId || null,
    expectedPoints, standardDeviation, p10Points, p50Points, p90Points,
  }
}
