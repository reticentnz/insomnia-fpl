import { describe, expect, it } from 'vitest'
import { createRecommendationSet, forecastPlayers, getRecommendationSet, planSquad, recommendationInputHash } from './recommendation-service.mjs'
import { SIMULATION_ENGINE_VERSION } from '../src/core/uncertainty.ts'

const runPlayers = [{ playerId: 'player-1', teamId: 'team-1', position: 'MID', active: true, purchasePriceTenths: 75 }]

const storedSimulationInput = (seed: string, position: 'GK' | 'DEF' | 'MID' | 'FWD', startProbability: number, substituteProbability: number, minutesIfStarting: number) => JSON.stringify({ simulationInput: {
  engineVersion: SIMULATION_ENGINE_VERSION,
  seed,
  position,
  role: { startProbability, substituteProbability, noShowProbability: 0, minutesIfStarting, minutesIfSubstitute: 18 },
  goalRate: .2,
  assistRate: .15,
  teamGoalsConcededRate: 1.2,
  saveRate: position === 'GK' ? 3 : 0,
  yellowCardRate: .1,
  redCardRate: .005,
  penaltySaveRate: 0,
  penaltyMissRate: .01,
  ownGoalRate: .002,
  defensiveActionRate: 8,
  bonusRate: .3,
  samples: 200,
} })

function database({ officialSellingPrice = null, latestOfficialSellingPrice = officialSellingPrice, assumedSellingPrice = null }: { officialSellingPrice?: number | null; latestOfficialSellingPrice?: number | null; assumedSellingPrice?: number | null }) {
  return {
    async query(sql: string) {
      if (sql.includes('FROM "PlanPlayer"')) return { rows: [{ player_id: 'player-1', inherited_selling_price_tenths: null, planned_purchase_price_tenths: 70, locked: 0, bank_tenths: 5, free_transfers: 1, manager_account_id: 'manager-1', official_squad_snapshot_id: 'snapshot-1', gameweek_id: 'gw-1' }] }
      if (sql.includes('JOIN "OfficialSquadSnapshot"')) return { rows: [{ player_id: 'player-1', selling_price_tenths: latestOfficialSellingPrice }] }
      if (sql.includes('FROM "OfficialSquadPlayer"')) return { rows: [{ player_id: 'player-1', selling_price_tenths: officialSellingPrice }] }
      if (sql.includes('FROM "ManagerAssumption"')) return { rows: assumedSellingPrice === null ? [] : [{ value_json: JSON.stringify({ playerId: 'player-1', sellingPriceTenths: assumedSellingPrice }) }] }
      throw new Error(`Unexpected query: ${sql}`)
    },
  }
}

describe('recommendation plan economics', () => {
  it('keeps official-owned selling economics unknown instead of substituting purchase price', async () => {
    const result = await planSquad(database({}), 'plan-1', runPlayers)
    expect(result.squad[0].sellingPriceTenths).toBeNull()
  })

  it('uses a user-confirmed selling price only when the official source omitted it', async () => {
    const assumed = await planSquad(database({ assumedSellingPrice: 72 }), 'plan-1', runPlayers)
    const official = await planSquad(database({ officialSellingPrice: 74, assumedSellingPrice: 72 }), 'plan-1', runPlayers)
    expect(assumed.squad[0].sellingPriceTenths).toBe(72)
    expect(official.squad[0].sellingPriceTenths).toBe(74)
  })

  it('uses a newly backfilled current snapshot for an older active plan', async () => {
    const result = await planSquad(database({ officialSellingPrice: null, latestOfficialSellingPrice: 73 }), 'plan-1', runPlayers)
    expect(result.squad[0].sellingPriceTenths).toBe(73)
    expect(result.exactSellingPrices).toBe(true)
  })
})

describe('recommendation forecast metadata', () => {
  it('versions recommendation caches independently from immutable forecast inputs', () => {
    expect(recommendationInputHash('forecast-input')).toMatch(/^[a-f0-9]{64}$/)
    expect(recommendationInputHash('forecast-input')).not.toBe('forecast-input')
    expect(recommendationInputHash('forecast-input')).toBe(recommendationInputHash('forecast-input'))
  })

  it('preserves current-event transfer activity through player-gameweek aggregation', async () => {
    const db = { async query() { return { rows: [{
      player_id: 'player-1', fixture_id: 'fixture-1', forecast_run_id: 'run-1', mean_points: 5, standard_deviation: 1,
      p10_points: 3, p50_points: 5, p90_points: 7, start_probability: .9, substitute_probability: .1,
      no_show_probability: 0, expected_minutes: 82, goal_points: 1, assist_points: 1, clean_sheet_points: 1,
      goals_conceded_points: 0, save_points: 0, penalty_points: 0, defensive_contribution_points: 0,
      bonus_points: 1, card_points: 0, role_source_json: storedSimulationInput('run-1:player-1:fixture-1', 'MID', .9, .1, 82),
      model_version: 'role-aware-v2.6-early-sample', fpl_id: 10, position: 'MID', team_id: 'team-1', active: 1,
      price_tenths: 75, transfers_in_event: 54_321, transfers_out_event: 12_345, gameweek_id: 'gw-1', gameweek_fpl_id: 1,
    }] } } }

    const [player] = await forecastPlayers(db, 'run-1', 1, { aggregate: false })
    expect(player).toMatchObject({ currentPriceTenths: 75, transfersIn: 54_321, transfersOut: 12_345, transferWindow: 'EVENT' })
  })
})

describe('stored recommendation retrieval', () => {
  const storedSet = { id: 'set-1', plan_id: 'plan-1', forecast_run_id: 'run-1', horizon: 3, max_transfers: 2, chip: null, uncertainty_penalty_rate: .15, created_at: '2026-08-11T00:00:00Z', status: 'SUCCEEDED', primary_candidate_id: 'candidate-1', input_hash: recommendationInputHash('forecast-input') }
  const storedCandidate = { id: 'candidate-1', rank: 1, action: 'TRANSFER', moves_json: JSON.stringify({ moves: [{ outId: 'player-out', inId: 'player-in' }], sensitivity: { earlySeasonSensitive: true, roleLatestMatchSensitive: true, latestMatchSensitive: true, latestMatchSensitivity: 'HIGH', sensitivityFlags: ['EARLY_SEASON', 'LATEST_MATCH_SENSITIVE', 'RATE_SAMPLE_LATEST_MATCH_SENSITIVE'] }, priceTiming: { verdict: 'WAIT', robustness: 'SENSITIVE', incomingPressure: { description: 'High upward price pressure; this is not a price-rise prediction.' }, outgoingPressure: { description: 'Moderate downward price pressure; this is not a price-fall prediction.' }, adverseScenarios: [{ adverseSwingTenths: 1, status: 'UNAFFORDABLE' }], reasons: ['Price pressure cannot create urgency because this recommendation is not independently robust.'] } }), raw_gain: 6, hit_cost: 0, uncertainty_penalty: 1, net_expected_gain: 5, probability_beats_roll: .7, bank_after_tenths: 3, affordability_status: 'EXACT', expected_team_points: 100, p10_points: 85, p50_points: 100, p90_points: 115 }

  it('hydrates the stable public shape and FPL identifiers from stored rows', async () => {
    const db = { async query(sql: string) {
      if (sql.includes('FROM "RecommendationSet"')) return { rows: [storedSet] }
      if (sql.includes('FROM "RecommendationCandidate"')) return { rows: [storedCandidate] }
      if (sql.includes('FROM "Player"')) return { rows: [{ id: 'player-out', fpl_id: 10 }, { id: 'player-in', fpl_id: 20 }] }
      throw new Error(`Unexpected query: ${sql}`)
    } }
    const result = await getRecommendationSet(db, 'set-1')
    expect(result?.planId).toBe('plan-1')
    expect(result?.candidates[0]).toMatchObject({ netExpectedGain: 5, apiMoves: [{ outId: 10, inId: 20 }], savedTransferValue: 0, lookaheadAvailable: false, nextWeekFreeTransfers: null, nextWeekBestNetGain: null, earlySeasonSensitive: true, roleLatestMatchSensitive: true, latestMatchSensitivity: 'HIGH', sensitivityFlags: ['EARLY_SEASON', 'LATEST_MATCH_SENSITIVE', 'RATE_SAMPLE_LATEST_MATCH_SENSITIVE'], timingAdvice: 'WAIT', priceTiming: { verdict: 'WAIT', robustness: 'SENSITIVE', adverseScenarios: [{ adverseSwingTenths: 1, status: 'UNAFFORDABLE' }] } })
  })

  it('returns an identical stored request before loading forecasts or optimizing', async () => {
    const queries: string[] = []
    const db = { async query(sql: string, params: unknown[] = []) {
      queries.push(sql)
      if (sql.includes('FROM "ForecastRun"')) return { rows: [{ id: 'run-1', input_hash: 'forecast-input' }] }
      if (sql.startsWith('SELECT "id" FROM "RecommendationSet"')) return { rows: params[6] === storedSet.input_hash ? [{ id: 'set-1' }] : [] }
      if (sql.includes('SELECT * FROM "RecommendationSet"')) return { rows: [storedSet] }
      if (sql.includes('FROM "RecommendationCandidate"')) return { rows: [storedCandidate] }
      if (sql.includes('FROM "Player"')) return { rows: [{ id: 'player-out', fpl_id: 10 }, { id: 'player-in', fpl_id: 20 }] }
      throw new Error(`Unexpected query: ${sql}`)
    } }
    const result = await createRecommendationSet(db, { planId: 'plan-1', forecastRunId: 'run-1', horizon: 3, maxTransfers: 2 })
    expect(result.cacheStatus).toBe('HIT')
    expect(queries.some(sql => sql.includes('PlayerFixtureForecast'))).toBe(false)
  })

  it('aggregates DGW fixture rows into single player-gameweek streams and produces exact chip quantile gains', async () => {
    const squadPositions = ['GK', 'GK', 'DEF', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'MID', 'MID', 'FWD', 'FWD', 'FWD']
    const planPlayers = squadPositions.map((pos, i) => ({ player_id: `p-${i}`, inherited_selling_price_tenths: null, planned_purchase_price_tenths: 50, locked: 0, bank_tenths: 0, free_transfers: 1, manager_account_id: 'm-1', official_squad_snapshot_id: 's-1', gameweek_id: 'gw-1', squad_slot: i + 1 }))
    const officialPlayers = planPlayers.map(p => ({ player_id: p.player_id, selling_price_tenths: 50 }))

    // p-0 to p-14 forecasts, with p-7 having 2 fixtures in gw-1 (DGW)
    const forecastRows = planPlayers.map((p, i) => ({
      player_id: p.player_id,
      fixture_id: `fix-${i}-1`,
      forecast_run_id: 'run-dgw',
      mean_points: 4 + i * 0.2,
      standard_deviation: 1.5,
      p10_points: 2,
      p50_points: 4,
      p90_points: 6,
      start_probability: 0.9,
      substitute_probability: 0.1,
      no_show_probability: 0,
      expected_minutes: 85,
      goal_points: 1,
      assist_points: 0.5,
      clean_sheet_points: 0.5,
      goals_conceded_points: -0.5,
      save_points: 0,
      penalty_points: 0,
      defensive_contribution_points: 0,
      bonus_points: 0.5,
      card_points: -0.1,
      model_version: 'role-aware-v2.3',
      fpl_id: 100 + i,
      position: squadPositions[i],
      team_id: `team-${i}`,
      active: 1,
      price_tenths: 50,
      gameweek_id: 'gw-1',
      gameweek_fpl_id: 1,
      role_source_json: storedSimulationInput(`run-dgw:${p.player_id}:fix-${i}-1`, squadPositions[i], 0.9, 0.1, 85),
    }))

    // Add 2nd fixture for p-7 in gw-1 (DGW)
    forecastRows.push({
      player_id: 'p-7',
      fixture_id: 'fix-7-2',
      forecast_run_id: 'run-dgw',
      mean_points: 5.0,
      standard_deviation: 1.8,
      p10_points: 2,
      p50_points: 5,
      p90_points: 8,
      start_probability: 0.85,
      substitute_probability: 0.15,
      no_show_probability: 0,
      expected_minutes: 80,
      goal_points: 1.5,
      assist_points: 0.8,
      clean_sheet_points: 0.5,
      goals_conceded_points: -0.5,
      save_points: 0,
      penalty_points: 0,
      defensive_contribution_points: 0,
      bonus_points: 0.8,
      card_points: -0.1,
      model_version: 'role-aware-v2.3',
      fpl_id: 107,
      position: 'MID',
      team_id: 'team-7',
      active: 1,
      price_tenths: 50,
      gameweek_id: 'gw-1',
      gameweek_fpl_id: 1,
      role_source_json: storedSimulationInput('run-dgw:p-7:fix-7-2', 'MID', 0.85, 0.15, 80),
    })

    const insertedSets: any[] = []
    const insertedCandidates: any[] = []

    const db = {
      async query(sql: string, params: any[] = []) {
        if (sql.includes('FROM "ForecastRun"')) return { rows: [{ id: 'run-dgw', input_hash: 'dgw-hash' }] }
        if (sql.startsWith('SELECT "id" FROM "RecommendationSet"')) return { rows: [] }
        if (sql.includes('FROM "PlayerFixtureForecast"')) return { rows: forecastRows }
        if (sql.includes('FROM "PlanPlayer"')) return { rows: planPlayers }
        if (sql.includes('FROM "OfficialSquadPlayer"')) return { rows: officialPlayers }
        if (sql.includes('FROM "ManagerAssumption"')) return { rows: [] }
        if (sql.includes('INSERT INTO "RecommendationSet"')) {
          insertedSets.push(params)
          return { rows: [] }
        }
        if (sql.includes('INSERT INTO "RecommendationCandidate"')) {
          insertedCandidates.push(params)
          return { rows: [] }
        }
        if (sql.includes('UPDATE "RecommendationSet"')) return { rows: [] }
        if (sql.includes('BEGIN') || sql.includes('COMMIT')) return { rows: [] }
        if (sql.includes('SELECT * FROM "RecommendationSet"')) {
          return { rows: [{ id: insertedSets[0]?.[0] || 'set-new', plan_id: 'plan-1', forecast_run_id: 'run-dgw', horizon: 1, max_transfers: 0, chip: 'TRIPLE_CAPTAIN', status: 'SUCCEEDED' }] }
        }
        if (sql.includes('SELECT * FROM "RecommendationCandidate"')) {
          return { rows: insertedCandidates.map((c, idx) => ({ id: c[0], rank: idx + 1, action: c[3], moves_json: c[4], raw_gain: c[5], hit_cost: c[6], net_expected_gain: c[8], expected_team_points: c[12], p10_points: c[13], p50_points: c[14], p90_points: c[15] })) }
        }
        if (sql.includes('FROM "Player"')) return { rows: planPlayers.map(p => ({ id: p.player_id, fpl_id: Number(p.player_id.replace('p-', '')) + 100 })) }
        throw new Error(`Unexpected query: ${sql}`)
      },
    }

    const result = await createRecommendationSet(db, { planId: 'plan-1', forecastRunId: 'run-dgw', horizon: 1, chip: 'TRIPLE_CAPTAIN' })
    expect(result.cacheStatus).toBe('MISS')
    expect(result.candidates[0].action).toBe('CHIP')
    expect(result.candidates[0].p90Points).toBeDefined()
    expect(result.candidates[0].p10Points).toBeDefined()
    expect(result.candidates[0].p90Points).toBeGreaterThan(result.candidates[0].p10Points!)
  })
})
