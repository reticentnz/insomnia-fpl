import { describe, expect, it } from 'vitest'
import { pairedSimulationSeed, simulateFixtureOutcomes } from './uncertainty.ts'

const input = {
  seed: 'run-a:player-a:fixture-a:role-aware-v2.0', position: 'MID' as const,
  role: { startProbability: .7, substituteProbability: .06, noShowProbability: .24, minutesIfStarting: 86, minutesIfSubstitute: 18 },
  goalRate: .25, assistRate: .18, teamGoalsConcededRate: 1.2, saveRate: 0, yellowCardRate: .12, redCardRate: .005,
  penaltySaveRate: 0, penaltyMissRate: .01, ownGoalRate: .002, defensiveActionRate: 8, bonusRate: .4,
}

describe('seeded outcome simulation', () => {
  it('is byte-identical for the same seed and inputs', () => {
    expect(simulateFixtureOutcomes(input)).toEqual(simulateFixtureOutcomes(input))
  })

  it('returns ordered outcome quantiles', () => {
    const outcome = simulateFixtureOutcomes(input)
    expect(outcome.p10).toBeLessThanOrEqual(outcome.p50)
    expect(outcome.p50).toBeLessThanOrEqual(outcome.p90)
    expect(outcome.standardDeviation).toBeGreaterThan(0)
  })

  it('has no points when appearances are impossible', () => {
    const outcome = simulateFixtureOutcomes({ ...input, role: { ...input.role, startProbability: 0, substituteProbability: 0, noShowProbability: 1 } })
    expect(outcome).toMatchObject({ mean: 0, standardDeviation: 0, p10: 0, p50: 0, p90: 0 })
  })

  it('uses a common stream identity for paired comparisons', () => {
    expect(pairedSimulationSeed('comparison-1', 'sample-3')).toBe(pairedSimulationSeed('comparison-1', 'sample-3'))
  })
})
