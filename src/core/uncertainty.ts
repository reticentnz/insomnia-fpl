import type { Position } from '../domain.ts'
import { scorePlayerMatch } from './scoring.ts'

export const SIMULATION_COUNT = 2_000
export const SIMULATION_SEED_VERSION = 'mulberry32-v1'

export type RoleState = {
  startProbability: number
  substituteProbability: number
  noShowProbability: number
  minutesIfStarting: number
  minutesIfSubstitute: number
}

/** All rates are per 90 minutes after fixture-strength adjustment. */
export type FixtureSimulationInput = {
  seed: string
  position: Position
  role: RoleState
  goalRate: number
  assistRate: number
  teamGoalsConcededRate: number
  saveRate: number
  yellowCardRate: number
  redCardRate: number
  penaltySaveRate: number
  penaltyMissRate: number
  ownGoalRate: number
  defensiveActionRate: number
  bonusRate: number
  samples?: number
}

export type OutcomeSummary = {
  mean: number
  standardDeviation: number
  p10: number
  p50: number
  p90: number
  samples: readonly number[]
}

/** Stable string hash followed by a small deterministic PRNG; no ambient randomness. */
export function seededRandom(seed: string): () => number {
  let state = 2166136261
  for (let index = 0; index < seed.length; index++) {
    state ^= seed.charCodeAt(index)
    state = Math.imul(state, 16777619)
  }
  return () => {
    state |= 0
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ state >>> 15, 1 | state)
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

export function poisson(random: () => number, lambda: number): number {
  if (!(lambda > 0)) return 0
  // Knuth is exact and adequate for the small football-event rates here.
  const threshold = Math.exp(-lambda)
  let product = 1, draws = 0
  do { draws++; product *= random() } while (product > threshold)
  return draws - 1
}

const nonNegative = (value: number) => Math.max(0, Number.isFinite(value) ? value : 0)
const quantile = (sorted: readonly number[], percentile: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1))] || 0

export function simulateFixtureOutcomes(input: FixtureSimulationInput): OutcomeSummary {
  const random = seededRandom(input.seed), samples: number[] = []
  const sampleCount = input.samples ?? SIMULATION_COUNT
  const roleTotal = input.role.startProbability + input.role.substituteProbability + input.role.noShowProbability
  if (Math.abs(roleTotal - 1) > 1e-6) throw new Error('Fixture role probabilities must sum to one')
  for (let index = 0; index < sampleCount; index++) {
    const state = random()
    const minutes = state < input.role.startProbability ? input.role.minutesIfStarting : state < input.role.startProbability + input.role.substituteProbability ? input.role.minutesIfSubstitute : 0
    if (minutes <= 0) { samples.push(0); continue }
    const share = minutes / 90
    const defensiveThreshold = input.position === 'DEF' ? 10 : 12
    const goalsConceded = poisson(random, nonNegative(input.teamGoalsConcededRate) * share)
    samples.push(scorePlayerMatch({
      position: input.position, minutes,
      goals: poisson(random, nonNegative(input.goalRate) * share),
      assists: poisson(random, nonNegative(input.assistRate) * share),
      cleanSheet: goalsConceded === 0,
      goalsConceded,
      saves: poisson(random, nonNegative(input.saveRate) * share),
      penaltiesSaved: poisson(random, nonNegative(input.penaltySaveRate) * share),
      penaltiesMissed: poisson(random, nonNegative(input.penaltyMissRate) * share),
      ownGoals: poisson(random, nonNegative(input.ownGoalRate) * share),
      yellowCards: poisson(random, nonNegative(input.yellowCardRate) * share),
      redCards: poisson(random, nonNegative(input.redCardRate) * share),
      clearancesBlocksInterceptions: poisson(random, nonNegative(input.defensiveActionRate) * share),
      bonus: Math.min(3, poisson(random, nonNegative(input.bonusRate) * share)),
    }).total)
  }
  const mean = samples.reduce((total, value) => total + value, 0) / sampleCount
  const standardDeviation = Math.sqrt(samples.reduce((total, value) => total + (value - mean) ** 2, 0) / sampleCount)
  const sorted = [...samples].sort((left, right) => left - right)
  return { mean, standardDeviation, p10: quantile(sorted, .1), p50: quantile(sorted, .5), p90: quantile(sorted, .9), samples }
}

/** Common random numbers: comparable plans share the same seeded sample stream. */
export function pairedSimulationSeed(comparisonId: string, sampleContext: string) {
  return `${comparisonId}:${sampleContext}:${SIMULATION_SEED_VERSION}`
}
