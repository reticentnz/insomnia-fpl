import { describe, expect, it } from 'vitest'
import { combineSampleStreams, deriveQuantileGain, pairedSimulationSeed, SIMULATION_ENGINE_VERSION, simulateFixtureOutcomes, simulateFromStoredForecast, summarizeSampleDistribution } from './uncertainty.ts'

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
    expect(outcome.expectedGoals).toBeGreaterThan(0)
    expect(outcome.expectedAssists).toBeGreaterThan(0)
    expect(outcome.goalProbability).toBeGreaterThan(0)
    expect(outcome.assistProbability).toBeGreaterThan(0)
    expect(outcome.cleanSheetProbability).toBeGreaterThan(0)
  })

  it('samples a bounded minutes distribution within each appearance state', () => {
    const outcome = simulateFixtureOutcomes({
      ...input,
      samples: 500,
      role: { startProbability: 1, substituteProbability: 0, noShowProbability: 0, minutesIfStarting: 82, minutesIfSubstitute: 18, startingMinutesSpread: 8 },
    })
    expect(new Set(outcome.minuteSamples!).size).toBeGreaterThan(5)
    expect(Math.min(...outcome.minuteSamples!)).toBeGreaterThanOrEqual(74)
    expect(Math.max(...outcome.minuteSamples!)).toBeLessThanOrEqual(90)
  })

  it('has no points when appearances are impossible', () => {
    const outcome = simulateFixtureOutcomes({ ...input, role: { ...input.role, startProbability: 0, substituteProbability: 0, noShowProbability: 1 } })
    expect(outcome).toMatchObject({ mean: 0, standardDeviation: 0, p10: 0, p50: 0, p90: 0 })
  })

  it('uses a common stream identity for paired comparisons', () => {
    expect(pairedSimulationSeed('comparison-1', 'sample-3')).toBe(pairedSimulationSeed('comparison-1', 'sample-3'))
  })

  it('does not manufacture empirical samples for legacy or unsupported stored inputs', () => {
    expect(simulateFromStoredForecast({ role_source_json: '{}' })).toBeNull()
    expect(simulateFromStoredForecast({ roleSource: { simulationInput: { ...input, samples: 20, engineVersion: 'future-v2' } } })).toBeNull()
    expect(simulateFromStoredForecast({ roleSource: { simulationInput: { ...input, samples: 20, engineVersion: SIMULATION_ENGINE_VERSION } } })?.samples).toHaveLength(20)
  })

  it('aggregates independent fixture sample streams without assuming comonotonicity', () => {
    const fixture1 = simulateFixtureOutcomes({ ...input, seed: 'f1:player-1' })
    const fixture2 = simulateFixtureOutcomes({ ...input, seed: 'f2:player-1' })
    const dgwSamples = combineSampleStreams([fixture1.samples, fixture2.samples])
    const dgwSummary = summarizeSampleDistribution(dgwSamples)

    expect(dgwSummary.mean).toBeCloseTo(fixture1.mean + fixture2.mean, 2)
    // For non-comonotonic independent events, p90(X + Y) < p90(X) + p90(Y)
    expect(dgwSummary.p90).toBeLessThan(fixture1.p90 + fixture2.p90)
    expect(dgwSummary.p10).toBeGreaterThanOrEqual(0)
  })

  it('computes exact quantile gains between counterfactual sample streams', () => {
    const baseline = simulateFixtureOutcomes({ ...input, seed: 'base:player-1' })
    const counterfactual = simulateFixtureOutcomes({ ...input, goalRate: 0.6, seed: 'cf:player-1' })
    const gain = deriveQuantileGain(counterfactual.samples, baseline.samples)
    expect(gain.gain).toBeCloseTo(counterfactual.mean - baseline.mean, 2)
    expect(gain.p90Gain).toBeGreaterThan(gain.p10Gain)
  })
})
