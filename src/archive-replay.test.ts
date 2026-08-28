import { describe, expect, it } from 'vitest'
import { evaluateReplayDecisionMetrics, type ArchiveReplayPlayer } from './archive-replay.ts'

const row = (playerId: string, expectedPoints: number, actualPoints: number, overrides: Partial<ArchiveReplayPlayer> = {}): ArchiveReplayPlayer => ({
  playerId, name: playerId, position: 'MID', expectedPoints, actualPoints, actualMinutes: 90,
  startProbability: 1, noShowProbability: 0, baselines: {}, ...overrides,
})

describe('archive replay decision metrics', () => {
  it('uses actual-score ties for recall but exactly K players for point regret', () => {
    const result = evaluateReplayDecisionMetrics([
      row('a', 9, 2), row('b', 8, 6), row('c', 7, 6), row('d', 1, 1),
    ], player => player.expectedPoints, [2])
    expect(result.topK[0]).toMatchObject({ k: 2, recall: 0.5, realizedPoints: 8, oraclePoints: 12, regretPoints: 4, meanRegret: 2 })
  })

  it('applies vice-captain fallback only when the selected captain did not play', () => {
    const players: ArchiveReplayPlayer[] = [
      row('gk', 4, 3, { position: 'GK' }),
      ...Array.from({ length: 5 }, (_, index) => row(`def${index}`, 8 - index, index + 1, { position: 'DEF' })),
      ...Array.from({ length: 5 }, (_, index) => row(`mid${index}`, 15 - index, 5 + index, { position: 'MID' })),
      ...Array.from({ length: 3 }, (_, index) => row(`fwd${index}`, 10 - index, 4 + index, { position: 'FWD' })),
    ]
    const captain = players.find(player => player.playerId === 'mid0')!
    captain.actualMinutes = 0
    captain.actualPoints = 0
    const result = evaluateReplayDecisionMetrics(players)
    expect(result.formationGlobalXI).not.toBeNull()
    expect(result.formationGlobalXI).toMatchObject({ captainId: 'mid0', viceCaptainId: 'mid1', captainNoShow: true, viceFallback: true, captainBonusRealized: 6 })
  })

  it('returns null XI metrics when the positional universe is incomplete', () => {
    const result = evaluateReplayDecisionMetrics([row('one', 4, 5)], undefined, [1])
    expect(result.topK[0].regretPoints).toBe(0)
    expect(result.formationGlobalXI).toBeNull()
  })

  it('can evaluate a separate elite selection score without changing expected points', () => {
    const players = [
      row('mean-first', 8, 2, { selectionScore: .4 }),
      row('elite-first', 7, 10, { selectionScore: .9 }),
      row('third', 6, 1, { selectionScore: .2 }),
    ]
    const expectedBefore = players.map(player => player.expectedPoints)
    const mean = evaluateReplayDecisionMetrics(players, player => player.expectedPoints, [1])
    const elite = evaluateReplayDecisionMetrics(players, player => player.selectionScore!, [1])
    expect(mean.topK[0].realizedPoints).toBe(2)
    expect(elite.topK[0].realizedPoints).toBe(10)
    expect(players.map(player => player.expectedPoints)).toEqual(expectedBefore)
  })
})
