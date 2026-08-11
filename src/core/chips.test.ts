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
})
