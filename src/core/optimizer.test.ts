import { describe, expect, it } from 'vitest'
import { boundedTransferSearch, evaluateRecommendationDraft, squadLeagueDifferential, type OptimizerPlayer } from './optimizer.ts'
import { evaluateSimultaneousTransfers } from './transfers.ts'
import type { StoredForecast } from './lineup.ts'

const positions = ['GK', 'GK', 'DEF', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'MID', 'MID', 'FWD', 'FWD', 'FWD'] as const
const squad: OptimizerPlayer[] = positions.map((position, index) => ({ id: `p${index}`, club: `c${index}`, position, active: true, sellingPriceTenths: 50, purchasePriceTenths: 50 }))
const forecasts: StoredForecast[] = squad.map((player, index) => ({ playerId: String(player.id), gameweekId: 'gw1', position: player.position, meanPoints: 4 + index / 10, standardDeviation: 2, p10Points: 1, p50Points: 4, p90Points: 8, startProbability: .8, noShowProbability: .1 }))

describe('bounded transfer recommendations', () => {
  it('always includes roll and applies official hit economics through five moves', () => {
    const candidates = [...squad, ...[0, 1, 2, 3, 4].map(index => ({ ...squad[7 + index], id: `new${index}`, club: `new${index}`, purchasePriceTenths: 50, sellingPriceTenths: 50 }))]
    const result = boundedTransferSearch({ squad, candidates, forecasts: [...forecasts, ...forecasts.slice(7, 12).map((row, index) => ({ ...row, playerId: `new${index}`, meanPoints: 10 }))], bankBeforeTenths: 0, freeTransfers: 0, maxTransfers: 5 })
    expect(result[0].moves).toHaveLength(0)
    const five = evaluateRecommendationDraft({ squad, candidateSquad: squad, moves: Array.from({ length: 5 }, (_, index) => ({ outId: `p${7 + index}`, incoming: candidates[15 + index] })), forecasts, bankBeforeTenths: 0, freeTransfers: 2 })
    expect(five.hitCost).toBe(12)
  })

  it('does not make a move primary below the 60 percent paired probability rule', () => {
    const candidate = { ...squad[7], id: 'better', club: 'better', purchasePriceTenths: 50, sellingPriceTenths: 50 }
    const draft = evaluateRecommendationDraft({ squad, candidateSquad: [...squad.filter(p => p.id !== 'p7'), candidate], moves: [{ outId: 'p7', incoming: candidate }], forecasts: [...forecasts, { ...forecasts[7], playerId: 'better', meanPoints: 4.2, standardDeviation: 20 }], bankBeforeTenths: 0, freeTransfers: 1 })
    expect(draft.probabilityBeatsRoll).toBeLessThan(.6)
  })

  it('matches exhaustive one-transfer enumeration for a small correctness-guard pool', () => {
    const incoming = [7, 8, 12].map((index, offset) => ({ ...squad[index], id: `guard-${offset}`, club: `guard-${offset}`, purchasePriceTenths: 50, sellingPriceTenths: 50 }))
    const allForecasts = [...forecasts, ...incoming.map((player, index) => ({ ...forecasts[[7, 8, 12][index]], playerId: String(player.id), meanPoints: 7 + index }))]
    const result = boundedTransferSearch({ squad, candidates: [...squad, ...incoming], forecasts: allForecasts, bankBeforeTenths: 0, freeTransfers: 1, maxTransfers: 1 })
    const exhaustive = squad.flatMap(outgoing => incoming.filter(player => player.position === outgoing.position).map(player => evaluateRecommendationDraft({ squad, candidateSquad: [...squad.filter(item => item.id !== outgoing.id), player], moves: [{ outId: outgoing.id, incoming: player }], forecasts: allForecasts, bankBeforeTenths: 0, freeTransfers: 1 }))).sort((left, right) => right.netExpectedGain - left.netExpectedGain)[0]
    expect(result[1].moves.map(move => `${move.outId}>${move.incoming.id}`)).toEqual(exhaustive.moves.map(move => `${move.outId}>${move.incoming.id}`))
  })

  it('returns only legal routes from a full-size catalogue', () => {
    const counts = { GK: 35, DEF: 120, MID: 150, FWD: 90 } as const
    const candidates: OptimizerPlayer[] = [...squad]
    const allForecasts: StoredForecast[] = [...forecasts]
    for (const [position, count] of Object.entries(counts) as Array<[OptimizerPlayer['position'], number]>) for (let index = 0; index < count; index += 1) {
      const id = `${position}-${index}`
      candidates.push({ id, club: `club-${index % 20}`, position, active: true, purchasePriceTenths: 50, sellingPriceTenths: 50 })
      allForecasts.push({ playerId: id, gameweekId: 'gw1', position, meanPoints: 5 + (index % 10) / 10, standardDeviation: 2, p10Points: 2, p50Points: 5, p90Points: 9, startProbability: .9, noShowProbability: .05 })
    }
    const result = boundedTransferSearch({ squad, candidates, forecasts: allForecasts, bankBeforeTenths: 0, freeTransfers: 1, maxTransfers: 5 })
    expect(result[0].moves).toEqual([])
    for (const draft of result.slice(1)) expect(evaluateSimultaneousTransfers({ squad, moves: draft.moves, bankBeforeTenths: 0, freeTransfers: 1 }).legal).toBe(true)
  }, 20_000)
})

describe('league differential measurement', () => {
  const lineup = { starters: ['a', 'b', 'c'], captainId: 'a' }
  const rows: StoredForecast[] = [
    { playerId: 'a', gameweekId: 'gw1', position: 'MID', meanPoints: 8, standardDeviation: 2, p10Points: 2, p50Points: 8, p90Points: 14, startProbability: .9, noShowProbability: .1 },
    { playerId: 'b', gameweekId: 'gw1', position: 'FWD', meanPoints: 6, standardDeviation: 2, p10Points: 1, p50Points: 6, p90Points: 12, startProbability: .9, noShowProbability: .1 },
    { playerId: 'c', gameweekId: 'gw1', position: 'DEF', meanPoints: 4, standardDeviation: 2, p10Points: 0, p50Points: 4, p90Points: 9, startProbability: .9, noShowProbability: .1 },
    { playerId: 'd', gameweekId: 'gw1', position: 'MID', meanPoints: 5, standardDeviation: 2, p10Points: 1, p50Points: 5, p90Points: 10, startProbability: .9, noShowProbability: .1 },
  ]

  it('scores a low-coverage starter ahead of a heavily-covered template player', () => {
    const coverage = new Map<string, number>([['a', .9], ['b', 1.2], ['c', .3]])
    // a: 8*(1-.9) + 8 (captain 2x extra) = 8.8; b: 6*(1-1.2) = -1.2; c: 4*(1-.3) = 2.8
    expect(squadLeagueDifferential(lineup, rows, coverage)).toBeCloseTo(8.8 + (-1.2) + 2.8, 9)
  })

  it('needs no coverage map and then treats every player as an uncovered pick', () => {
    expect(squadLeagueDifferential(lineup, rows)).toBeCloseTo((8 + 6 + 4) + 8, 9)
  })

  it('replacing a template player with a sleeper of equal expected points raises net differential', () => {
    // p7 is treated as a heavily-covered template pick while the replacement is uncovered.
    const coverage = new Map<string, number>([...squad.map((player, index) => [String(player.id), index < 7 ? .5 : 1.2])])
    const incoming = { ...squad[7], id: 'sleeper', club: 'sleeper', purchasePriceTenths: 50, sellingPriceTenths: 50 }
    const allForecasts: StoredForecast[] = [...forecasts, { ...forecasts[7], playerId: 'sleeper', meanPoints: 20 }]
    const roll = evaluateRecommendationDraft({ squad, candidateSquad: squad, moves: [], forecasts: allForecasts, bankBeforeTenths: 0, freeTransfers: 1, coverageByPlayerId: coverage })
    const draft = evaluateRecommendationDraft({ squad, candidateSquad: [...squad.filter(player => player.id !== 'p7'), incoming], moves: [{ outId: 'p7', incoming }], forecasts: allForecasts, bankBeforeTenths: 0, freeTransfers: 1, coverageByPlayerId: coverage })
    expect(draft.leagueDifferential).toBeGreaterThan(roll.leagueDifferential)
    expect(draft.leagueDifferential).toBeGreaterThan(0)
  })
})
