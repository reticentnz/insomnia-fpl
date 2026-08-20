import type { Position } from '../domain.ts'
import { scorePlayerMatch } from './scoring.ts'

export const SIMULATION_COUNT = 2_000
export const SIMULATION_SEED_VERSION = 'mulberry32-v1'
export const SIMULATION_ENGINE_VERSION = 'fixture-outcomes-v2'
export const LEGACY_SIMULATION_ENGINE_VERSION = 'fixture-outcomes-v1'

export type RoleState = {
  startProbability: number
  substituteProbability: number
  noShowProbability: number
  minutesIfStarting: number
  minutesIfSubstitute: number
  /** Half-width of a triangular minutes distribution around the role-state mean. */
  startingMinutesSpread?: number
  substituteMinutesSpread?: number
}

/** All rates are per 90 minutes after fixture-strength adjustment. */
export type FixtureSimulationInput = {
  engineVersion?: typeof SIMULATION_ENGINE_VERSION | typeof LEGACY_SIMULATION_ENGINE_VERSION
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
  minuteSamples?: readonly number[]
  expectedGoals: number
  expectedAssists: number
  goalProbability: number
  assistProbability: number
  cleanSheetProbability: number
  bonusProbability: number
  defensiveContributionProbability: number
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

export function summarizeSampleDistribution(samples: readonly number[], minuteSamples?: readonly number[]): OutcomeSummary {
  if (!samples.length) {
    return { mean: 0, standardDeviation: 0, p10: 0, p50: 0, p90: 0, samples: [], minuteSamples: minuteSamples || [], expectedGoals: 0, expectedAssists: 0, goalProbability: 0, assistProbability: 0, cleanSheetProbability: 0, bonusProbability: 0, defensiveContributionProbability: 0 }
  }
  const sampleCount = samples.length
  const mean = samples.reduce((total, value) => total + value, 0) / sampleCount
  const variance = samples.reduce((total, value) => total + (value - mean) ** 2, 0) / sampleCount
  const standardDeviation = Math.sqrt(variance)
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    mean,
    standardDeviation,
    p10: quantile(sorted, .1),
    p50: quantile(sorted, .5),
    p90: quantile(sorted, .9),
    samples,
    minuteSamples,
    expectedGoals: 0,
    expectedAssists: 0,
    goalProbability: 0,
    assistProbability: 0,
    cleanSheetProbability: 0,
    bonusProbability: 0,
    defensiveContributionProbability: 0,
  }
}

export function combineSampleStreams(streams: readonly (readonly number[])[]): number[] {
  if (!streams.length) return []
  const count = streams[0]?.length || 0
  if (count === 0) throw new Error('Cannot combine empty sample streams')
  for (let i = 0; i < streams.length; i++) {
    if (streams[i].length !== count) {
      throw new Error(`Cannot combine sample streams of mismatched lengths: expected ${count}, got ${streams[i].length} at index ${i}`)
    }
  }
  const combined = new Array<number>(count).fill(0)
  for (const stream of streams) {
    for (let i = 0; i < count; i++) {
      combined[i] += stream[i] ?? 0
    }
  }
  return combined
}

export function deriveQuantileGain(counterfactualSamples: readonly number[], baselineSamples: readonly number[]) {
  if (!counterfactualSamples.length || !baselineSamples.length) {
    throw new Error('Cannot derive quantile gain from empty sample streams')
  }
  if (counterfactualSamples.length !== baselineSamples.length) {
    throw new Error(`Cannot derive quantile gain from mismatched sample stream lengths: ${counterfactualSamples.length} vs ${baselineSamples.length}`)
  }
  const count = counterfactualSamples.length
  const diffs = new Array<number>(count)
  for (let i = 0; i < count; i++) {
    diffs[i] = (counterfactualSamples[i] ?? 0) - (baselineSamples[i] ?? 0)
  }
  const summary = summarizeSampleDistribution(diffs)
  return {
    gain: summary.mean,
    p10Gain: summary.p10,
    p50Gain: summary.p50,
    p90Gain: summary.p90,
  }
}

export function simulateFixtureOutcomes(input: FixtureSimulationInput): OutcomeSummary {
  const random = seededRandom(input.seed), samples: number[] = [], minuteSamples: number[] = []
  let totalGoals = 0, totalAssists = 0, scored = 0, assisted = 0, cleanSheets = 0, bonuses = 0, defensiveContributions = 0
  const sampleCount = input.samples ?? SIMULATION_COUNT
  const roleTotal = input.role.startProbability + input.role.substituteProbability + input.role.noShowProbability
  if (Math.abs(roleTotal - 1) > 1e-6) throw new Error('Fixture role probabilities must sum to one')
  for (let index = 0; index < sampleCount; index++) {
    const state = random()
    const started = state < input.role.startProbability
    const substituted = !started && state < input.role.startProbability + input.role.substituteProbability
    const meanMinutes = started ? input.role.minutesIfStarting : substituted ? input.role.minutesIfSubstitute : 0
    const spread = started ? input.role.startingMinutesSpread : input.role.substituteMinutesSpread
    // Two uniforms produce a centred triangular distribution. Legacy ledgers and
    // callers without a spread retain their exact fixed-minute behaviour.
    const minutes = meanMinutes <= 0
      ? 0
      : !spread
        ? meanMinutes
        : Math.round(Math.min(90, Math.max(1, meanMinutes + spread * (random() + random() - 1))))
    minuteSamples.push(minutes)
    if (minutes <= 0) { samples.push(0); continue }
    const share = minutes / 90
    const defensiveThreshold = input.position === 'DEF' ? 10 : 12
    const goalsConceded = poisson(random, nonNegative(input.teamGoalsConcededRate) * share)
    const goals = poisson(random, nonNegative(input.goalRate) * share)
    const assists = poisson(random, nonNegative(input.assistRate) * share)
    const saves = poisson(random, nonNegative(input.saveRate) * share)
    const penaltiesSaved = poisson(random, nonNegative(input.penaltySaveRate) * share)
    const penaltiesMissed = poisson(random, nonNegative(input.penaltyMissRate) * share)
    const ownGoals = poisson(random, nonNegative(input.ownGoalRate) * share)
    const yellowCards = poisson(random, nonNegative(input.yellowCardRate) * share)
    const redCards = poisson(random, nonNegative(input.redCardRate) * share)
    const defensiveActions = poisson(random, nonNegative(input.defensiveActionRate) * share)
    const bonus = Math.min(3, poisson(random, nonNegative(input.bonusRate) * share))
    totalGoals += goals; totalAssists += assists
    if (goals > 0) scored++
    if (assists > 0) assisted++
    if (goalsConceded === 0 && minutes >= 60) cleanSheets++
    if (bonus > 0) bonuses++
    if (input.position !== 'GK' && defensiveActions >= defensiveThreshold) defensiveContributions++
    samples.push(scorePlayerMatch({
      position: input.position, minutes,
      goals,
      assists,
      cleanSheet: goalsConceded === 0,
      goalsConceded,
      saves,
      penaltiesSaved,
      penaltiesMissed,
      ownGoals,
      yellowCards,
      redCards,
      clearancesBlocksInterceptions: defensiveActions,
      bonus,
    }).total)
  }
  return {
    ...summarizeSampleDistribution(samples, minuteSamples),
    expectedGoals: totalGoals / sampleCount,
    expectedAssists: totalAssists / sampleCount,
    goalProbability: scored / sampleCount,
    assistProbability: assisted / sampleCount,
    cleanSheetProbability: cleanSheets / sampleCount,
    bonusProbability: bonuses / sampleCount,
    defensiveContributionProbability: defensiveContributions / sampleCount,
  }
}

export function simulateFromStoredForecast(row: {
  role_source_json?: string | unknown
  roleSource?: unknown
  seed?: string
  position?: Position
  startProbability?: number
  substituteProbability?: number
  noShowProbability?: number
  [key: string]: any
}): OutcomeSummary | null {
  let simulationInput: FixtureSimulationInput | undefined
  try {
    const raw = typeof row.role_source_json === 'string'
      ? JSON.parse(row.role_source_json)
      : (row.role_source_json || row.roleSource)
    if (raw?.simulationInput) {
      simulationInput = raw.simulationInput
    }
  } catch {}

  if (!simulationInput) return null
  if (simulationInput.engineVersion !== SIMULATION_ENGINE_VERSION && simulationInput.engineVersion !== LEGACY_SIMULATION_ENGINE_VERSION) return null
  if (!Number.isInteger(simulationInput.samples) || Number(simulationInput.samples) <= 0) return null
  return simulateFixtureOutcomes(simulationInput)
}

/** Common random numbers: comparable plans share the same seeded sample stream. */
export function pairedSimulationSeed(comparisonId: string, sampleContext: string) {
  return `${comparisonId}:${sampleContext}:${SIMULATION_SEED_VERSION}`
}
