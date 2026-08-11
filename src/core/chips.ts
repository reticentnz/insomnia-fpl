import { selectLineup, type Lineup, type StoredForecast } from './lineup.ts'
import { evaluateSimultaneousTransfers, type EconomicsPlayer } from './transfers.ts'

export type Chip = 'TC' | 'BB' | 'FH' | 'WC'
export type ChipEstimate = {
  chip: Chip
  available: boolean
  reason?: string
  baseline: Lineup
  expectedPoints?: number
  gain?: number
  p10Gain?: number
  p50Gain?: number
  p90Gain?: number
  captainId?: string | null
  squadIds?: string[]
}
export type ChipPlayer = EconomicsPlayer & { locked?: boolean }

const sum = (rows: StoredForecast[], key: 'meanPoints' | 'p10Points' | 'p50Points' | 'p90Points') => rows.reduce((total, row) => total + row[key], 0)
const unavailable = (chip: Chip, baseline: Lineup, reason: string): ChipEstimate => ({ chip, available: false, reason, baseline })

/**
 * Evaluates chips as explicit counterfactuals against the supplied no-chip XI.
 * It intentionally returns unavailable rather than manufacture an estimate when
 * a squad optimiser cannot prove a legal alternative.
 */
export function evaluateChipCounterfactual(args: {
  chip: Chip
  baselineSquad: ChipPlayer[]
  candidatePool: ChipPlayer[]
  forecasts: StoredForecast[]
  bankBeforeTenths: number | null
  targetGameweekId: string
  horizonGameweekIds: string[]
}): ChipEstimate {
  const target = args.forecasts.filter(row => row.gameweekId === args.targetGameweekId)
  const baselineRows = target.filter(row => args.baselineSquad.some(player => String(player.id) === row.playerId))
  const baseline = selectLineup(baselineRows)
  if (baseline.starters.length !== 11) return unavailable(args.chip, baseline, 'Required baseline forecasts are absent')
  if (args.chip === 'TC') {
    const captain = baselineRows.find(row => row.playerId === baseline.captainId)
    if (!captain) return unavailable('TC', baseline, 'A captain forecast is required')
    return { chip: 'TC', available: true, baseline, captainId: captain.playerId, expectedPoints: baseline.expectedPoints + captain.meanPoints, gain: captain.meanPoints, p10Gain: captain.p10Points, p50Gain: captain.p50Points, p90Gain: captain.p90Points }
  }
  if (args.chip === 'BB') {
    const bench = baselineRows.filter(row => baseline.bench.includes(row.playerId))
    if (bench.length !== 4) return unavailable('BB', baseline, 'All four bench forecasts are required')
    return { chip: 'BB', available: true, baseline, expectedPoints: baseline.expectedPoints + sum(bench, 'meanPoints'), gain: sum(bench, 'meanPoints'), p10Gain: sum(bench, 'p10Points'), p50Gain: sum(bench, 'p50Points'), p90Gain: sum(bench, 'p90Points') }
  }
  if (args.bankBeforeTenths === null) return unavailable(args.chip, baseline, 'Exact squad economics are required')
  const permanent = args.chip === 'WC'
  const weeks = permanent ? args.horizonGameweekIds : [args.targetGameweekId]
  const optimisation = optimiseLegalSquad({ baselineSquad: args.baselineSquad, candidatePool: args.candidatePool, forecasts: args.forecasts, gameweekIds: weeks, bankBeforeTenths: args.bankBeforeTenths })
  if (!optimisation) return unavailable(args.chip, baseline, 'No legal optimised squad could be calculated from the available forecasts')
  const changedTarget = selectLineup(target.filter(row => optimisation.squad.some(player => String(player.id) === row.playerId)))
  if (changedTarget.starters.length !== 11) return unavailable(args.chip, baseline, 'Optimised squad has incomplete target forecasts')
  // FH uses this changed squad only for target. WC's objective and comparison
  // are both over the same selected horizon, so the squad persists by design.
  const baselineTotal = weeks.reduce((total, gameweekId) => total + selectLineup(args.forecasts.filter(row => row.gameweekId === gameweekId && args.baselineSquad.some(player => String(player.id) === row.playerId))).expectedPoints, 0)
  const expectedTotal = weeks.reduce((total, gameweekId) => total + selectLineup(args.forecasts.filter(row => row.gameweekId === gameweekId && optimisation.squad.some(player => String(player.id) === row.playerId))).expectedPoints, 0)
  const quantileGain = (key: 'p10Points' | 'p50Points' | 'p90Points') => weeks.reduce((total, gameweekId) => {
    const changed = selectLineup(args.forecasts.filter(row => row.gameweekId === gameweekId && optimisation.squad.some(player => String(player.id) === row.playerId)))
    const unchanged = selectLineup(args.forecasts.filter(row => row.gameweekId === gameweekId && args.baselineSquad.some(player => String(player.id) === row.playerId)))
    return total + changed[key] - unchanged[key]
  }, 0)
  return { chip: args.chip, available: true, baseline, expectedPoints: expectedTotal, gain: expectedTotal - baselineTotal, p10Gain: quantileGain('p10Points'), p50Gain: quantileGain('p50Points'), p90Gain: quantileGain('p90Points'), squadIds: optimisation.squad.map(player => String(player.id)) }
}

function optimiseLegalSquad(args: { baselineSquad: ChipPlayer[]; candidatePool: ChipPlayer[]; forecasts: StoredForecast[]; gameweekIds: string[]; bankBeforeTenths: number }): { squad: ChipPlayer[] } | null {
  const required = { GK: 2, DEF: 5, MID: 5, FWD: 3 } as const
  const baselineById = new Map(args.baselineSquad.map(player => [String(player.id), player]))
  if (args.baselineSquad.some(player => player.sellingPriceTenths == null)) return null
  const purchasingPower = args.bankBeforeTenths + args.baselineSquad.reduce((total, player) => total + Number(player.sellingPriceTenths), 0)
  const forecastScore = new Map<string, number>()
  for (const forecast of args.forecasts) if (args.gameweekIds.includes(forecast.gameweekId)) forecastScore.set(forecast.playerId, (forecastScore.get(forecast.playerId) || 0) + forecast.meanPoints)
  const distinct = [...new Map(args.candidatePool.filter(player => player.active !== false && forecastScore.has(String(player.id))).map(player => [String(player.id), player])).values()]
  const locked = args.baselineSquad.filter(player => player.locked)
  if (locked.some(player => !distinct.some(candidate => String(candidate.id) === String(player.id)))) return null
  const effectiveCost = (player: ChipPlayer) => baselineById.has(String(player.id)) ? player.sellingPriceTenths : player.purchasePriceTenths
  if (locked.some(player => effectiveCost(player) == null)) return null

  type State = { squad: ChipPlayer[]; clubs: Map<string, number>; cost: number; proxyScore: number; nextIndex: number }
  let states: State[] = [{
    squad: [...locked], clubs: new Map(),
    cost: locked.reduce((total, player) => total + Number(effectiveCost(player)), 0),
    proxyScore: locked.reduce((total, player) => total + Number(forecastScore.get(String(player.id)) || 0), 0), nextIndex: 0,
  }]
  for (const player of locked) states[0].clubs.set(player.club, (states[0].clubs.get(player.club) || 0) + 1)

  const beamWidth = 4000
  const shortlistSize = 35
  for (const position of Object.keys(required) as Array<keyof typeof required>) {
    const fixed = locked.filter(player => player.position === position).length
    if (fixed > required[position]) return null
    const positionPool = distinct
      .filter(player => player.position === position && !locked.some(item => String(item.id) === String(player.id)) && effectiveCost(player) != null)
      .sort((left, right) => (forecastScore.get(String(right.id)) || 0) - (forecastScore.get(String(left.id)) || 0) || String(left.id).localeCompare(String(right.id)))
    const baselinePositionPlayers = args.baselineSquad.filter(player => player.position === position && !locked.some(item => String(item.id) === String(player.id)))
    const pool = [...new Map([...positionPool.slice(0, shortlistSize), ...baselinePositionPlayers].map(player => [String(player.id), player])).values()]
    states = states.map(state => ({ ...state, nextIndex: 0 }))
    for (let slot = fixed; slot < required[position]; slot += 1) {
      const expanded: State[] = []
      for (const state of states) for (let index = state.nextIndex; index < pool.length; index += 1) {
        const player = pool[index]
        if (state.squad.some(selected => String(selected.id) === String(player.id))) continue
        if ((state.clubs.get(player.club) || 0) >= 3) continue
        const cost = state.cost + Number(effectiveCost(player))
        if (cost > purchasingPower) continue
        const clubs = new Map(state.clubs); clubs.set(player.club, (clubs.get(player.club) || 0) + 1)
        expanded.push({ squad: [...state.squad, player], clubs, cost, proxyScore: state.proxyScore + Number(forecastScore.get(String(player.id)) || 0), nextIndex: index + 1 })
      }
      states = expanded.sort((left, right) => right.proxyScore - left.proxyScore || left.cost - right.cost).slice(0, beamWidth)
      if (!states.length) return null
    }
  }

  let best: ChipPlayer[] | null = null, bestScore = -Infinity
  for (const state of states) {
    const squad = state.squad
    if (squad.length !== 15) continue
    const moves = (['GK', 'DEF', 'MID', 'FWD'] as const).flatMap(position => {
      const outgoing = args.baselineSquad.filter(player => player.position === position && !squad.some(next => String(next.id) === String(player.id)))
      const incoming = squad.filter(player => player.position === position && !args.baselineSquad.some(base => String(base.id) === String(player.id)))
      return outgoing.map((player, index) => ({ outId: player.id, incoming: incoming[index]! }))
    })
    // Build an exact same-position map; non-matching changes cannot be legal.
    if (moves.some(move => !move.incoming) || new Set(moves.map(move => String(move.incoming.id))).size !== moves.length) continue
    const legality = evaluateSimultaneousTransfers({ squad: args.baselineSquad, moves, bankBeforeTenths: args.bankBeforeTenths, freeTransfers: moves.length })
    if (!legality.legal) continue
    const score = args.gameweekIds.reduce((total, gameweekId) => total + selectLineup(args.forecasts.filter(row => row.gameweekId === gameweekId && squad.some(player => String(player.id) === row.playerId))).expectedPoints, 0)
    if (score > bestScore) { best = squad; bestScore = score }
  }
  return best ? { squad: best } : null
}
