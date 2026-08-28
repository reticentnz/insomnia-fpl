import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Solio GW2 external benchmark snapshot', () => {
  it('retains the captured public calibration targets without making them forecast inputs', () => {
    const snapshot = JSON.parse(fs.readFileSync(path.resolve('scripts/fixtures/solio-gw02-2026-08-26.json'), 'utf8'))
    const points = new Map<string, number>(snapshot.playerExpectedPoints)
    expect(snapshot.scope).toContain('external calibration benchmark')
    expect(snapshot.playerExpectedPoints).toHaveLength(30)
    expect(points.get('B.Fernandes')).toBe(7.12)
    expect(points.get('Haaland')).toBeGreaterThan(points.get('João Pedro'))
    expect(snapshot.teamInputs.MUN.expectedGoals).toBe(2.15)
    expect(snapshot.replayAssertions).toMatchObject({
      minSpearman: 0.6,
      maxRankRegression: 15,
      minBenchmarkedCaptainCandidates: 3,
      minBenchmarkedXIPlayers: 4,
      materialRankDifference: 8,
    })
  })
})
