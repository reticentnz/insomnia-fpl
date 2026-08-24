import { evaluateSimultaneousTransfers, type EconomicsPlayer, type TransferMove } from './transfers.ts'
import { selectLineup, type Lineup, type StoredForecast } from './lineup.ts'
import { pairedSimulationSeed, seededRandom, SIMULATION_COUNT } from './uncertainty.ts'

export type OptimizerPlayer = EconomicsPlayer & { locked?: boolean }
type HorizonLineup = Lineup & { byGameweek: Array<{ gameweekId: string; lineup: Lineup }> }
export type RecommendationDraft = {
  moves: TransferMove[]; affordabilityStatus: 'EXACT' | 'AFFORDABILITY_UNKNOWN'; bankAfterTenths: number | null; hitCost: number
  rawGain: number; uncertaintyPenalty: number; netExpectedGain: number; probabilityBeatsRoll: number; expectedTeamPoints: number
  p10Points: number; p50Points: number; p90Points: number
  leagueDifferential: number
  /**
   * Deterministic value of arriving at the following deadline with the roll
   * state rather than this candidate's state.  It is deliberately calculated
   * from the stored next-GW forecasts, rather than a fixed "saved FT" value.
   */
  savedTransferValue: number
  lookaheadAvailable: boolean
  nextWeekFreeTransfers: number | null
  nextWeekBestNetGain: number | null
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

/**
 * An FPL XI, captain and vice are choices for a gameweek, not a horizon.  A
 * three-week total therefore consists of three independently legal lineups.
 * This also preserves selectLineup's sampled automatic-substitution and
 * captain-to-vice behaviour within every individual gameweek.
 */
export function selectHorizonLineup(forecasts: StoredForecast[]): HorizonLineup {
  const rowsByGameweek = new Map<string, StoredForecast[]>()
  for (const row of forecasts) {
    const rows = rowsByGameweek.get(row.gameweekId) || []
    rows.push(row)
    rowsByGameweek.set(row.gameweekId, rows)
  }
  const byGameweek = [...rowsByGameweek.entries()].map(([gameweekId, rows]) => ({ gameweekId, lineup: selectLineup(rows) }))
  const lineups = byGameweek.map(item => item.lineup)
  const allHaveSamples = lineups.length > 0 && lineups.every(lineup => lineup.samples && lineup.samples.length > 0)
  const samples = allHaveSamples ? combineSamples(lineups.map(lineup => lineup.samples!)) : undefined
  if (samples) {
    const mean = samples.reduce((total, value) => total + value, 0) / samples.length
    const variance = samples.reduce((total, value) => total + (value - mean) ** 2, 0) / samples.length
    const ordered = [...samples].sort((left, right) => left - right)
    const percentile = (fraction: number) => ordered[Math.min(ordered.length - 1, Math.max(0, Math.floor((ordered.length - 1) * fraction)))] ?? 0
    return {
      starters: [], bench: [], captainId: null, viceCaptainId: null,
      expectedPoints: mean, standardDeviation: Math.sqrt(variance), p10Points: percentile(.1), p50Points: percentile(.5), p90Points: percentile(.9), samples,
      byGameweek,
    }
  }
  return {
    starters: [], bench: [], captainId: null, viceCaptainId: null,
    expectedPoints: lineups.reduce((total, lineup) => total + lineup.expectedPoints, 0),
    standardDeviation: Math.sqrt(lineups.reduce((total, lineup) => total + lineup.standardDeviation ** 2, 0)),
    p10Points: lineups.reduce((total, lineup) => total + lineup.p10Points, 0),
    p50Points: lineups.reduce((total, lineup) => total + lineup.p50Points, 0),
    p90Points: lineups.reduce((total, lineup) => total + lineup.p90Points, 0),
    byGameweek,
  }
}

function combineSamples(streams: readonly (readonly number[])[]) {
  const count = streams[0]?.length || 0
  if (!count || streams.some(stream => stream.length !== count)) return undefined
  return Array.from({ length: count }, (_, index) => streams.reduce((total, stream) => total + (stream[index] ?? 0), 0))
}

function horizonLeagueDifferential(lineup: HorizonLineup, forecasts: StoredForecast[], coverageByPlayerId?: Map<string | number, number>) {
  return lineup.byGameweek.reduce((total, item) => total + squadLeagueDifferential(item.lineup, forecasts.filter(row => row.gameweekId === item.gameweekId), coverageByPlayerId), 0)
}

function pairedProbabilityBeatsRoll(baseline: HorizonLineup, proposed: HorizonLineup, forecasts: StoredForecast[], threshold: number) {
  if (baseline.samples && proposed.samples && baseline.samples.length === proposed.samples.length) {
    let wins = 0
    for (let index = 0; index < baseline.samples.length; index += 1) if ((proposed.samples[index] ?? 0) - (baseline.samples[index] ?? 0) > threshold) wins += 1
    return wins / baseline.samples.length
  }
  const selected = (lineup: HorizonLineup) => lineup.byGameweek.flatMap(item => [
    ...item.lineup.starters.map(playerId => `${item.gameweekId}:${playerId}`),
    item.lineup.captainId ? `${item.gameweekId}:${item.lineup.captainId}` : null,
  ].filter((key): key is string => Boolean(key)))
  const relevantKeys = [...new Set([...selected(baseline), ...selected(proposed)])].sort()
  const byKey = new Map(forecasts.map(row => [`${row.gameweekId}:${row.playerId}`, row]))
  const samples = new Map<string, number[]>()
  for (const key of relevantKeys) {
    const forecast = byKey.get(key)
    if (!forecast) continue
    const random = seededRandom(pairedSimulationSeed('recommendation-plan-comparison-v1', `${forecast.gameweekId}:${forecast.playerId}`))
    const values: number[] = []
    while (values.length < SIMULATION_COUNT) {
      const first = Math.max(Number.EPSILON, random()), second = random()
      const radius = Math.sqrt(-2 * Math.log(first))
      values.push(forecast.meanPoints + forecast.standardDeviation * radius * Math.cos(2 * Math.PI * second))
      if (values.length < SIMULATION_COUNT) values.push(forecast.meanPoints + forecast.standardDeviation * radius * Math.sin(2 * Math.PI * second))
    }
    samples.set(key, values)
  }
  const total = (lineup: HorizonLineup, index: number) => lineup.byGameweek.reduce((sum, item) => {
    const points = (playerId: string) => samples.get(`${item.gameweekId}:${playerId}`)?.[index] ?? byKey.get(`${item.gameweekId}:${playerId}`)?.meanPoints ?? 0
    return sum + item.lineup.starters.reduce((subtotal, playerId) => subtotal + points(playerId), 0) + (item.lineup.captainId ? points(item.lineup.captainId) : 0)
  }, 0)
  let wins = 0
  for (let index = 0; index < SIMULATION_COUNT; index += 1) if (total(proposed, index) - total(baseline, index) > threshold) wins += 1
  return wins / SIMULATION_COUNT
}

export function evaluateRecommendationDraft(args: { squad: OptimizerPlayer[]; candidateSquad: OptimizerPlayer[]; moves: TransferMove[]; forecasts: StoredForecast[]; bankBeforeTenths: number; freeTransfers: number; uncertaintyPenaltyRate?: number; calculateProbability?: boolean; coverageByPlayerId?: Map<string | number, number>; savedTransferValue?: number }): RecommendationDraft {
  const route = evaluateSimultaneousTransfers({ squad: args.squad, moves: args.moves, bankBeforeTenths: args.bankBeforeTenths, freeTransfers: args.freeTransfers })
  const baseline = selectHorizonLineup(args.forecasts.filter(row => args.squad.some(player => String(player.id) === row.playerId)))
  const proposed = selectHorizonLineup(args.forecasts.filter(row => args.candidateSquad.some(player => String(player.id) === row.playerId)))
  const changedIn = new Set(args.moves.map(move => String(move.incoming.id)))
  const changedStandardDeviation = [...changedIn].reduce((total, playerId) => total + Math.sqrt(args.forecasts.filter(row => row.playerId === playerId).reduce((variance, row) => variance + row.standardDeviation ** 2, 0)), 0)
  const uncertaintyPenalty = (args.uncertaintyPenaltyRate ?? .15) * changedStandardDeviation
  const rawGain = proposed.expectedPoints - baseline.expectedPoints
  const savedTransferValue = args.savedTransferValue ?? 0
  const netExpectedGain = rawGain - route.hitCost - uncertaintyPenalty - savedTransferValue
  const leagueDifferential = horizonLeagueDifferential(proposed, args.forecasts, args.coverageByPlayerId) - horizonLeagueDifferential(baseline, args.forecasts, args.coverageByPlayerId)
  const probabilityBeatsRoll = args.calculateProbability === false ? (netExpectedGain > 0 ? 1 : 0) : pairedProbabilityBeatsRoll(baseline, proposed, args.forecasts, route.hitCost + uncertaintyPenalty + savedTransferValue)
  return { moves: args.moves, affordabilityStatus: route.status === 'AFFORDABILITY_UNKNOWN' ? 'AFFORDABILITY_UNKNOWN' : 'EXACT', bankAfterTenths: route.bankAfterTenths, hitCost: route.hitCost, rawGain, uncertaintyPenalty, netExpectedGain, probabilityBeatsRoll, expectedTeamPoints: proposed.expectedPoints, p10Points: proposed.p10Points, p50Points: proposed.p50Points, p90Points: proposed.p90Points, leagueDifferential, savedTransferValue, lookaheadAvailable: false, nextWeekFreeTransfers: null, nextWeekBestNetGain: null }
}

/** The official transfer carry rule, including transfers made for a points hit. */
export function freeTransfersAtNextDeadline(freeTransfers: number, transfersMade: number, cap = 5) {
  if (!Number.isInteger(freeTransfers) || freeTransfers < 0) throw new Error('freeTransfers must be a non-negative integer')
  if (!Number.isInteger(transfersMade) || transfersMade < 0) throw new Error('transfersMade must be a non-negative integer')
  if (!Number.isInteger(cap) || cap < 1) throw new Error('cap must be a positive integer')
  return Math.min(cap, Math.max(0, freeTransfers - transfersMade) + 1)
}

type OneStepLookaheadArgs = {
  drafts: RecommendationDraft[]
  squad: OptimizerPlayer[]
  forecasts: StoredForecast[]
  futureForecasts: StoredForecast[]
  futureCandidates: OptimizerPlayer[]
  bankBeforeTenths: number
  freeTransfers: number
  uncertaintyPenaltyRate?: number
  maxTransfers: number
  coverageByPlayerId?: Map<string | number, number>
}

/**
 * Prices and forecasts are held fixed for this intentionally bounded first
 * version. For each resulting squad, it compares the best legal next-deadline
 * plan with the rolled free-transfer balance against the same squad and bank
 * with the candidate's actual balance. Holding squad and bank fixed isolates
 * transfer flexibility from team quality already scored in the main horizon.
 */
export function applyOneStepLookahead(args: OneStepLookaheadArgs): RecommendationDraft[] {
  // A recommendation set deliberately contains the roll plus at most four
  // transfer alternatives.  Keep that invariant here too: evaluating an
  // arbitrary caller-provided list would multiply a full transfer search per
  // row, and returning unadjusted overflow rows could let them become primary.
  const roll = args.drafts.find(draft => draft.moves.length === 0)
  const shortlistedDrafts = [
    ...(roll ? [roll] : []),
    ...args.drafts.filter(draft => draft.moves.length > 0)
      .sort((left, right) => right.netExpectedGain - left.netExpectedGain || left.moves.length - right.moves.length || JSON.stringify(left.moves).localeCompare(JSON.stringify(right.moves)))
      .slice(0, 4),
  ]
  const futureForecastIds = new Set(args.futureForecasts.map(row => row.playerId))
  const hasForecastForSquad = (squad: OptimizerPlayer[]) => squad.every(player => futureForecastIds.has(String(player.id)))
  const unavailable = () => shortlistedDrafts.map(draft => ({ ...draft, savedTransferValue: 0, lookaheadAvailable: false, nextWeekFreeTransfers: null, nextWeekBestNetGain: null }))

  // A next-GW comparison is meaningful only if the current XI can be formed
  // from actual stored forecasts.  Candidate rows without a forecast are also
  // excluded rather than being silently treated as zero-point players.
  if (!args.futureForecasts.length || !hasForecastForSquad(args.squad)) return unavailable()
  const eligibleFutureCandidates = args.futureCandidates.filter(player => futureForecastIds.has(String(player.id)))
  if (!eligibleFutureCandidates.length) return unavailable()

  const squadAfter = (moves: TransferMove[]) => [
    ...args.squad.filter(player => !moves.some(move => String(move.outId) === String(player.id))),
    ...moves.map(move => move.incoming),
  ]
  const futurePlanCache = new Map<string, RecommendationDraft | null>()
  const bestNextWeekPlan = (nextSquad: OptimizerPlayer[], bankBeforeTenths: number, freeTransfers: number) => {
    if (!hasForecastForSquad(nextSquad)) return null
    const cacheKey = `${bankBeforeTenths}:${freeTransfers}:${nextSquad.map(player => String(player.id)).sort().join(',')}`
    if (futurePlanCache.has(cacheKey)) return futurePlanCache.get(cacheKey)!
    const plans = boundedTransferSearch({
      squad: nextSquad,
      candidates: eligibleFutureCandidates,
      forecasts: args.futureForecasts,
      bankBeforeTenths,
      freeTransfers,
      uncertaintyPenaltyRate: args.uncertaintyPenaltyRate,
      maxTransfers: args.maxTransfers,
      coverageByPlayerId: args.coverageByPlayerId,
    })
    const best = plans.reduce((best, candidate) => candidate.netExpectedGain > best.netExpectedGain ? candidate : best)
    futurePlanCache.set(cacheKey, best)
    return best
  }

  const rollNextFreeTransfers = freeTransfersAtNextDeadline(args.freeTransfers, 0)

  return shortlistedDrafts.map(draft => {
    const nextWeekFreeTransfers = freeTransfersAtNextDeadline(args.freeTransfers, draft.moves.length)
    const nextSquad = squadAfter(draft.moves)
    const future = draft.bankAfterTenths === null ? null : bestNextWeekPlan(nextSquad, draft.bankAfterTenths, nextWeekFreeTransfers)
    const futureWithRolledTransfer = draft.bankAfterTenths === null ? null : bestNextWeekPlan(nextSquad, draft.bankAfterTenths, rollNextFreeTransfers)
    if (!future || !futureWithRolledTransfer) return { ...draft, savedTransferValue: 0, lookaheadAvailable: false, nextWeekFreeTransfers: null, nextWeekBestNetGain: null }
    const savedTransferValue = Math.max(0, futureWithRolledTransfer.netExpectedGain - future.netExpectedGain)
    const adjusted = evaluateRecommendationDraft({
      squad: args.squad,
      candidateSquad: nextSquad,
      moves: draft.moves,
      forecasts: args.forecasts,
      bankBeforeTenths: args.bankBeforeTenths,
      freeTransfers: args.freeTransfers,
      uncertaintyPenaltyRate: args.uncertaintyPenaltyRate,
      coverageByPlayerId: args.coverageByPlayerId,
      savedTransferValue,
    })
    return { ...adjusted, lookaheadAvailable: true, nextWeekFreeTransfers, nextWeekBestNetGain: future.netExpectedGain }
  })
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
