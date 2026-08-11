import { describe, expect, it } from 'vitest'
import { createRecommendationSet, getRecommendationSet, planSquad } from './recommendation-service.mjs'

const runPlayers = [{ playerId: 'player-1', teamId: 'team-1', position: 'MID', active: true, purchasePriceTenths: 75 }]

function database({ officialSellingPrice = null, assumedSellingPrice = null }: { officialSellingPrice?: number | null; assumedSellingPrice?: number | null }) {
  return {
    async query(sql: string) {
      if (sql.includes('FROM "PlanPlayer"')) return { rows: [{ player_id: 'player-1', inherited_selling_price_tenths: null, planned_purchase_price_tenths: 70, locked: 0, bank_tenths: 5, free_transfers: 1, manager_account_id: 'manager-1', official_squad_snapshot_id: 'snapshot-1', gameweek_id: 'gw-1' }] }
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
})

describe('stored recommendation retrieval', () => {
  const storedSet = { id: 'set-1', plan_id: 'plan-1', forecast_run_id: 'run-1', horizon: 3, max_transfers: 2, chip: null, uncertainty_penalty_rate: .15, created_at: '2026-08-11T00:00:00Z', status: 'SUCCEEDED', primary_candidate_id: 'candidate-1', input_hash: 'forecast-input' }
  const storedCandidate = { id: 'candidate-1', rank: 1, action: 'TRANSFER', moves_json: JSON.stringify({ moves: [{ outId: 'player-out', inId: 'player-in' }] }), raw_gain: 6, hit_cost: 0, uncertainty_penalty: 1, net_expected_gain: 5, probability_beats_roll: .7, bank_after_tenths: 3, affordability_status: 'EXACT', expected_team_points: 100, p10_points: 85, p50_points: 100, p90_points: 115 }

  it('hydrates the stable public shape and FPL identifiers from stored rows', async () => {
    const db = { async query(sql: string) {
      if (sql.includes('FROM "RecommendationSet"')) return { rows: [storedSet] }
      if (sql.includes('FROM "RecommendationCandidate"')) return { rows: [storedCandidate] }
      if (sql.includes('FROM "Player"')) return { rows: [{ id: 'player-out', fpl_id: 10 }, { id: 'player-in', fpl_id: 20 }] }
      throw new Error(`Unexpected query: ${sql}`)
    } }
    const result = await getRecommendationSet(db, 'set-1')
    expect(result?.planId).toBe('plan-1')
    expect(result?.candidates[0]).toMatchObject({ netExpectedGain: 5, apiMoves: [{ outId: 10, inId: 20 }] })
  })

  it('returns an identical stored request before loading forecasts or optimizing', async () => {
    const queries: string[] = []
    const db = { async query(sql: string) {
      queries.push(sql)
      if (sql.includes('FROM "ForecastRun"')) return { rows: [{ id: 'run-1', input_hash: 'forecast-input' }] }
      if (sql.startsWith('SELECT "id" FROM "RecommendationSet"')) return { rows: [{ id: 'set-1' }] }
      if (sql.includes('SELECT * FROM "RecommendationSet"')) return { rows: [storedSet] }
      if (sql.includes('FROM "RecommendationCandidate"')) return { rows: [storedCandidate] }
      if (sql.includes('FROM "Player"')) return { rows: [{ id: 'player-out', fpl_id: 10 }, { id: 'player-in', fpl_id: 20 }] }
      throw new Error(`Unexpected query: ${sql}`)
    } }
    const result = await createRecommendationSet(db, { planId: 'plan-1', forecastRunId: 'run-1', horizon: 3, maxTransfers: 2 })
    expect(result.cacheStatus).toBe('HIT')
    expect(queries.some(sql => sql.includes('PlayerFixtureForecast'))).toBe(false)
  })
})
