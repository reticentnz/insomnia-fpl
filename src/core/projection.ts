import type { FixtureItem, Player, Position } from '../domain.ts'
import { expectedRoleMinutes, normalizeRoleProfile, type PlayerRoleProfile } from '../player-signals.ts'
import { scoringRules } from './scoring.ts'

/** The calculation version recorded with every projection output. */
export const MODEL_VERSION = 'role-aware-v2.0'

/** Shared fixture-level role maths. The three states are exhaustive and mutually exclusive. */
export type FixtureRoleProfile = {
  startProbability: number
  substituteProbabilityWhenBenched: number
  minutesIfStarting: number
  minutesIfSubstitute: number
}

export type StrengthMethod = 'MARKET_XG' | 'OFFICIAL_STRENGTH' | 'FDR_FALLBACK'

export function selectStrengthMethod(input: {
  market?: { homeExpectedGoals: number | null; awayExpectedGoals: number | null } | null
  official?: { attack: number | null; defence: number | null } | null
}): StrengthMethod {
  if (input.market?.homeExpectedGoals != null && input.market.awayExpectedGoals != null) return 'MARKET_XG'
  if (input.official?.attack != null && input.official.defence != null) return 'OFFICIAL_STRENGTH'
  return 'FDR_FALLBACK'
}

const clampProbability = (value: number) => Math.max(0, Math.min(1, value))

export function fixtureRoleStates(role: FixtureRoleProfile) {
  const startProbability = clampProbability(role.startProbability)
  const substituteProbability = clampProbability((1 - startProbability) * role.substituteProbabilityWhenBenched)
  const noShowProbability = 1 - startProbability - substituteProbability
  return { startProbability, substituteProbability, noShowProbability }
}

export function fixtureExpectedMinutes(role: FixtureRoleProfile) {
  const states = fixtureRoleStates(role)
  return states.startProbability * role.minutesIfStarting + states.substituteProbability * role.minutesIfSubstitute
}

export type Projection = {
  playerId: number; gameweek: number; modelVersion: string; expectedMinutes: number
  expectedGoals: number; expectedAssists: number; cleanSheetProbability: number
  expectedBonus: number; expectedCardDeduction: number; expectedPoints: number
}

export type ProjectionBreakdown = {
  playerId: number; playerName: string; modelVersion: string; horizon: number
  baseline: number; fixtureAdjustment: number; expectedMinutesAdjustment: number
  appearance: number; attackingContribution: number; cleanSheetContribution: number
  goalsConcededDeduction: number; savePoints: number; penaltyPoints: number
  defensiveContribution: number; bonus: number; cardDeduction: number
  finalExpectedPoints: number; expectedMinutes: number
  minutesConfidence: 'LOW' | 'MEDIUM' | 'HIGH'; warning?: string
}

/** All fixture-level component means, prior to gameweek aggregation. */
export type FixtureProjection = {
  expectedMinutes: number; appearance: number; goals: number; assists: number; cleanSheet: number
  cleanSheetProbability: number; goalsConceded: number; saves: number; penalties: number
  defensiveContribution: number; bonus: number; cards: number; total: number
  roleProbabilities: ReturnType<typeof fixtureRoleStates>; strengthMethod: StrengthMethod
}

export type FixtureRateModel = {
  goalRate: number; assistRate: number; xgcRate: number; saveRate: number; bonusRate: number; cardRate: number; defensiveRate: number
  penaltySaveRate: number; penaltyMissRate: number; ownGoalRate: number
}

const positionPriors: Record<Position, { goals: number; assists: number; xgc: number; saves: number; bonus: number; cards: number; defensiveActions: number }> = {
  GK: { goals: .002, assists: .008, xgc: 1.35, saves: 3.2, bonus: .28, cards: .04, defensiveActions: 0 },
  DEF: { goals: .055, assists: .095, xgc: 1.35, saves: 0, bonus: .34, cards: .16, defensiveActions: 8.2 },
  MID: { goals: .205, assists: .185, xgc: 1.35, saves: 0, bonus: .42, cards: .15, defensiveActions: 7.6 },
  FWD: { goals: .37, assists: .15, xgc: 1.35, saves: 0, bonus: .52, cards: .13, defensiveActions: 4.2 },
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const round = (value: number, digits = 3) => +value.toFixed(digits)
const per90 = (total: number | undefined, minutes: number) => minutes > 0 ? (total || 0) * 90 / minutes : 0
const shrunkRate = (observed: number, prior: number, minutes: number, priorMinutes = 540) => (observed * minutes + prior * priorMinutes) / (minutes + priorMinutes)

function poissonFloorExpectation(lambda: number, divisor: number) {
  if (lambda <= 0) return 0
  let probability = Math.exp(-lambda), expected = 0
  for (let n = 0; n < 40; n++) { if (n > 0) probability *= lambda / n; expected += Math.floor(n / divisor) * probability }
  return expected
}

function poissonAtLeast(lambda: number, threshold: number) {
  if (lambda <= 0) return 0
  let term = Math.exp(-lambda), cumulative = term
  for (let n = 1; n < threshold; n++) { term *= lambda / n; cumulative += term }
  return clamp(1 - cumulative, 0, 1)
}

export function playerRoleProfile(player: Player): PlayerRoleProfile {
  if (player.roleProfile) return normalizeRoleProfile(player.roleProfile)
  const targetMinutes = clamp(player.expectedMinutes ?? 90 * (player.minutes / 100), 0, 90)
  const goalkeeper = player.position === 'GK', minutesIfStarting = goalkeeper ? 90 : 86
  const substituteProbabilityWhenBenched = goalkeeper ? .005 : .2, minutesIfSubstitute = goalkeeper ? 5 : 18
  const cameoMinutes = substituteProbabilityWhenBenched * minutesIfSubstitute
  const startProbability = clamp((targetMinutes - cameoMinutes) / (minutesIfStarting - cameoMinutes), 0, 1)
  return normalizeRoleProfile({ startProbability, minutesIfStarting, substituteProbabilityWhenBenched, minutesIfSubstitute, confidence: player.dataConfidence || 'LOW', derivedFromSignalIds: [] })
}

function fixtureFactors(fixture: FixtureItem) {
  if (fixture.strength) return { attack: clamp(fixture.strength.attackMultiplier, .55, 1.45), defence: clamp(fixture.strength.defenceMultiplier, .55, 1.45), method: fixture.strength.method }
  const difficultyAttack: Record<number, number> = { 1: 1.30, 2: 1.15, 3: 1, 4: .84, 5: .70 }
  const attack = (difficultyAttack[fixture.difficulty] || 1) * (fixture.venue === 'H' ? 1.05 : .96)
  const defence = (2 - attack) * .92 + .08
  return { attack: clamp(attack, .55, 1.4), defence: clamp(defence, .65, 1.45), method: 'FDR_FALLBACK' as const }
}

function playerRates(player: Player) {
  const stats = player.stats, minutes = Math.max(0, stats?.minutes || 0), prior = positionPriors[player.position]
  const fallbackStrength = clamp(player.projection / (player.position === 'GK' || player.position === 'DEF' ? 4 : player.position === 'MID' ? 5.2 : 5.5), .65, 1.65)
  const observedGoals = stats?.expectedGoalsPer90 ?? (per90(stats?.expectedGoals, minutes) || per90(stats?.goals, minutes))
  const observedAssists = stats?.expectedAssistsPer90 ?? (per90(stats?.expectedAssists, minutes) || per90(stats?.assists, minutes))
  const goalRate = minutes > 0 ? shrunkRate(observedGoals, prior.goals, minutes) : prior.goals * fallbackStrength
  const assistRate = minutes > 0 ? shrunkRate(observedAssists, prior.assists, minutes) : prior.assists * fallbackStrength
  const xgcObserved = stats?.expectedGoalsConcededPer90 ?? per90(stats?.expectedGoalsConceded, minutes)
  const xgcRate = minutes > 0 ? shrunkRate(xgcObserved || prior.xgc, prior.xgc, minutes, 720) : prior.xgc
  const saveRate = minutes > 0 ? shrunkRate(stats?.savesPer90 ?? per90(stats?.saves, minutes), prior.saves, minutes) : prior.saves
  const bonusRate = minutes > 0 ? shrunkRate(per90(stats?.bonus, minutes), prior.bonus, minutes) : prior.bonus * fallbackStrength
  const cardRate = minutes > 0 ? shrunkRate(per90((stats?.yellowCards || 0) + 3 * (stats?.redCards || 0), minutes), prior.cards, minutes) : prior.cards
  const rawDefensive = (stats?.clearancesBlocksInterceptions || 0) + (stats?.tackles || 0) + (player.position === 'MID' || player.position === 'FWD' ? (stats?.recoveries || 0) : 0)
  const defensiveRate = minutes > 0 ? shrunkRate(per90(rawDefensive, minutes), prior.defensiveActions, minutes) : prior.defensiveActions
  return { goalRate, assistRate, xgcRate, saveRate, bonusRate, cardRate, defensiveRate, minutes }
}

/** Rates used by the seeded outcome simulator. This is deliberately derived from the same shrunk-rate model as expected value. */
export function fixtureRateModel(player: Player, fixture: FixtureItem): FixtureRateModel {
  const rates = playerRates(player), { attack, defence } = fixtureFactors(fixture), minutes = Math.max(1, rates.minutes)
  return {
    goalRate: rates.goalRate * attack, assistRate: rates.assistRate * attack, xgcRate: rates.xgcRate * defence,
    saveRate: rates.saveRate / Math.max(defence, .75), bonusRate: rates.bonusRate * attack, cardRate: rates.cardRate,
    defensiveRate: rates.defensiveRate,
    penaltySaveRate: per90(player.stats?.penaltiesSaved, minutes), penaltyMissRate: per90(player.stats?.penaltiesMissed, minutes), ownGoalRate: per90(player.stats?.ownGoals, minutes),
  }
}

function oneFixtureAtMinutes(player: Player, fixture: FixtureItem, mins: number): Omit<FixtureProjection, 'roleProbabilities' | 'strengthMethod'> {
  const rates = playerRates(player), minuteShare = mins / 90, playProbability = mins > 0 ? 1 : 0, sixtyProbability = mins >= 60 ? 1 : 0
  const { attack, defence } = fixtureFactors(fixture)
  const goals = rates.goalRate * minuteShare * attack * scoringRules.goal[player.position], assists = rates.assistRate * minuteShare * attack * scoringRules.assist
  const appearance = playProbability + sixtyProbability, cleanSheetProbability = Math.exp(-rates.xgcRate * defence)
  const cleanSheet = cleanSheetProbability * sixtyProbability * scoringRules.cleanSheet[player.position]
  const concededLambda = rates.xgcRate * defence * Math.max(0, mins - 60) / 30
  const goalsConceded = player.position === 'GK' || player.position === 'DEF' ? -poissonFloorExpectation(concededLambda, 2) * sixtyProbability : 0
  const saves = player.position === 'GK' ? poissonFloorExpectation(rates.saveRate * minuteShare / Math.max(defence, .75), 3) : 0
  const penalties = minuteShare * (per90(player.stats?.penaltiesSaved, rates.minutes) * scoringRules.penaltySave + per90(player.stats?.penaltiesMissed, rates.minutes) * scoringRules.penaltyMiss + per90(player.stats?.ownGoals, rates.minutes) * scoringRules.ownGoal)
  const defensiveContribution = player.position === 'GK' ? 0 : poissonAtLeast(rates.defensiveRate * minuteShare, player.position === 'DEF' ? 10 : 12) * scoringRules.defensiveContribution
  const bonus = clamp(rates.bonusRate * minuteShare * attack, 0, 3), cards = -rates.cardRate * minuteShare
  const total = (appearance + goals + assists + cleanSheet + goalsConceded + saves + penalties + defensiveContribution + bonus + cards) * (player.calibrationFactor ?? 1) * (player.coldStart ? .6 : player.dataConfidence === 'LOW' ? .9 : 1)
  return { expectedMinutes: mins, appearance, goals, assists, cleanSheet, cleanSheetProbability, goalsConceded, saves, penalties, defensiveContribution, bonus, cards, total }
}

/** Canonical fixture-level expected-value calculation for all forecast consumers. */
export function projectFixture(player: Player, fixture: FixtureItem): FixtureProjection {
  const role = playerRoleProfile(player), roleProbabilities = fixtureRoleStates(role)
  const start = oneFixtureAtMinutes(player, fixture, role.minutesIfStarting), substitute = oneFixtureAtMinutes(player, fixture, role.minutesIfSubstitute)
  const blend = (pick: (row: typeof start) => number) => roleProbabilities.startProbability * pick(start) + roleProbabilities.substituteProbability * pick(substitute)
  return {
    expectedMinutes: fixtureExpectedMinutes(role), appearance: blend(row => row.appearance), goals: blend(row => row.goals), assists: blend(row => row.assists), cleanSheet: blend(row => row.cleanSheet), cleanSheetProbability: start.cleanSheetProbability,
    goalsConceded: blend(row => row.goalsConceded), saves: blend(row => row.saves), penalties: blend(row => row.penalties), defensiveContribution: blend(row => row.defensiveContribution), bonus: blend(row => row.bonus), cards: blend(row => row.cards), total: blend(row => row.total), roleProbabilities, strengthMethod: fixtureFactors(fixture).method,
  }
}

function fallbackFixtures(player: Player, horizon: number): FixtureItem[] {
  if (player.upcomingFixtures) return player.upcomingFixtures.filter(f => f.gameweek >= 1).slice(0, horizon)
  const opponent = player.fixture.split(' ')[0] || 'OPP', venue = player.fixture.includes('(A)') ? 'A' : 'H'
  return Array.from({ length: horizon }, (_, index) => ({ gameweek: index + 1, opponent, venue, difficulty: player.difficulty }))
}

export function projectionBreakdown(player: Player, horizon: number): ProjectionBreakdown {
  const fixtures = fallbackFixtures(player, horizon), rows = fixtures.map(f => projectFixture(player, f)), sum = (pick: (row: FixtureProjection) => number) => rows.reduce((total, row) => total + pick(row), 0)
  const appearance = sum(r => r.appearance), goals = sum(r => r.goals), assists = sum(r => r.assists), cleanSheetContribution = sum(r => r.cleanSheet), goalsConcededDeduction = sum(r => r.goalsConceded), savePoints = sum(r => r.saves), penaltyPoints = sum(r => r.penalties), defensiveContribution = sum(r => r.defensiveContribution), bonus = sum(r => r.bonus), cardDeduction = sum(r => r.cards), finalExpectedPoints = sum(r => r.total)
  const neutral = fixtures.map(f => projectFixture(player, { ...f, difficulty: 3, venue: 'H' as const })).reduce((n, r) => n + r.total, 0)
  const fullMinutesNeutral = fixtures.map(f => projectFixture({ ...player, roleProfile: { startProbability: 1, minutesIfStarting: 90, substituteProbabilityWhenBenched: 0, minutesIfSubstitute: 0, confidence: 'HIGH', derivedFromSignalIds: [] } }, { ...f, difficulty: 3, venue: 'H' as const })).reduce((n, r) => n + r.total, 0)
  const role = playerRoleProfile(player), minutesConfidence = player.coldStart ? 'LOW' : role.confidence
  const warning = fixtures.length === 0 ? 'Blank gameweek: no scheduled fixture.' : player.coldStart ? 'Cold-start projection: no Premier League minutes are available, so minutes and points are conservatively discounted.' : minutesConfidence === 'LOW' ? 'Expected minutes are fragile: current projection is below 50 minutes.' : undefined
  return { playerId: player.id, playerName: player.name, modelVersion: MODEL_VERSION, horizon, baseline: round(fullMinutesNeutral, 1), fixtureAdjustment: round(finalExpectedPoints - neutral, 1), expectedMinutesAdjustment: round(neutral - fullMinutesNeutral, 1), appearance: round(appearance, 1), attackingContribution: round(goals + assists, 1), cleanSheetContribution: round(cleanSheetContribution, 1), goalsConcededDeduction: round(goalsConcededDeduction, 1), savePoints: round(savePoints, 1), penaltyPoints: round(penaltyPoints, 1), defensiveContribution: round(defensiveContribution, 1), bonus: round(bonus, 1), cardDeduction: round(cardDeduction, 1), finalExpectedPoints: round(finalExpectedPoints, 1), expectedMinutes: round(sum(r => r.expectedMinutes), 1), minutesConfidence, warning }
}

export const horizonProjection = (player: Player, horizon: number) => projectionBreakdown(player, horizon).finalExpectedPoints

/** Aggregate every scheduled fixture in a gameweek. Blank gameweeks return zero. */
export function projectPlayer(player: Player, gameweek: number): Projection {
  const fixtures = (player.upcomingFixtures || []).filter(fixture => fixture.gameweek === gameweek)
  if (!fixtures.length) return { playerId: player.id, gameweek, modelVersion: MODEL_VERSION, expectedMinutes: 0, expectedGoals: 0, expectedAssists: 0, cleanSheetProbability: 0, expectedBonus: 0, expectedCardDeduction: 0, expectedPoints: 0 }
  const rows = fixtures.map(fixture => projectFixture(player, fixture)), sum = (pick: (row: FixtureProjection) => number) => rows.reduce((total, row) => total + pick(row), 0)
  const rates = playerRates(player)
  const expectedGoals = rows.reduce((total, row, index) => { const factors = fixtureFactors(fixtures[index]); return total + rates.goalRate * (row.expectedMinutes / 90) * factors.attack }, 0)
  const expectedAssists = rows.reduce((total, row, index) => { const factors = fixtureFactors(fixtures[index]); return total + rates.assistRate * (row.expectedMinutes / 90) * factors.attack }, 0)
  return { playerId: player.id, gameweek, modelVersion: MODEL_VERSION, expectedMinutes: round(sum(row => row.expectedMinutes), 1), expectedGoals: round(expectedGoals, 1), expectedAssists: round(expectedAssists, 1), cleanSheetProbability: round(rows.length ? sum(row => row.cleanSheetProbability) / rows.length : 0), expectedBonus: round(sum(row => row.bonus)), expectedCardDeduction: round(sum(row => row.cards)), expectedPoints: round(sum(row => row.total)) }
}
