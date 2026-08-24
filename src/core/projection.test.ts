import { describe, expect, it } from 'vitest'
import { ATTACKING_RATE_PRIOR_MINUTES, bonusAdjustment2026, fixtureExpectedMinutes, fixtureRateModel, fixtureRoleStates, MARKET_CLEAN_SHEET_WEIGHT, noisyRatePriorMinutes, projectFixture, projectPlayer, projectionSampleCalibration, selectStrengthMethod } from './projection.ts'
import type { Player } from '../domain.ts'

describe('fixture role states', () => {
  it('returns exhaustive, mutually exclusive states', () => {
    const role = { startProbability: .7, substituteProbabilityWhenBenched: .2, minutesIfStarting: 86, minutesIfSubstitute: 18 }
    const states = fixtureRoleStates(role)
    expect(states.startProbability).toBeCloseTo(.7, 6)
    expect(states.substituteProbability).toBeCloseTo(.06, 6)
    expect(states.noShowProbability).toBeCloseTo(.24, 6)
  })

  it('does not reduce expected minutes when start probability increases', () => {
    const low = fixtureExpectedMinutes({ startProbability: .3, substituteProbabilityWhenBenched: .2, minutesIfStarting: 86, minutesIfSubstitute: 18 })
    const high = fixtureExpectedMinutes({ startProbability: .7, substituteProbabilityWhenBenched: .2, minutesIfStarting: 86, minutesIfSubstitute: 18 })
    expect(high).toBeGreaterThanOrEqual(low)
  })
})

describe('fixture strength method selection', () => {
  it('prefers complete market goal inputs, then official strengths, then FDR', () => {
    expect(selectStrengthMethod({ market: { homeExpectedGoals: 1.5, awayExpectedGoals: 1.1 }, official: { attack: 1200, defence: 1100 } })).toBe('MARKET_XG')
    expect(selectStrengthMethod({ market: { homeExpectedGoals: null, awayExpectedGoals: 1.1 }, official: { attack: 1200, defence: 1100 } })).toBe('OFFICIAL_STRENGTH')
    expect(selectStrengthMethod({ official: { attack: null, defence: 1100 } })).toBe('FDR_FALLBACK')
  })

  it('applies complete market or official strength multipliers to the shared projection path', () => {
    const player: Player = { id: 1, name: 'Strength Test', club: 'TST', position: 'MID', price: 7, form: 0, ownership: 0, minutes: 90, expectedMinutes: 90, fixture: 'OPP (H)', difficulty: 3, projection: 5, colour: '#000', dataConfidence: 'HIGH' }
    const fallback = projectFixture(player, { gameweek: 1, opponent: 'OPP', venue: 'H', difficulty: 3 })
    const market = projectFixture(player, { gameweek: 1, opponent: 'OPP', venue: 'H', difficulty: 3, strength: { method: 'MARKET_XG', attackMultiplier: 1.4, defenceMultiplier: .8 } })
    const official = projectFixture(player, { gameweek: 1, opponent: 'OPP', venue: 'H', difficulty: 3, strength: { method: 'OFFICIAL_STRENGTH', attackMultiplier: 1.2, defenceMultiplier: .9 } })
    expect(fallback.strengthMethod).toBe('FDR_FALLBACK')
    expect(market.strengthMethod).toBe('MARKET_XG')
    expect(official.strengthMethod).toBe('OFFICIAL_STRENGTH')
    expect(market.total).not.toBe(fallback.total)
  })

  it('adds only a conservative attacking uplift for confirmed set-piece responsibility', () => {
    const base: Player = { id: 2, name: 'Set Piece Test', club: 'TST', position: 'MID', price: 7, form: 0, ownership: 0, minutes: 90, expectedMinutes: 90, fixture: 'OPP (H)', difficulty: 3, projection: 5, colour: '#000', dataConfidence: 'HIGH', roleProfile: { startProbability: 1, substituteProbabilityWhenBenched: 0, minutesIfStarting: 90, minutesIfSubstitute: 0, confidence: 'HIGH', derivedFromSignalIds: [] } }
    const fixture = { gameweek: 1, opponent: 'OPP', venue: 'H' as const, difficulty: 3 }
    const penalties = projectFixture({ ...base, setPieceRole: 'PENALTIES' }, fixture)
    const setPieces = projectFixture({ ...base, setPieceRole: 'SET_PIECES' }, fixture)
    const both = projectFixture({ ...base, setPieceRole: 'PENALTIES_AND_SET_PIECES' }, fixture)
    const baseline = projectFixture(base, fixture)
    expect(penalties.total).toBeGreaterThan(baseline.total)
    expect(setPieces.total).toBeGreaterThan(baseline.total)
    expect(both.total - baseline.total).toBeCloseTo((penalties.total - baseline.total) + (setPieces.total - baseline.total), 6)
    expect(both.total - baseline.total).toBeLessThan(.5)
  })
})

describe('market clean-sheet probabilities', () => {
  const player = (position: 'GK' | 'DEF' | 'MID' | 'FWD'): Player => ({
    id: 7, name: 'Clean Sheet Test', club: 'TST', position, price: 5, form: 0, ownership: 0,
    minutes: 0, expectedMinutes: 90, fixture: 'OPP (H)', difficulty: 3, projection: 5,
    colour: '#000', dataConfidence: 'HIGH',
    roleProfile: { startProbability: 1, substituteProbabilityWhenBenched: 0, minutesIfStarting: 90, minutesIfSubstitute: 0, confidence: 'HIGH', derivedFromSignalIds: [] },
  })

  it('makes the direct market the primary clean-sheet input for defenders', () => {
    const baseline = projectFixture(player('DEF'), { gameweek: 1, opponent: 'OPP', venue: 'H', difficulty: 3 })
    const market = projectFixture(player('DEF'), { gameweek: 1, opponent: 'OPP', venue: 'H', difficulty: 3, marketCleanSheetProbability: .61 })
    const expectedProbability = MARKET_CLEAN_SHEET_WEIGHT * .61 + (1 - MARKET_CLEAN_SHEET_WEIGHT) * baseline.cleanSheetProbability
    expect(market.cleanSheetProbability).toBeCloseTo(expectedProbability, 8)
    expect(market.cleanSheet).toBeCloseTo(expectedProbability * 4, 8)
    expect(market.cleanSheet).toBeGreaterThan(baseline.cleanSheet)
  })

  it('awards midfielders one clean-sheet point and forwards none', () => {
    const fixture = { gameweek: 1, opponent: 'OPP', venue: 'H' as const, difficulty: 3, marketCleanSheetProbability: .61 }
    const midfielder = projectFixture(player('MID'), fixture)
    const forward = projectFixture(player('FWD'), fixture)
    expect(midfielder.cleanSheet).toBeCloseTo(midfielder.cleanSheetProbability, 8)
    expect(forward.cleanSheet).toBe(0)
  })

  it('uses the blended clean-sheet probability in the simulation rate', () => {
    const fixture = { gameweek: 1, opponent: 'OPP', venue: 'H' as const, difficulty: 3, marketCleanSheetProbability: .61 }
    const projected = projectFixture(player('DEF'), fixture)
    const rates = fixtureRateModel(player('DEF'), fixture)
    expect(Math.exp(-rates.xgcRate)).toBeCloseTo(projected.cleanSheetProbability, 8)
  })

  it('correctly models clean-sheet survival for starters subbed at 60m vs full 90m', () => {
    const fixture = { gameweek: 1, opponent: 'OPP', venue: 'H' as const, difficulty: 3 }
    const full90 = projectFixture({ ...player('DEF'), roleProfile: { startProbability: 1, substituteProbabilityWhenBenched: 0, minutesIfStarting: 90, minutesIfSubstitute: 0, confidence: 'HIGH', derivedFromSignalIds: [] } }, fixture)
    const sub60 = projectFixture({ ...player('DEF'), roleProfile: { startProbability: 1, substituteProbabilityWhenBenched: 0, minutesIfStarting: 60, minutesIfSubstitute: 0, confidence: 'HIGH', derivedFromSignalIds: [] } }, fixture)
    const sub45 = projectFixture({ ...player('DEF'), roleProfile: { startProbability: 1, substituteProbabilityWhenBenched: 0, minutesIfStarting: 45, minutesIfSubstitute: 0, confidence: 'HIGH', derivedFromSignalIds: [] } }, fixture)

    // A starter surviving 60 minutes has higher clean sheet probability than one exposed for 90 minutes
    expect(sub60.cleanSheet).toBeGreaterThan(full90.cleanSheet)
    // A starter playing only 45 minutes gets zero clean sheet points
    expect(sub45.cleanSheet).toBe(0)
  })
})

describe('gameweek aggregation', () => {
  const player: Player = {
    id: 42, name: 'Projection Test', club: 'TST', position: 'MID', price: 7,
    form: 0, ownership: 0, minutes: 90, expectedMinutes: 90, fixture: 'OPP (H)',
    difficulty: 3, projection: 5, colour: '#000', dataConfidence: 'HIGH',
    upcomingFixtures: [
      { gameweek: 2, opponent: 'ONE', venue: 'H', difficulty: 3 },
      { gameweek: 2, opponent: 'TWO', venue: 'A', difficulty: 3 },
    ],
  }

  it('returns zero for a blank gameweek', () => {
    expect(projectPlayer(player, 1).expectedPoints).toBe(0)
    expect(projectPlayer(player, 1).expectedMinutes).toBe(0)
  })

  it('aggregates every fixture in a double gameweek', () => {
    const double = projectPlayer(player, 2)
    const first = projectPlayer({ ...player, upcomingFixtures: [player.upcomingFixtures![0]] }, 2)
    const second = projectPlayer({ ...player, upcomingFixtures: [player.upcomingFixtures![1]] }, 2)
    expect(double.expectedPoints).toBeCloseTo(first.expectedPoints + second.expectedPoints, 2)
    expect(double.expectedMinutes).toBeCloseTo(first.expectedMinutes + second.expectedMinutes, 6)
  })
})

describe('2026/27 projection adjustments', () => {
  it('applies goals-conceded risk to defenders who play fewer than 60 minutes', () => {
    const defender: Player = {
      id: 99, name: 'Short Appearance', club: 'TST', position: 'DEF', price: 5,
      form: 0, ownership: 0, minutes: 1000, expectedMinutes: 45, fixture: 'OPP (H)', difficulty: 3,
      projection: 4, colour: '#000', dataConfidence: 'HIGH',
      roleProfile: { startProbability: 1, substituteProbabilityWhenBenched: 0, minutesIfStarting: 45, minutesIfSubstitute: 0, confidence: 'HIGH', derivedFromSignalIds: [] },
      stats: { minutes: 1000, expectedGoalsConcededPer90: 2.4 },
    }
    expect(projectFixture(defender, { gameweek: 1, opponent: 'OPP', venue: 'H', difficulty: 3 }).goalsConceded).toBeLessThan(0)
  })

  it('makes the new-season bonus prior explicit by player profile', () => {
    expect(bonusAdjustment2026('GK', 0)).toBeGreaterThan(1)
    expect(bonusAdjustment2026('MID', 6)).toBeGreaterThan(1)
    expect(bonusAdjustment2026('DEF', 12)).toBeLessThan(1)
    expect(bonusAdjustment2026('DEF', 6)).toBeGreaterThan(1)
  })

  it('shrinks one-match bonus and defensive rates more heavily than xG/xA', () => {
    expect(noisyRatePriorMinutes('BONUS', 90)).toBeGreaterThan(ATTACKING_RATE_PRIOR_MINUTES)
    expect(noisyRatePriorMinutes('DEFENSIVE', 90)).toBeGreaterThan(noisyRatePriorMinutes('BONUS', 90))
    const player: Player = {
      id: 155, name: 'One Match', club: 'TST', position: 'MID', price: 6, form: 0, ownership: 0, minutes: 90, expectedMinutes: 90, fixture: 'OPP (H)', difficulty: 3, projection: 4, colour: '#000', dataConfidence: 'MEDIUM',
      upcomingFixtures: [{ gameweek: 2, opponent: 'OPP', venue: 'H', difficulty: 3 }],
      stats: { minutes: 90, starts: 1, expectedGoalsPer90: 1.2, expectedAssistsPer90: .8, bonus: 3, clearancesBlocksInterceptions: 14, tackles: 4, recoveries: 10 },
    }
    const calibration = projectionSampleCalibration(player)
    expect(calibration.latestMatchSensitivity).toBe('HIGH')
    expect(calibration.bonusEvidenceWeight).toBeLessThan(calibration.attackingEvidenceWeight)
    expect(calibration.defensiveEvidenceWeight).toBeLessThan(calibration.bonusEvidenceWeight)
    const rates = fixtureRateModel(player, player.upcomingFixtures![0])
    expect(rates.bonusRate).toBeLessThan(1)
    expect(rates.defensiveRate).toBeLessThan(10)
  })
})
