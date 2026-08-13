import { describe, expect, it } from 'vitest'
import { bonusAdjustment2026, fixtureExpectedMinutes, fixtureRoleStates, projectFixture, projectPlayer, selectStrengthMethod } from './projection.ts'
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
})
