import { describe, expect, it } from 'vitest'
import { evaluateChipCounterfactual, type ChipPlayer } from './chips.ts'
import type { StoredForecast } from './lineup.ts'

const positions = ['GK', 'GK', 'DEF', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'MID', 'MID', 'FWD', 'FWD', 'FWD'] as const
const squad: ChipPlayer[] = positions.map((position, index) => ({ id: `p${index}`, club: `c${index}`, position, active: true, purchasePriceTenths: 50, sellingPriceTenths: 50 }))
const forecasts = (gameweekId: string, bonus = 0): StoredForecast[] => squad.map((player, index) => ({ playerId: String(player.id), gameweekId, position: player.position, meanPoints: 3 + index / 10 + bonus, standardDeviation: 1, p10Points: 1, p50Points: 3, p90Points: 6, startProbability: .9, noShowProbability: .05 }))

describe('chip counterfactuals', () => {
  it('triple captain is exactly one additional captain distribution against the no-chip baseline', () => {
    const result = evaluateChipCounterfactual({ chip: 'TC', baselineSquad: squad, candidatePool: squad, forecasts: forecasts('gw1'), bankBeforeTenths: 0, targetGameweekId: 'gw1', horizonGameweekIds: ['gw1'] })
    expect(result.available).toBe(true)
    const captain = forecasts('gw1').find(row => row.playerId === result.captainId)!
    expect(result.gain).toBe(captain.meanPoints)
    expect(result.p10Gain).toBe(captain.p10Points)
  })

  it('bench boost adds only the selected baseline bench distribution', () => {
    const result = evaluateChipCounterfactual({ chip: 'BB', baselineSquad: squad, candidatePool: squad, forecasts: forecasts('gw1'), bankBeforeTenths: 0, targetGameweekId: 'gw1', horizonGameweekIds: ['gw1'] })
    expect(result.available).toBe(true)
    expect(result.gain).toBeCloseTo(result.expectedPoints! - result.baseline.expectedPoints)
  })

  it('does not fabricate FH or WC estimates without a successful legal optimisation', () => {
    const result = evaluateChipCounterfactual({ chip: 'FH', baselineSquad: squad, candidatePool: squad, forecasts: forecasts('gw1'), bankBeforeTenths: null, targetGameweekId: 'gw1', horizonGameweekIds: ['gw1'] })
    expect(result).toMatchObject({ available: false, reason: 'Exact squad economics are required' })
  })

  it('keeps the no-chip baseline unchanged outside Free Hit target week', () => {
    const result = evaluateChipCounterfactual({ chip: 'FH', baselineSquad: squad, candidatePool: squad, forecasts: [...forecasts('gw1'), ...forecasts('gw2', 2)], bankBeforeTenths: 0, targetGameweekId: 'gw1', horizonGameweekIds: ['gw1', 'gw2'] })
    expect(result.available).toBe(true)
    expect(result.baseline.expectedPoints).toBeGreaterThan(0)
  })

  it('optimises a realistic full catalogue without abandoning the chip calculation', () => {
    const positionCounts = { GK: 35, DEF: 120, MID: 150, FWD: 90 } as const
    const candidates: ChipPlayer[] = [...squad]
    const candidateForecasts: StoredForecast[] = [...forecasts('gw1')]
    for (const [position, count] of Object.entries(positionCounts) as Array<[ChipPlayer['position'], number]>) {
      for (let index = 0; index < count; index += 1) {
        const id = `${position.toLowerCase()}-${index}`
        candidates.push({ id, club: `club-${index % 20}`, position, active: true, purchasePriceTenths: 50, sellingPriceTenths: 50 })
        candidateForecasts.push({ playerId: id, gameweekId: 'gw1', position, meanPoints: 5 + (index % 10) / 10, standardDeviation: 1, p10Points: 2, p50Points: 5, p90Points: 8, startProbability: .9, noShowProbability: .05 })
      }
    }
    const result = evaluateChipCounterfactual({ chip: 'FH', baselineSquad: squad, candidatePool: candidates, forecasts: candidateForecasts, bankBeforeTenths: 0, targetGameweekId: 'gw1', horizonGameweekIds: ['gw1'] })
    expect(result.available).toBe(true)
    expect(result.squadIds).toHaveLength(15)
    expect(result.gain).toBeGreaterThan(0)
  })

  it('computes exact empirical quantile gains when sample streams are provided', () => {
    const sampleCount = 200
    const sampleForecasts: StoredForecast[] = squad.map((player, index) => {
      const basePoints = 2 + index * 0.2
      const samples = Array.from({ length: sampleCount }, (_, i) => Math.max(0, basePoints + (i % 5) - 2))
      return {
        playerId: String(player.id),
        gameweekId: 'gw1',
        position: player.position,
        meanPoints: basePoints,
        standardDeviation: 1.4,
        p10Points: basePoints - 2,
        p50Points: basePoints,
        p90Points: basePoints + 2,
        startProbability: 1,
        noShowProbability: 0,
        samples,
      }
    })

    const tcResult = evaluateChipCounterfactual({ chip: 'TC', baselineSquad: squad, candidatePool: squad, forecasts: sampleForecasts, bankBeforeTenths: 0, targetGameweekId: 'gw1', horizonGameweekIds: ['gw1'] })
    expect(tcResult.available).toBe(true)
    expect(tcResult.p90Gain).toBeDefined()
    expect(tcResult.p90Gain).toBeGreaterThan(tcResult.p10Gain!)

    const bbResult = evaluateChipCounterfactual({ chip: 'BB', baselineSquad: squad, candidatePool: squad, forecasts: sampleForecasts, bankBeforeTenths: 0, targetGameweekId: 'gw1', horizonGameweekIds: ['gw1'] })
    expect(bbResult.available).toBe(true)
    expect(bbResult.p90Gain).toBeDefined()
    expect(bbResult.p90Gain).toBeGreaterThan(bbResult.p10Gain!)
  })

  it('triple captain falls back to vice-captain when captain records zero minutes', () => {
    // p14 remains the selected captain on adjusted projection, but misses draw 0.
    const sampleForecasts: StoredForecast[] = squad.map((player, index) => {
      const isCaptain = index === 14 // FWD
      const isVice = index === 13 // FWD
      const meanPoints = isCaptain ? 10 : isVice ? 8 : 4
      const samples = isCaptain ? [0, 10, 10, 10] : isVice ? [8, 8, 8, 8] : [3, 3, 3, 3]
      const minuteSamples = isCaptain ? [0, 90, 90, 90] : [90, 90, 90, 90]
      return {
        playerId: String(player.id),
        gameweekId: 'gw1',
        position: player.position,
        meanPoints,
        standardDeviation: 1,
        p10Points: 1,
        p50Points: 3,
        p90Points: 5,
        startProbability: isCaptain ? 0.9 : 1,
        noShowProbability: isCaptain ? 0.1 : 0,
        samples,
        minuteSamples,
      }
    })

    const result = evaluateChipCounterfactual({ chip: 'TC', baselineSquad: squad, candidatePool: squad, forecasts: sampleForecasts, bankBeforeTenths: 0, targetGameweekId: 'gw1', horizonGameweekIds: ['gw1'] })
    expect(result.available).toBe(true)
    expect(result.captainId).toBe('p14')
    expect(result.baseline.viceCaptainId).toBe('p13')
    // TC gain stream is [vice 8, captain 10, captain 10, captain 10].
    expect(result.gain).toBe(9.5)
    expect(result.p10Gain).toBe(8)
    expect(result.p90Gain).toBe(10)
  })

  it('bench boost does not double-count bench points already substituted for missing starters', () => {
    // Starter p2 (DEF) is missing (0 minutes, 0 pts). Bench DEF p6 has 90 minutes and 6 pts.
    // In baseline, p6 is auto-substituted in for p2 (contributing 6 pts to baseline).
    // In Bench Boost, all 15 score. BB gain should ONLY be the remaining bench players, not counting p6 twice.
    const sampleForecasts: StoredForecast[] = squad.map((player, index) => {
      if (index === 2) {
        // High projection keeps this defender in the selected XI, but it misses this draw.
        return {
          playerId: String(player.id), gameweekId: 'gw1', position: player.position,
          meanPoints: 10, standardDeviation: 2, p10Points: 0, p50Points: 10, p90Points: 12,
          startProbability: 0.9, noShowProbability: 0.1, samples: [0], minuteSamples: [0],
        }
      }
      if (index === 6) {
        // Bench DEF who gets auto-subbed in baseline
        return {
          playerId: String(player.id), gameweekId: 'gw1', position: player.position,
          meanPoints: 1, standardDeviation: 1, p10Points: 0, p50Points: 1, p90Points: 3,
          startProbability: 1, noShowProbability: 0, samples: [6], minuteSamples: [90],
        }
      }
      if (index === 3 || index === 4) {
        return {
          playerId: String(player.id), gameweekId: 'gw1', position: player.position,
          meanPoints: 9, standardDeviation: 1, p10Points: 7, p50Points: 9, p90Points: 11,
          startProbability: 1, noShowProbability: 0, samples: [2], minuteSamples: [90],
        }
      }
      if (index === 5) {
        // Lower bench priority than p6, but still scores under Bench Boost.
        return {
          playerId: String(player.id), gameweekId: 'gw1', position: player.position,
          meanPoints: 0, standardDeviation: 1, p10Points: 0, p50Points: 0, p90Points: 2,
          startProbability: 1, noShowProbability: 0, samples: [2], minuteSamples: [90],
        }
      }
      // Other players score 2 pts
      return {
        playerId: String(player.id), gameweekId: 'gw1', position: player.position,
        meanPoints: 2, standardDeviation: 0.5, p10Points: 1, p50Points: 2, p90Points: 3,
        startProbability: 1, noShowProbability: 0, samples: [2], minuteSamples: [90],
      }
    })

    const result = evaluateChipCounterfactual({ chip: 'BB', baselineSquad: squad, candidatePool: squad, forecasts: sampleForecasts, bankBeforeTenths: 0, targetGameweekId: 'gw1', horizonGameweekIds: ['gw1'] })
    expect(result.available).toBe(true)
    expect(result.baseline.starters).toContain('p2')
    expect(result.baseline.bench).toContain('p6')
    // All 15 points = 10 starters (excluding p2) + captain bonus + p2 (0) + 4 bench (including p6)
    // Baseline = 10 starters + captain bonus + p6 (auto-subbed in for p2)
    // Therefore BB gain = all15 - baseline = 3 remaining bench players * 2 pts = 6 pts (NOT 6 + 6 = 12)
    expect(result.gain).toBe(6)
  })
})
