import { describe, expect, it } from 'vitest'
import { averagePercentileRanks, decisionRankingScores } from './decision-ranking.ts'

describe('elite decision ranking', () => {
  it('assigns tied values the same average percentile', () => {
    expect(averagePercentileRanks([{ v: 1 }, { v: 2 }, { v: 2 }, { v: 4 }], row => row.v)).toEqual([0, .5, .5, 1])
  })

  it('redistributes unavailable or constant feature weight without changing expected points', () => {
    const rows = [
      { playerId: 'a', expectedPoints: 4, expectedPointsWithoutBonus: 3, pointsPerGame: 0 },
      { playerId: 'b', expectedPoints: 5, expectedPointsWithoutBonus: 4, pointsPerGame: 0 },
    ]
    const before = structuredClone(rows)
    const scores = decisionRankingScores(rows)
    expect(scores.get('b')).toBeGreaterThan(scores.get('a')!)
    expect(rows).toEqual(before)
  })

  it('lets stable no-bonus and PPG evidence break a mean-points tie', () => {
    const scores = decisionRankingScores([
      { playerId: 'bonus-heavy', expectedPoints: 5, expectedPointsWithoutBonus: 3, pointsPerGame: 3 },
      { playerId: 'established', expectedPoints: 5, expectedPointsWithoutBonus: 5, pointsPerGame: 7 },
    ])
    expect(scores.get('established')).toBeGreaterThan(scores.get('bonus-heavy')!)
  })
})
