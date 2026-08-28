import { describe, expect, it } from 'vitest'
import { applyOneStepLookahead, boundedTransferSearch, evaluateRecommendationDraft, freeTransfersAtNextDeadline, selectHorizonLineup, squadLeagueDifferential, type OptimizerPlayer } from './optimizer.ts'
import { selectLineup } from './lineup.ts'
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
    const elite = { ...squad[7], id: 'elite-mid', club: 'elite-mid', purchasePriceTenths: 50, sellingPriceTenths: 50 }
    candidates.push(elite)
    allForecasts.push({ ...forecasts[7], playerId: 'elite-mid', meanPoints: 5.5, selectionScore: 1 })
    const result = boundedTransferSearch({ squad, candidates, forecasts: allForecasts, bankBeforeTenths: 0, freeTransfers: 1, maxTransfers: 5 })
    expect(result[0].moves).toEqual([])
    for (const draft of result.slice(1)) expect(evaluateSimultaneousTransfers({ squad, moves: draft.moves, bankBeforeTenths: 0, freeTransfers: 1 }).legal).toBe(true)
    expect(result.slice(1).some(draft => draft.moves.some(move => move.incoming.id === 'elite-mid'))).toBe(true)
  }, 20_000)
})

describe('multi-gameweek lineup evaluation', () => {
  it('sets a legal XI, captain and vice independently in each gameweek', () => {
    const gw1 = forecasts.map(row => ({ ...row, gameweekId: 'gw1', meanPoints: row.playerId === 'p2' ? 20 : row.meanPoints }))
    const gw2 = forecasts.map(row => ({ ...row, gameweekId: 'gw2', meanPoints: row.playerId === 'p7' ? 25 : row.meanPoints }))
    const horizon = selectHorizonLineup([...gw1, ...gw2])
    const first = horizon.byGameweek.find(item => item.gameweekId === 'gw1')!.lineup
    const second = horizon.byGameweek.find(item => item.gameweekId === 'gw2')!.lineup

    expect(first.starters).toHaveLength(11)
    expect(second.starters).toHaveLength(11)
    expect(first.captainId).toBe('p2')
    expect(second.captainId).toBe('p7')
    expect(horizon.expectedPoints).toBeCloseTo(selectLineup(gw1).expectedPoints + selectLineup(gw2).expectedPoints, 9)
  })

  it('scores a transfer from the sum of its weekly lineups, rather than a fixed horizon XI', () => {
    const incoming = { ...squad[7], id: 'weekly-specialist', club: 'weekly-specialist', purchasePriceTenths: 50, sellingPriceTenths: 50 }
    const gw1 = forecasts.map(row => ({ ...row, gameweekId: 'gw1', meanPoints: row.playerId === 'p7' ? 12 : row.meanPoints }))
    const gw2 = forecasts.map(row => ({ ...row, gameweekId: 'gw2', meanPoints: row.playerId === 'p7' ? 1 : row.meanPoints }))
    const incomingGw1 = { ...gw1[7], playerId: 'weekly-specialist', meanPoints: 1 }
    const incomingGw2 = { ...gw2[7], playerId: 'weekly-specialist', meanPoints: 20 }
    const allForecasts = [...gw1, ...gw2, incomingGw1, incomingGw2]
    const draft = evaluateRecommendationDraft({ squad, candidateSquad: [...squad.filter(player => player.id !== 'p7'), incoming], moves: [{ outId: 'p7', incoming }], forecasts: allForecasts, bankBeforeTenths: 0, freeTransfers: 1, uncertaintyPenaltyRate: 0 })
    const baseline = selectHorizonLineup(allForecasts.filter(row => squad.some(player => String(player.id) === row.playerId)))
    const proposed = selectHorizonLineup(allForecasts.filter(row => [...squad.filter(player => player.id !== 'p7'), incoming].some(player => String(player.id) === row.playerId)))

    expect(draft.rawGain).toBeCloseTo(proposed.expectedPoints - baseline.expectedPoints, 9)
    expect(proposed.byGameweek[0].lineup.captainId).not.toBe(proposed.byGameweek[1].lineup.captainId)
  })
})

describe('saved free-transfer option value', () => {
  it('uses the exact carried-transfer state, including hit transfers and the five-transfer cap', () => {
    expect(freeTransfersAtNextDeadline(1, 0)).toBe(2)
    expect(freeTransfersAtNextDeadline(1, 1)).toBe(1)
    expect(freeTransfersAtNextDeadline(0, 2)).toBe(1)
    expect(freeTransfersAtNextDeadline(5, 0)).toBe(5)
  })

  it('subtracts the next-week plan advantage of rolling instead of using a fixed transfer premium', () => {
    const now = { ...squad[12], id: 'now-fwd', club: 'now-fwd', purchasePriceTenths: 50, sellingPriceTenths: 50 }
    const nextMidA = { ...squad[7], id: 'next-mid-a', club: 'next-mid-a', purchasePriceTenths: 50, sellingPriceTenths: 50 }
    const nextMidB = { ...squad[8], id: 'next-mid-b', club: 'next-mid-b', purchasePriceTenths: 50, sellingPriceTenths: 50 }
    const candidates = [...squad, now, nextMidA, nextMidB]
    const currentForecasts: StoredForecast[] = [
      ...forecasts,
      { ...forecasts[12], playerId: 'now-fwd', meanPoints: 10, standardDeviation: 1 },
      { ...forecasts[7], playerId: 'next-mid-a', meanPoints: 4, standardDeviation: 1 },
      { ...forecasts[8], playerId: 'next-mid-b', meanPoints: 4, standardDeviation: 1 },
    ]
    const futureForecasts: StoredForecast[] = [
      ...forecasts.map(row => ({ ...row, gameweekId: 'gw2', meanPoints: row.playerId === 'p7' || row.playerId === 'p8' ? 1 : 4, standardDeviation: 1 })),
      { ...forecasts[12], playerId: 'now-fwd', gameweekId: 'gw2', meanPoints: 4, standardDeviation: 1 },
      { ...forecasts[7], playerId: 'next-mid-a', gameweekId: 'gw2', meanPoints: 20, standardDeviation: 1 },
      { ...forecasts[8], playerId: 'next-mid-b', gameweekId: 'gw2', meanPoints: 20, standardDeviation: 1 },
    ]
    const moves = [{ outId: 'p12', incoming: now }]
    const transfer = evaluateRecommendationDraft({ squad, candidateSquad: [...squad.filter(player => player.id !== 'p12'), now], moves, forecasts: currentForecasts, bankBeforeTenths: 0, freeTransfers: 1, uncertaintyPenaltyRate: 0 })
    const [roll, adjusted] = applyOneStepLookahead({
      drafts: [evaluateRecommendationDraft({ squad, candidateSquad: squad, moves: [], forecasts: currentForecasts, bankBeforeTenths: 0, freeTransfers: 1, uncertaintyPenaltyRate: 0 }), transfer],
      squad,
      candidates,
      forecasts: currentForecasts,
      futureForecasts,
      futureCandidates: candidates,
      bankBeforeTenths: 0,
      freeTransfers: 1,
      uncertaintyPenaltyRate: 0,
      maxTransfers: 2,
    })

    // The two high-upside MID upgrades create a strictly better legal next-GW
    // plan with two free transfers.  The exact difference includes the lineup
    // and captain optimizer, which is why it must be calculated, not assumed.
    expect(roll.lookaheadAvailable).toBe(true)
    expect(roll.nextWeekFreeTransfers).toBe(2)
    expect(roll.nextWeekBestNetGain).toBeGreaterThan(0)
    expect(adjusted.lookaheadAvailable).toBe(true)
    expect(adjusted.nextWeekFreeTransfers).toBe(1)
    expect(roll.nextWeekBestNetGain!).toBeGreaterThan(adjusted.nextWeekBestNetGain!)
    expect(adjusted.savedTransferValue).toBeGreaterThan(0)
    expect(adjusted.netExpectedGain).toBeCloseTo(transfer.netExpectedGain - adjusted.savedTransferValue, 9)
  })

  it('leaves the adjustment unavailable when the next gameweek lacks a full squad forecast', () => {
    const draft = evaluateRecommendationDraft({ squad, candidateSquad: squad, moves: [], forecasts, bankBeforeTenths: 0, freeTransfers: 1 })
    const [result] = applyOneStepLookahead({ drafts: [draft], squad, candidates: squad, forecasts, futureForecasts: forecasts.slice(1), futureCandidates: squad, bankBeforeTenths: 0, freeTransfers: 1, maxTransfers: 1 })
    expect(result.lookaheadAvailable).toBe(false)
    expect(result.savedTransferValue).toBe(0)
    expect(result.nextWeekBestNetGain).toBeNull()
  })

  it('bounds lookahead to the roll plus four ranked transfers so every returned row is adjusted', () => {
    const incoming = { ...squad[7], id: 'lookahead-in', club: 'lookahead-in', purchasePriceTenths: 50, sellingPriceTenths: 50 }
    const currentForecasts = [...forecasts, { ...forecasts[7], playerId: 'lookahead-in', meanPoints: 8 }]
    const futureForecasts = currentForecasts.map(row => ({ ...row, gameweekId: 'gw2' }))
    const transfer = evaluateRecommendationDraft({ squad, candidateSquad: [...squad.filter(player => player.id !== 'p7'), incoming], moves: [{ outId: 'p7', incoming }], forecasts: currentForecasts, bankBeforeTenths: 0, freeTransfers: 1 })
    const roll = evaluateRecommendationDraft({ squad, candidateSquad: squad, moves: [], forecasts: currentForecasts, bankBeforeTenths: 0, freeTransfers: 1 })
    const result = applyOneStepLookahead({ drafts: [roll, ...Array.from({ length: 6 }, () => transfer)], squad, candidates: [...squad, incoming], forecasts: currentForecasts, futureForecasts, futureCandidates: [...squad, incoming], bankBeforeTenths: 0, freeTransfers: 1, maxTransfers: 1 })

    expect(result).toHaveLength(5)
    expect(result.every(draft => draft.lookaheadAvailable)).toBe(true)
  })
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
