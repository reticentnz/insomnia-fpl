import { describe, expect, it } from 'vitest'
import { selectLineup, type StoredForecast } from './lineup.ts'

function mockForecast(id: string, position: 'GK' | 'DEF' | 'MID' | 'FWD', meanPoints: number, options: Partial<StoredForecast> = {}): StoredForecast {
  return {
    playerId: id,
    gameweekId: 'gw-1',
    position,
    meanPoints,
    standardDeviation: 1.5,
    p10Points: meanPoints - 1.5,
    p50Points: meanPoints,
    p90Points: meanPoints + 2.0,
    startProbability: 0.9,
    noShowProbability: 0.05,
    ...options,
  }
}

function fullSquad(): StoredForecast[] {
  return [
    mockForecast('gk-1', 'GK', 4.5),
    mockForecast('gk-2', 'GK', 3.5),
    mockForecast('def-1', 'DEF', 5.0),
    mockForecast('def-2', 'DEF', 4.8),
    mockForecast('def-3', 'DEF', 4.5),
    mockForecast('def-4', 'DEF', 4.0),
    mockForecast('def-5', 'DEF', 3.8),
    mockForecast('mid-1', 'MID', 7.5),
    mockForecast('mid-2', 'MID', 6.5),
    mockForecast('mid-3', 'MID', 6.0),
    mockForecast('mid-4', 'MID', 5.5),
    mockForecast('mid-5', 'MID', 4.2),
    mockForecast('fwd-1', 'FWD', 8.0),
    mockForecast('fwd-2', 'FWD', 7.0),
    mockForecast('fwd-3', 'FWD', 4.0),
  ]
}

describe('selectLineup formation selection & constraints', () => {
  it('selects 11 starters with valid formation (>= 1 GK, >= 3 DEF, >= 2 MID, >= 1 FWD)', () => {
    const lineup = selectLineup(fullSquad())
    expect(lineup.starters).toHaveLength(11)
    expect(lineup.bench).toHaveLength(4)
    expect(lineup.starters).toContain('gk-1')
    expect(lineup.captainId).toBe('fwd-1')
    expect(lineup.viceCaptainId).toBe('mid-1')
  })

  it('deduplicates and aggregates multi-fixture DGW rows per player', () => {
    const squad = fullSquad()
    const dgwRow = mockForecast('mid-1', 'MID', 6.0, {
      samples: [4, 5, 6, 7],
      minuteSamples: [90, 85, 90, 80],
    })
    squad[7] = {
      ...squad[7],
      samples: [5, 6, 7, 8],
      minuteSamples: [90, 90, 85, 90],
    }
    const lineup = selectLineup([...squad, dgwRow])
    expect(lineup.starters.filter(id => id === 'mid-1')).toHaveLength(1)
    expect(lineup.captainId).toBe('mid-1')
  })
})

describe('minutes-based captain doubling & auto-substitutions', () => {
  it('selects the captain and vice pair with the greatest expected fallback bonus', () => {
    const squad = fullSquad().map(player => player.playerId === 'fwd-1'
      ? { ...player, meanPoints: 7, noShowProbability: .5 }
      : player.playerId === 'mid-1'
        ? { ...player, meanPoints: 8, noShowProbability: 0 }
        : player)
    const lineup = selectLineup(squad)
    expect(lineup.captainId).toBe('fwd-1')
    expect(lineup.viceCaptainId).toBe('mid-1')
  })

  it('uses minute samples when selecting a captain and vice pair', () => {
    const squad = fullSquad().map(player => {
      if (player.playerId === 'fwd-1') return { ...player, meanPoints: 7, noShowProbability: .5, samples: [0, 14], minuteSamples: [0, 90] }
      if (player.playerId === 'mid-1') return { ...player, meanPoints: 8, noShowProbability: 0, samples: [8, 8], minuteSamples: [90, 90] }
      return { ...player, samples: [player.meanPoints, player.meanPoints], minuteSamples: [90, 90] }
    })
    const lineup = selectLineup(squad)
    expect(lineup.captainId).toBe('fwd-1')
    expect(lineup.viceCaptainId).toBe('mid-1')
  })

  it('retains captain doubling when captain plays and scores 0 or negative points', () => {
    const squad = fullSquad().map((p) => {
      if (p.playerId === 'fwd-1') {
        return { ...p, meanPoints: 10, samples: [0, 0], minuteSamples: [90, 90] }
      }
      if (p.playerId === 'mid-1') {
        return { ...p, meanPoints: 8, samples: [-1, -1], minuteSamples: [90, 90] }
      }
      return { ...p, samples: [-1, -1], minuteSamples: [90, 90] }
    })

    const lineup = selectLineup(squad)
    expect(lineup.captainId).toBe('fwd-1')
    expect(lineup.samples).toBeDefined()
    // Captain doubled is 0 + 0 = 0 (not vice doubled). The ten other
    // starters each score -1 in this deliberately adversarial draw.
    expect(lineup.samples![0]).toBe(-10)
  })

  it('triggers vice-captain doubling when captain records 0 minutes (no-show)', () => {
    const squad = fullSquad().map((p) => {
      if (p.playerId === 'fwd-1') {
        return { ...p, meanPoints: 10, noShowProbability: 0.1, samples: [0, 8], minuteSamples: [0, 90] }
      }
      if (p.playerId === 'mid-1') {
        return { ...p, meanPoints: 8, noShowProbability: 0.05, samples: [6, 6], minuteSamples: [90, 90] }
      }
      return { ...p, samples: [2, 2], minuteSamples: [90, 90] }
    })

    const lineup = selectLineup(squad)
    expect(lineup.captainId).toBe('fwd-1')
    expect(lineup.viceCaptainId).toBe('mid-1')
    expect(lineup.samples).toBeDefined()
    // In draw 0: fwd-1 has 0 mins, mid-1 doubles (+6)
    expect(lineup.samples![0]).toBeGreaterThan(0)
  })

  it('substitutes missing starters in bench order while strictly preserving formation legality', () => {
    const squad = fullSquad().map((p) => {
      if (p.playerId === 'def-3') {
        return { ...p, samples: [0], minuteSamples: [0] }
      }
      if (p.playerId === 'fwd-3') {
        return { ...p, meanPoints: 5.0, samples: [10], minuteSamples: [90] }
      }
      if (p.playerId === 'def-4') {
        return { ...p, meanPoints: 4.0, samples: [5], minuteSamples: [90] }
      }
      return { ...p, samples: [2], minuteSamples: [90] }
    })

    const lineup = selectLineup(squad)
    expect(lineup.starters).toContain('def-3')
    expect(lineup.samples).toBeDefined()
    expect(lineup.samples![0]).toBeGreaterThanOrEqual(5)
  })

  it('only substitutes a starting goalkeeper with the bench goalkeeper', () => {
    const squad = fullSquad().map((p) => {
      if (p.playerId === 'gk-1') {
        return { ...p, samples: [0], minuteSamples: [0] }
      }
      if (p.playerId === 'gk-2') {
        return { ...p, samples: [7], minuteSamples: [90] }
      }
      return { ...p, samples: [3], minuteSamples: [90] }
    })

    const lineup = selectLineup(squad)
    expect(lineup.samples).toBeDefined()
    expect(lineup.samples![0]).toBeGreaterThan(30)
  })
})
