import { describe, expect, it } from 'vitest'
import type { Player } from './domain.ts'
import { rankCaptainCandidates } from './intelligence.ts'

const player = (id: number, startProbability: number): Player => ({
  id, name: `Player ${id}`, club: `T${id}`, position: 'MID', price: 8,
  form: 0, ownership: 0, minutes: 0, fixture: 'OPP (H)', difficulty: 3,
  projection: 0, colour: '#000', roleProfile: { startProbability,
    substituteProbabilityWhenBenched: 0, minutesIfStarting: 90,
    minutesIfSubstitute: 0, confidence: 'MEDIUM', derivedFromSignalIds: [] },
})

describe('captain candidate ranking', () => {
  it('includes vice-captain fallback without discounting unconditional points twice', () => {
    const reliable = player(1, 1)
    const risky = player(2, .5)
    const scores = new Map([[1, 8], [2, 7]])
    const ranked = rankCaptainCandidates([reliable, risky], candidate => scores.get(candidate.id) || 0)
    expect(ranked.map(candidate => candidate.player.id)).toEqual([2, 1])
    expect(ranked[0].armbandScore).toBe(11)
  })
})
