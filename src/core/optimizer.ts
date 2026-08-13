import { evaluateSimultaneousTransfers, type EconomicsPlayer, type TransferMove } from './transfers.ts'
import { selectLineup, type StoredForecast } from './lineup.ts'
import { pairedSimulationSeed, seededRandom, SIMULATION_COUNT } from './uncertainty.ts'

export type OptimizerPlayer = EconomicsPlayer & { locked?: boolean }
export type RecommendationDraft = {
  moves: TransferMove[]; affordabilityStatus: 'EXACT' | 'AFFORDABILITY_UNKNOWN'; bankAfterTenths: number | null; hitCost: number
  rawGain: number; uncertaintyPenalty: number; netExpectedGain: number; probabilityBeatsRoll: number; expectedTeamPoints: number
  p10Points: number; p50Points: number; p90Points: number
  leagueDifferential: number
}

/**
 * Expected point differential a lineup produces against a league's effective
 * ownership field. For each player the field's coverage fraction (ownership +
 * captaincy claims, from EO) cancels out; a low-cov player you start moves you
 * ahead, a heavily-covered template player you own drags you toward the pack.
 * Captain adds the extra 2x relative to the field.
 */
export function squadLeagueDifferential(lineup: { starters: string[]; captainId: string | null }, forecasts: StoredForecast[], coverageByPlayerId?: Map<string | number, number>) {
  const cov = coverageByPlayerId || new Map()
  const mean = (id: string) => forecasts.filter(row => row.playerId === id).reduce((total, row) => total + row.meanPoints, 0)
  let total = 0
  for (const id of lineup.starters) total += mean(id) * (1 - (cov.get(id) ?? 0))
  if (lineup.captainId) total += mean(lineup.captainId) * 1
  return total
}

function pairedProbabilityBeatsRoll(baseline: ReturnType<typeof selectLineup>, proposed: ReturnType<typeof selectLineup>, forecasts: StoredForecast[], threshold: number) {
  const relevantIds = [...new Set([...baseline.starters, ...proposed.starters, baseline.captainId, proposed.captainId].filter((id): id is string => Boolean(id)))].sort()
  const byId = new Map(forecasts.map(row => [row.playerId, row]))
  const samples = new Map<string, number[]>()
  for (const playerId of relevantIds) {
    const forecast = byId.get(playerId)
    if (!forecast) continue
    const random = seededRandom(pairedSimulationSeed('recommendation-plan-comparison-v1', `${forecast.gameweekId}:${playerId}`))
    const values: number[] = []
    while (values.length < SIMULATION_COUNT) {
      const first = Math.max(Number.EPSILON, random()), second = random()
      const radius = Math.sqrt(-2 * Math.log(first))
      values.push(forecast.meanPoints + forecast.standardDeviation * radius * Math.cos(2 * Math.PI * second))
      if (values.length < SIMULATION_COUNT) values.push(forecast.meanPoints + forecast.standardDeviation * radius * Math.sin(2 * Math.PI * second))
    }
    samples.set(playerId, values)
  }
  const total = (lineup: ReturnType<typeof selectLineup>, index: number) => lineup.starters.reduce((sum, id) => sum + (samples.get(id)?.[index] ?? byId.get(id)?.meanPoints ?? 0), 0) + (lineup.captainId ? samples.get(lineup.captainId)?.[index] ?? byId.get(lineup.captainId)?.meanPoints ?? 0 : 0)
  let wins = 0
  for (let index = 0; index < SIMULATION_COUNT; index += 1) if (total(proposed, index) - total(baseline, index) > threshold) wins += 1
  return wins / SIMULATION_COUNT
}

export function evaluateRecommendationDraft(args: { squad: OptimizerPlayer[]; candidateSquad: OptimizerPlayer[]; moves: TransferMove[]; forecasts: StoredForecast[]; bankBeforeTenths: number; freeTransfers: number; uncertaintyPenaltyRate?: number; calculateProbability?: boolean; coverageByPlayerId?: Map<string | number, number> }): RecommendationDraft {
  const route = evaluateSimultaneousTransfers({ squad: args.squad, moves: args.moves, bankBeforeTenths: args.bankBeforeTenths, freeTransfers: args.freeTransfers })
  const baseline = selectLineup(args.forecasts.filter(row => args.squad.some(player => String(player.id) === row.playerId)))
  const proposed = selectLineup(args.forecasts.filter(row => args.candidateSquad.some(player => String(player.id) === row.playerId)))
  const changedIn = new Set(args.moves.map(move => String(move.incoming.id)))
  const uncertaintyPenalty = (args.uncertaintyPenaltyRate ?? .15) * args.forecasts.filter(row => changedIn.has(row.playerId)).reduce((total, row) => total + row.standardDeviation, 0)
  const rawGain = proposed.expectedPoints - baseline.expectedPoints
  const netExpectedGain = rawGain - route.hitCost - uncertaintyPenalty
  const leagueDifferential = squadLeagueDifferential(proposed, args.forecasts, args.coverageByPlayerId) - squadLeagueDifferential(baseline, args.forecasts, args.coverageByPlayerId)
  const probabilityBeatsRoll = args.calculateProbability === false ? (netExpectedGain > 0 ? 1 : 0) : pairedProbabilityBeatsRoll(baseline, proposed, args.forecasts, route.hitCost + uncertaintyPenalty)
  return { moves: args.moves, affordabilityStatus: route.status === 'AFFORDABILITY_UNKNOWN' ? 'AFFORDABILITY_UNKNOWN' : 'EXACT', bankAfterTenths: route.bankAfterTenths, hitCost: route.hitCost, rawGain, uncertaintyPenalty, netExpectedGain, probabilityBeatsRoll, expectedTeamPoints: proposed.expectedPoints, p10Points: proposed.p10Points, p50Points: proposed.p50Points, p90Points: proposed.p90Points, leagueDifferential }
}

/** Exhaustive bounded search (0–5 transfers) over a deliberately supplied candidate pool. */
export function boundedTransferSearch(args: Omit<Parameters<typeof evaluateRecommendationDraft>[0], 'candidateSquad' | 'moves'> & { candidates: OptimizerPlayer[]; maxTransfers: number }): RecommendationDraft[] {
  const max = Math.min(5, Math.max(0, Math.floor(args.maxTransfers)))
  const roll = evaluateRecommendationDraft({ ...args, candidateSquad: args.squad, moves: [], calculateProbability: false })
  const output: RecommendationDraft[] = [roll]
  const byPosition = new Map(args.candidates.filter(player => player.active !== false).map(player => [String(player.id), player]))
  const incomingPool = [...byPosition.values()].filter(player => !args.squad.some(owned => String(owned.id) === String(player.id)))
  const candidateSquadFor = (moves: TransferMove[]) => [...args.squad.filter(player => !moves.some(move => String(move.outId) === String(player.id))), ...moves.map(move => move.incoming)]
  const evaluate = (moves: TransferMove[]) => evaluateRecommendationDraft({ ...args, candidateSquad: candidateSquadFor(moves), moves, calculateProbability: false })
  const choose = <T,>(items: T[], count: number): T[][] => combinations(items, count)
  if (incomingPool.length <= 18) for (let count = 1; count <= max; count++) for (const outgoing of choose(args.squad.filter(player => !player.locked), count)) {
    // A same-club, same-position player that costs no less and projects no more
    // than another candidate is never needed for a legal final squad.
    const prunedPool = incomingPool.filter(player => !incomingPool.some(other => other !== player && other.club === player.club && other.position === player.position && (other.purchasePriceTenths ?? Infinity) <= (player.purchasePriceTenths ?? Infinity) && forecastMean(args.forecasts, String(other.id)) >= forecastMean(args.forecasts, String(player.id)) && ((other.purchasePriceTenths ?? Infinity) < (player.purchasePriceTenths ?? Infinity) || forecastMean(args.forecasts, String(other.id)) > forecastMean(args.forecasts, String(player.id)))))
    for (const incoming of choose(prunedPool, count)) {
      const orderedOutgoing = [...outgoing].sort((a, b) => a.position.localeCompare(b.position) || String(a.id).localeCompare(String(b.id)))
      const orderedIncoming = [...incoming].sort((a, b) => a.position.localeCompare(b.position) || String(a.id).localeCompare(String(b.id)))
      if (orderedIncoming.some((player, index) => player.position !== orderedOutgoing[index].position)) continue
      const moves = orderedOutgoing.map((player, index) => ({ outId: player.id, incoming: orderedIncoming[index] }))
      const draft = evaluate(moves)
      if (draft.affordabilityStatus === 'EXACT' && draft.bankAfterTenths !== null && draft.bankAfterTenths >= 0) output.push(draft)
    }
  } else {
    const outgoing = args.squad.filter(player => !player.locked).sort((left, right) => String(left.id).localeCompare(String(right.id)))
    const replacements = new Map<OptimizerPlayer['position'], OptimizerPlayer[]>()
    for (const position of ['GK', 'DEF', 'MID', 'FWD'] as const) {
      const eligible = incomingPool.filter(player => player.position === position)
      const pruned = eligible.filter(player => !eligible.some(other => other !== player && other.club === player.club && (other.purchasePriceTenths ?? Infinity) <= (player.purchasePriceTenths ?? Infinity) && forecastMean(args.forecasts, String(other.id)) >= forecastMean(args.forecasts, String(player.id)) && ((other.purchasePriceTenths ?? Infinity) < (player.purchasePriceTenths ?? Infinity) || forecastMean(args.forecasts, String(other.id)) > forecastMean(args.forecasts, String(player.id)))))
      replacements.set(position, pruned.sort((left, right) => forecastMean(args.forecasts, String(right.id)) - forecastMean(args.forecasts, String(left.id)) || (left.purchasePriceTenths ?? Infinity) - (right.purchasePriceTenths ?? Infinity)).slice(0, 10))
    }
    type BeamState = { moves: TransferMove[]; lastOutgoingIndex: number; score: number }
    let beam: BeamState[] = [{ moves: [], lastOutgoingIndex: -1, score: 0 }]
    for (let depth = 1; depth <= max; depth += 1) {
      const expanded: BeamState[] = []
      for (const state of beam) for (let index = state.lastOutgoingIndex + 1; index < outgoing.length; index += 1) {
        const sold = outgoing[index]
        for (const incoming of replacements.get(sold.position) || []) {
          if (state.moves.some(move => String(move.incoming.id) === String(incoming.id))) continue
          const moves = [...state.moves, { outId: sold.id, incoming }]
          const route = evaluateSimultaneousTransfers({ squad: args.squad, moves, bankBeforeTenths: args.bankBeforeTenths, freeTransfers: args.freeTransfers })
          if (!route.legal) continue
          const rawGainProxy = moves.reduce((total, move) => total + forecastMean(args.forecasts, String(move.incoming.id)) - forecastMean(args.forecasts, String(move.outId)), 0)
          expanded.push({ moves, lastOutgoingIndex: index, score: rawGainProxy - route.hitCost })
        }
      }
      beam = expanded.sort((left, right) => right.score - left.score || left.moves.length - right.moves.length).slice(0, 1200)
      if (!beam.length) break
      for (const state of beam.slice(0, 30)) output.push(evaluate(state.moves))
    }
  }
  const distinct = new Map<string, RecommendationDraft>()
  for (const draft of output) { const key = draft.moves.map(move => `${move.outId}>${move.incoming.id}`).sort().join('|') || 'ROLL'; if (!distinct.has(key) || distinct.get(key)!.netExpectedGain < draft.netExpectedGain) distinct.set(key, draft) }
  const unique = [...distinct.values()]
  const rollDraft = unique.find(draft => draft.moves.length === 0)!
  const transfers = unique.filter(draft => draft.moves.length > 0).sort((a, b) => b.netExpectedGain - a.netExpectedGain || a.moves.length - b.moves.length || JSON.stringify(a.moves).localeCompare(JSON.stringify(b.moves))).slice(0, 4)
  return [rollDraft, ...transfers].map(draft => evaluateRecommendationDraft({ ...args, candidateSquad: candidateSquadFor(draft.moves), moves: draft.moves, calculateProbability: true }))
}
function forecastMean(rows: StoredForecast[], playerId: string) { return rows.filter(row => row.playerId === playerId).reduce((total, row) => total + row.meanPoints, 0) }
function combinations<T>(values: T[], count: number): T[][] { if (count === 0) return [[]]; if (values.length < count) return []; return values.flatMap((value, index) => combinations(values.slice(index + 1), count - 1).map(rest => [value, ...rest])) }
