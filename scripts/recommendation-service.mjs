import { randomUUID } from 'node:crypto'
import { canonicalJson } from './feed-run.mjs'
import { boundedTransferSearch } from '../src/core/optimizer.ts'
import { evaluateChipCounterfactual } from '../src/core/chips.ts'

import { combineSampleStreams, simulateFromStoredForecast, summarizeSampleDistribution } from '../src/core/uncertainty.ts'

const parse = value => { try { return JSON.parse(value || '{}') } catch { return {} } }
const asNumber = value => value == null ? null : Number(value)

async function forecastPlayers(db, forecastRunId, horizon, { aggregate = true } = {}) {
  const rows = await db.query(
    `SELECT forecast."player_id", forecast."fixture_id", forecast."forecast_run_id",
      forecast."mean_points", forecast."standard_deviation", forecast."p10_points", forecast."p50_points", forecast."p90_points",
      forecast."start_probability", forecast."substitute_probability", forecast."no_show_probability",
      forecast."expected_minutes", forecast."goal_points", forecast."assist_points", forecast."clean_sheet_points",
      forecast."goals_conceded_points", forecast."save_points", forecast."penalty_points", forecast."defensive_contribution_points",
      forecast."bonus_points", forecast."card_points", forecast."role_source_json", run."model_version",
      player."fpl_id", player_observation."position", player_observation."team_id", player_observation."active", player_observation."price_tenths",
      fixture_observation."gameweek_id", gameweek."fpl_id" AS gameweek_fpl_id
     FROM "PlayerFixtureForecast" forecast
     JOIN "ForecastRun" run ON run."id"=forecast."forecast_run_id"
     JOIN "Player" player ON player."id"=forecast."player_id"
     JOIN "FixtureObservation" fixture_observation ON fixture_observation."fixture_id"=forecast."fixture_id"
     JOIN "Gameweek" gameweek ON gameweek."id"=fixture_observation."gameweek_id"
     JOIN "PlayerObservation" player_observation ON player_observation."player_id"=forecast."player_id"
     WHERE forecast."forecast_run_id"=$1
       AND fixture_observation."gameweek_id" IS NOT NULL
       AND datetime(fixture_observation."observed_at") <= datetime(run."as_of")
       AND NOT EXISTS (SELECT 1 FROM "FixtureObservation" newer WHERE newer."fixture_id"=fixture_observation."fixture_id" AND datetime(newer."observed_at") <= datetime(run."as_of") AND (datetime(newer."observed_at") > datetime(fixture_observation."observed_at") OR (newer."observed_at"=fixture_observation."observed_at" AND newer."id">fixture_observation."id")))
       AND datetime(player_observation."observed_at") <= datetime(run."as_of")
       AND NOT EXISTS (SELECT 1 FROM "PlayerObservation" newer_player WHERE newer_player."player_id"=player_observation."player_id" AND datetime(newer_player."observed_at") <= datetime(run."as_of") AND (datetime(newer_player."observed_at") > datetime(player_observation."observed_at") OR (newer_player."observed_at"=player_observation."observed_at" AND newer_player."id">player_observation."id")))
     ORDER BY gameweek."fpl_id", forecast."player_id"`, [forecastRunId])
  const gameweeks = [...new Set(rows.rows.map(row => row.gameweek_id))].slice(0, horizon)
  const allowed = new Set(gameweeks)
  const selectedRows = rows.rows.filter(row => allowed.has(row.gameweek_id))

  const simulatedRows = selectedRows.map(row => {
    const sim = simulateFromStoredForecast(row)
    return { ...row, _sim: sim }
  })

  if (!aggregate) {
    const byPlayerGw = new Map()
    for (const row of simulatedRows) {
      const key = `${row.player_id}:${row.gameweek_id}`
      const prev = byPlayerGw.get(key) || {
        playerId: String(row.player_id),
        fplId: Number(row.fpl_id),
        gameweekId: String(row.gameweek_id),
        position: row.position,
        teamId: row.team_id,
        active: Boolean(row.active),
        purchasePriceTenths: asNumber(row.price_tenths),
        startProbabilities: [],
        noShowProbabilities: [],
        meanPoints: 0,
        variance: 0,
        streams: [],
        minuteStreams: [],
        samplesAvailable: true,
      }
      prev.startProbabilities.push(Number(row.start_probability))
      prev.noShowProbabilities.push(Number(row.no_show_probability))
      prev.meanPoints += Number(row.mean_points)
      prev.variance += Number(row.standard_deviation) ** 2
      if (row._sim) {
        prev.streams.push(row._sim.samples)
        if (row._sim.minuteSamples) prev.minuteStreams.push(row._sim.minuteSamples)
      } else prev.samplesAvailable = false
      byPlayerGw.set(key, prev)
    }
    return [...byPlayerGw.values()].map(item => {
      const combinedSamples = item.samplesAvailable ? combineSampleStreams(item.streams) : undefined
      const combinedMinutes = item.samplesAvailable && item.minuteStreams.length ? combineSampleStreams(item.minuteStreams) : undefined
      const standardDeviation = Math.sqrt(item.variance)
      const percentileDistance = 1.2815515655446004 * standardDeviation
      const summary = combinedSamples ? summarizeSampleDistribution(combinedSamples, combinedMinutes) : { mean: item.meanPoints, standardDeviation, p10: item.meanPoints - percentileDistance, p50: item.meanPoints, p90: item.meanPoints + percentileDistance }
      const startProbability = 1 - item.startProbabilities.reduce((acc, p) => acc * (1 - p), 1)
      const noShowProbability = item.noShowProbabilities.reduce((acc, p) => acc * p, 1)
      return {
        playerId: item.playerId,
        fplId: item.fplId,
        gameweekId: item.gameweekId,
        position: item.position,
        teamId: item.teamId,
        active: item.active,
        purchasePriceTenths: item.purchasePriceTenths,
        meanPoints: summary.mean,
        standardDeviation: summary.standardDeviation,
        p10Points: summary.p10,
        p50Points: summary.p50,
        p90Points: summary.p90,
        startProbability,
        noShowProbability,
        samples: combinedSamples,
        minuteSamples: combinedMinutes,
      }
    })
  }

  const byPlayer = new Map()
  for (const row of simulatedRows) {
    const id = String(row.player_id)
    const prev = byPlayer.get(id) || {
      playerId: id,
      fplId: Number(row.fpl_id),
      gameweekId: 'horizon',
      position: row.position,
      teamId: row.team_id,
      active: Boolean(row.active),
      purchasePriceTenths: asNumber(row.price_tenths),
      startProbabilities: [],
        noShowProbabilities: [],
      meanPoints: 0,
      variance: 0,
      streams: [],
      minuteStreams: [],
      samplesAvailable: true,
    }
    prev.startProbabilities.push(Number(row.start_probability))
    prev.noShowProbabilities.push(Number(row.no_show_probability))
    prev.meanPoints += Number(row.mean_points)
    prev.variance += Number(row.standard_deviation) ** 2
    if (row._sim) {
      prev.streams.push(row._sim.samples)
      if (row._sim.minuteSamples) prev.minuteStreams.push(row._sim.minuteSamples)
    } else prev.samplesAvailable = false
    byPlayer.set(id, prev)
  }
  return [...byPlayer.values()].map(item => {
    const combinedSamples = item.samplesAvailable ? combineSampleStreams(item.streams) : undefined
    const combinedMinutes = item.samplesAvailable && item.minuteStreams.length ? combineSampleStreams(item.minuteStreams) : undefined
    const standardDeviation = Math.sqrt(item.variance)
    const percentileDistance = 1.2815515655446004 * standardDeviation
    const summary = combinedSamples ? summarizeSampleDistribution(combinedSamples, combinedMinutes) : { mean: item.meanPoints, standardDeviation, p10: item.meanPoints - percentileDistance, p50: item.meanPoints, p90: item.meanPoints + percentileDistance }
    const startProbability = 1 - item.startProbabilities.reduce((acc, p) => acc * (1 - p), 1)
    const noShowProbability = item.noShowProbabilities.reduce((acc, p) => acc * p, 1)
    return {
      playerId: item.playerId,
      fplId: item.fplId,
      gameweekId: item.gameweekId,
      position: item.position,
      teamId: item.teamId,
      active: item.active,
      purchasePriceTenths: item.purchasePriceTenths,
      meanPoints: summary.mean,
      standardDeviation: summary.standardDeviation,
      p10Points: summary.p10,
      p50Points: summary.p50,
      p90Points: summary.p90,
      startProbability,
      noShowProbability,
      samples: combinedSamples,
      minuteSamples: combinedMinutes,
    }
  })
}

function recommendationSetIdentityQuery(requireVerified = false) {
  return `SELECT "id" FROM "RecommendationSet"
    WHERE "plan_id"=$1 AND "forecast_run_id"=$2 AND "horizon"=$3 AND "max_transfers"=$4
      AND COALESCE("chip", '')=COALESCE($5, '') AND "uncertainty_penalty_rate"=$6 AND "input_hash"=$7
      AND COALESCE("league_id", 0)=COALESCE($8, 0)
      ${requireVerified ? 'AND "free_transfers_confirmed"=1 AND "exact_selling_prices"=1 AND "status"=\'SUCCEEDED\'' : 'AND "free_transfers_confirmed"=$9 AND "exact_selling_prices"=$10 AND "status" IN (\'SUCCEEDED\',\'INSUFFICIENT_DATA\')'}
    ORDER BY datetime("created_at") DESC,"id" DESC LIMIT 1`
}

export async function planSquad(db, planId, runPlayers) {
  const rows = await db.query(`SELECT plan_player.*, plan."bank_tenths", plan."free_transfers", plan."manager_account_id", plan."official_squad_snapshot_id", snapshot."gameweek_id"
    FROM "PlanPlayer" plan_player
    JOIN "Plan" plan ON plan."id"=plan_player."plan_id"
    JOIN "OfficialSquadSnapshot" snapshot ON snapshot."id"=plan."official_squad_snapshot_id"
    WHERE plan_player."plan_id"=$1 ORDER BY plan_player."squad_slot"`, [planId])
  if (!rows.rows.length) throw new Error(`Plan ${planId} has no players`)
  const official = await db.query(`SELECT "player_id", "selling_price_tenths" FROM "OfficialSquadPlayer" WHERE "squad_snapshot_id"=$1`, [rows.rows[0].official_squad_snapshot_id])
  const officialByPlayer = new Map(official.rows.map(row => [String(row.player_id), row.selling_price_tenths === null ? null : Number(row.selling_price_tenths)]))
  const assumptions = await db.query(`SELECT "value_json" FROM "ManagerAssumption" WHERE "manager_account_id"=$1 AND "gameweek_id"=$2 AND "kind"='SELLING_PRICE' ORDER BY "created_at" ASC, "id" ASC`, [rows.rows[0].manager_account_id, rows.rows[0].gameweek_id])
  const freeTransferAssumption = await db.query(`SELECT 1 FROM "ManagerAssumption" WHERE "manager_account_id"=$1 AND "gameweek_id"=$2 AND "kind"='FREE_TRANSFERS' ORDER BY "created_at" DESC LIMIT 1`, [rows.rows[0].manager_account_id, rows.rows[0].gameweek_id])
  const confirmedSellingByPlayer = new Map()
  for (const row of assumptions.rows) {
    const value = parse(row.value_json)
    if (value.playerId != null && value.sellingPriceTenths != null) confirmedSellingByPlayer.set(String(value.playerId), Number(value.sellingPriceTenths))
  }
  const forecastById = new Map(runPlayers.map(row => [row.playerId, row]))
  const squad = rows.rows.map(row => {
    const forecast = forecastById.get(String(row.player_id))
    if (!forecast) throw new Error(`Plan player ${row.player_id} has no stored forecast in this run`)
    const playerId = String(row.player_id)
    const sellingPriceTenths = officialByPlayer.has(playerId)
      ? officialByPlayer.get(playerId) ?? confirmedSellingByPlayer.get(playerId) ?? null
      : asNumber(row.planned_purchase_price_tenths)
    return { id: playerId, fplId: forecast.fplId, club: String(forecast.teamId), position: forecast.position, active: forecast.active, purchasePriceTenths: forecast.purchasePriceTenths, sellingPriceTenths, locked: Boolean(row.locked) }
  })
  return {
    squad,
    bankBeforeTenths: asNumber(rows.rows[0].bank_tenths),
    freeTransfers: Number(rows.rows[0].free_transfers),
    freeTransfersConfirmed: Boolean(freeTransferAssumption.rows[0]),
    exactSellingPrices: squad.every(player => player.sellingPriceTenths !== null),
  }
}

export async function createRecommendationSet(db, { planId, forecastRunId, horizon = 1, maxTransfers = 5, uncertaintyPenaltyRate = .15, chip = null, league = null, createdAt = new Date().toISOString() }) {
  if (!Number.isInteger(horizon) || horizon < 1) throw new Error('horizon must be a positive integer')
  if (!Number.isInteger(maxTransfers) || maxTransfers < 0 || maxTransfers > 5) throw new Error('maxTransfers must be between 0 and 5')
  const run = forecastRunId
    ? await db.query(`SELECT * FROM "ForecastRun" WHERE "id"=$1 AND "status"='SUCCEEDED'`, [forecastRunId])
    : await db.query(`SELECT * FROM "ForecastRun" WHERE "status"='SUCCEEDED' ORDER BY datetime("created_at") DESC,"id" DESC LIMIT 1`)
  const resolvedForecastRunId = run.rows[0]?.id
  if (!resolvedForecastRunId) throw new Error(`No succeeded forecast run is available`)
  const leagueId = league?.leagueId ?? null
  const verifiedCached = await db.query(recommendationSetIdentityQuery(true), [planId, resolvedForecastRunId, horizon, maxTransfers, chip, uncertaintyPenaltyRate, run.rows[0].input_hash, leagueId])
  if (verifiedCached.rows[0]) return { ...(await getRecommendationSet(db, verifiedCached.rows[0].id)), cacheStatus: 'HIT' }
  const players = await forecastPlayers(db, resolvedForecastRunId, horizon)
  const fixtureForecasts = chip ? await forecastPlayers(db, resolvedForecastRunId, horizon, { aggregate: false }) : null
  const plan = await planSquad(db, planId, players)
  const cached = await db.query(recommendationSetIdentityQuery(), [planId, resolvedForecastRunId, horizon, maxTransfers, chip, uncertaintyPenaltyRate, run.rows[0].input_hash, leagueId, plan.freeTransfersConfirmed ? 1 : 0, plan.exactSellingPrices ? 1 : 0])
  if (cached.rows[0]) return { ...(await getRecommendationSet(db, cached.rows[0].id)), cacheStatus: 'HIT' }
  const id = randomUUID()
  const common = { squad: plan.squad, candidates: players.map(row => ({ id: row.playerId, fplId: row.fplId, club: String(row.teamId), position: row.position, active: row.active, purchasePriceTenths: row.purchasePriceTenths, sellingPriceTenths: row.purchasePriceTenths })), forecasts: players, bankBeforeTenths: plan.bankBeforeTenths, freeTransfers: plan.freeTransfers, uncertaintyPenaltyRate, maxTransfers }
  if (league?.coverageByFplId && (league.coverageByFplId instanceof Map ? league.coverageByFplId.size : Object.keys(league.coverageByFplId || {}).length)) {
    const fplToInternal = new Map()
    for (const row of players) if (row.fplId != null) fplToInternal.set(Number(row.fplId), String(row.playerId))
    const covRaw = league.coverageByFplId instanceof Map ? league.coverageByFplId : new Map(Object.entries(league.coverageByFplId || {}).map(([k, v]) => [Number(k), Number(v)]))
    const coverageByPlayerId = new Map()
    for (const [fplId, fraction] of covRaw) {
      const internalId = fplToInternal.get(Number(fplId))
      if (internalId) coverageByPlayerId.set(internalId, Number(fraction))
    }
    common.coverageByPlayerId = coverageByPlayerId
  }
  let drafts
  let status = 'SUCCEEDED'
  if (!chip && (!plan.freeTransfersConfirmed || !plan.exactSellingPrices)) {
    drafts = []
    status = 'INSUFFICIENT_DATA'
  } else if (chip) {
    const chipName = ({ TRIPLE_CAPTAIN: 'TC', BENCH_BOOST: 'BB', FREE_HIT: 'FH', WILDCARD: 'WC' })[chip] || chip
    const gameweekIds = [...new Set(fixtureForecasts.map(row => row.gameweekId))]
    const estimate = evaluateChipCounterfactual({ chip: chipName, baselineSquad: plan.squad, candidatePool: common.candidates, forecasts: fixtureForecasts, bankBeforeTenths: plan.bankBeforeTenths, targetGameweekId: gameweekIds[0], horizonGameweekIds: gameweekIds })
    if (!estimate.available) { drafts = []; status = 'INSUFFICIENT_DATA' }
    else drafts = [{ moves: [], affordabilityStatus: 'EXACT', bankAfterTenths: plan.bankBeforeTenths, hitCost: 0, rawGain: estimate.gain, uncertaintyPenalty: 0, netExpectedGain: estimate.gain, probabilityBeatsRoll: estimate.gain > 0 ? 1 : 0, expectedTeamPoints: estimate.expectedPoints, p10Points: estimate.p10Gain, p50Points: estimate.p50Gain, p90Points: estimate.p90Gain, action: 'CHIP', chip: chipName, chipReason: estimate.reason, chipSquadIds: estimate.squadIds }]
  } else if (plan.bankBeforeTenths === null) { drafts = []; status = 'INSUFFICIENT_DATA' } else drafts = boundedTransferSearch(common)
  await db.query('BEGIN IMMEDIATE')
  try {
    await db.query(`INSERT INTO "RecommendationSet" ("id","plan_id","forecast_run_id","horizon","max_transfers","chip","uncertainty_penalty_rate","created_at","status","primary_candidate_id","input_hash","league_id","league_name","free_transfers_confirmed","exact_selling_prices") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11,$12,$13,$14)`, [id, planId, resolvedForecastRunId, horizon, maxTransfers, chip, uncertaintyPenaltyRate, createdAt, status, run.rows[0].input_hash, leagueId, league?.leagueName ?? null, plan.freeTransfersConfirmed ? 1 : 0, plan.exactSellingPrices ? 1 : 0])
    if (!drafts.length) drafts = [{ moves: [], affordabilityStatus: 'AFFORDABILITY_UNKNOWN', bankAfterTenths: null, hitCost: 0, rawGain: 0, uncertaintyPenalty: 0, netExpectedGain: 0, probabilityBeatsRoll: null, expectedTeamPoints: 0, p10Points: null, p50Points: null, p90Points: null, action: 'INSUFFICIENT_DATA', leagueDifferential: null }]
    const roll = drafts.find(draft => draft.moves.length === 0)
    const primary = drafts.find(draft => draft.moves.length > 0 && draft.affordabilityStatus === 'EXACT' && draft.netExpectedGain > 0 && draft.probabilityBeatsRoll >= .6) || roll || drafts[0]
    const persisted = []
    for (const [index, draft] of drafts.entries()) {
      const candidateId = randomUUID(), action = draft.action || (draft.moves.length ? 'TRANSFER' : 'ROLL')
      await db.query(`INSERT INTO "RecommendationCandidate" ("id","recommendation_set_id","rank","action","moves_json","raw_gain","hit_cost","uncertainty_penalty","net_expected_gain","probability_beats_roll","bank_after_tenths","affordability_status","expected_team_points","p10_points","p50_points","p90_points","league_differential") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [candidateId, id, index + 1, action, canonicalJson({ moves: draft.moves.map(move => ({ outId: String(move.outId), inId: String(move.incoming.id) })), chip: draft.chip || null, reason: draft.chipReason || null, squadIds: draft.chipSquadIds || null }), draft.rawGain, draft.hitCost, draft.uncertaintyPenalty, draft.netExpectedGain, draft.probabilityBeatsRoll, draft.bankAfterTenths, draft.affordabilityStatus, draft.expectedTeamPoints, draft.p10Points, draft.p50Points, draft.p90Points, draft.leagueDifferential == null ? null : Number(draft.leagueDifferential)])
      persisted.push({ id: candidateId, ...draft, action, rank: index + 1, apiMoves: draft.moves.map(move => ({ outId: plan.squad.find(player => String(player.id) === String(move.outId))?.fplId, inId: move.incoming.fplId })) })
    }
    const selected = persisted.find(row => row.moves === primary.moves) || persisted[0]
    await db.query(`UPDATE "RecommendationSet" SET "primary_candidate_id"=$2 WHERE "id"=$1`, [id, selected.id])
    await db.query('COMMIT')
    return { ...(await getRecommendationSet(db, id)), cacheStatus: 'MISS' }
  } catch (error) { try { await db.query('ROLLBACK') } catch {}; throw error }
}

export async function getRecommendationSet(db, id) {
  const set = await db.query(`SELECT * FROM "RecommendationSet" WHERE "id"=$1`, [id]); if (!set.rows[0]) return null
  const candidates = await db.query(`SELECT * FROM "RecommendationCandidate" WHERE "recommendation_set_id"=$1 ORDER BY "rank"`, [id])
  const parsedCandidates = candidates.rows.map(row => ({ row, detail: parse(row.moves_json) }))
  const internalIds = [...new Set(parsedCandidates.flatMap(({ detail }) => (detail.moves || []).flatMap(move => [String(move.outId), String(move.inId)])))]
  const fplByInternalId = new Map()
  if (internalIds.length) {
    const placeholders = internalIds.map((_, index) => `$${index + 1}`).join(',')
    const players = await db.query(`SELECT "id","fpl_id" FROM "Player" WHERE "id" IN (${placeholders})`, internalIds)
    for (const player of players.rows) fplByInternalId.set(String(player.id), Number(player.fpl_id))
  }
  return {
    id: set.rows[0].id,
    planId: set.rows[0].plan_id,
    forecastRunId: set.rows[0].forecast_run_id,
    horizon: Number(set.rows[0].horizon),
    maxTransfers: Number(set.rows[0].max_transfers),
    chip: set.rows[0].chip,
    uncertaintyPenaltyRate: Number(set.rows[0].uncertainty_penalty_rate),
    createdAt: set.rows[0].created_at,
    status: set.rows[0].status,
    primaryCandidateId: set.rows[0].primary_candidate_id,
    inputHash: set.rows[0].input_hash,
    assumptions: {
      freeTransfersConfirmed: Boolean(set.rows[0].free_transfers_confirmed),
      exactSellingPrices: Boolean(set.rows[0].exact_selling_prices),
    },
    league: set.rows[0].league_id == null ? null : { leagueId: Number(set.rows[0].league_id), leagueName: set.rows[0].league_name || null },
    candidates: parsedCandidates.map(({ row, detail }) => ({
      id: row.id,
      rank: Number(row.rank),
      action: row.action,
      apiMoves: (detail.moves || []).map(move => ({ outId: fplByInternalId.get(String(move.outId)), inId: fplByInternalId.get(String(move.inId)) })).filter(move => Number.isInteger(move.outId) && Number.isInteger(move.inId)),
      rawGain: Number(row.raw_gain),
      hitCost: Number(row.hit_cost),
      uncertaintyPenalty: Number(row.uncertainty_penalty),
      netExpectedGain: Number(row.net_expected_gain),
      probabilityBeatsRoll: asNumber(row.probability_beats_roll),
      bankAfterTenths: asNumber(row.bank_after_tenths),
      affordabilityStatus: row.affordability_status,
      expectedTeamPoints: Number(row.expected_team_points),
      p10Points: asNumber(row.p10_points),
      p50Points: asNumber(row.p50_points),
      p90Points: asNumber(row.p90_points),
      leagueDifferential: asNumber(row.league_differential),
      chip: detail.chip || undefined,
      chipReason: detail.reason || undefined,
      chipSquadIds: detail.squadIds || undefined,
    })),
  }
}
