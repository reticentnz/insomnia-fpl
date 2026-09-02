import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from './db.mjs'
import { ingestOfficialFpl } from './ingest-fpl.mjs'
import { importManagerPayload } from './manager-service.mjs'
import { createPlan } from './plan-service.mjs'
import { createForecastRun } from '../src/server/forecast-service.ts'
import { evaluateDecision, evaluatePendingDecisions, getDecision, recordDecision } from './decision-journal-service.mjs'

const directories: string[] = []
const fixture = <T>(name: string) => JSON.parse(fs.readFileSync(path.resolve('scripts/fixtures', name), 'utf8')) as T
async function seeded() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-wp13-')); directories.push(directory)
  const databasePath = path.join(directory, 'database.sqlite')
  await ingestOfficialFpl({ bootstrap: fixture<any>('wp02-bootstrap.json'), fixtures: fixture<any[]>('wp02-fixtures.json'), elementSummaries: { '10': fixture<any>('wp02-element-summary-10.json'), '11': fixture<any>('wp02-element-summary-11.json') }, dbPath: databasePath, season: '2026/27', observedAt: '2026-08-15T12:00:00Z' })
  const db = getDb(databasePath)
  const manager = await importManagerPayload(db, { entry: fixture<any>('wp03-entry.json'), picks: fixture<any>('wp03-picks.json'), gameweek: 1, season: '2026/27', importedAt: '2026-08-15T19:00:00Z' })
  const chosen = await createPlan(db, { fplEntryId: 123456, parentPlanId: manager.activePlan.id, name: 'Recorded choice', status: 'SAVED', createdAt: '2026-08-15T19:01:00Z' })
  const run = await createForecastRun(db, { asOf: '2026-08-15T12:00:00Z', createdAt: '2026-08-20T12:00:00Z' })
  await db.query(`INSERT INTO "RecommendationSet" ("id","plan_id","forecast_run_id","horizon","max_transfers","chip","uncertainty_penalty_rate","created_at","status","primary_candidate_id","input_hash") VALUES ('set', $1, $2, 1, 1, NULL, 0, $3, 'SUCCEEDED', 'candidate', 'saved-input')`, [manager.activePlan.id, run.id, '2026-08-15T19:00:00Z'])
  await db.query(`INSERT INTO "RecommendationCandidate" ("id","recommendation_set_id","rank","action","moves_json","raw_gain","hit_cost","uncertainty_penalty","net_expected_gain","probability_beats_roll","bank_after_tenths","affordability_status","expected_team_points","p10_points","p50_points","p90_points") VALUES ('candidate','set',1,'TRANSFER','[]',1,0,0,1,.7,0,'EXACT',10,8,10,12)`)
  return { db, baseline: manager.activePlan, chosen, run }
}
afterEach(async () => { await closeDb(); while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true }) })

describe('WP-13 decision journal', () => {
  it('persists immutable baseline/chosen plan references and leaves outcomes pending until all results exist', async () => {
    const { db, baseline, chosen, run } = await seeded()
    const decision = await recordDecision(db, { recommendationSetId: 'set', candidateId: 'candidate', decision: 'ACCEPTED', selectedPlanId: chosen.id, reason: 'Recorded plan choice' })
    expect(decision.baselinePlanId).toBe(baseline.id)
    expect(decision.selectedPlanId).toBe(chosen.id)
    const pending = await evaluateDecision(db, decision.id)
    expect(pending.outcome.status).toBe('PENDING')
    expect(pending.evaluatedAt).toBeNull()
    expect(pending.realizedPointsDelta).toBeNull()
    expect(pending.outcome.wording).toMatch(/does not prove/i)
    // Later runs do not replace the saved forecast-run reference.
    await createForecastRun(db, { asOf: '2026-08-15T12:00:00Z', createdAt: '2026-08-20T12:01:00Z' })
    expect((await getDecision(db, decision.id)).forecastRunId).toBe(run.id)
  })

  it('returns the existing record when the same decision is submitted again', async () => {
    const { db, chosen } = await seeded()
    const first = await recordDecision(db, { recommendationSetId: 'set', candidateId: 'candidate', decision: 'ACCEPTED', selectedPlanId: chosen.id })
    const repeated = await recordDecision(db, { recommendationSetId: 'set', candidateId: 'candidate', decision: 'ACCEPTED', selectedPlanId: chosen.id })
    expect(repeated.id).toBe(first.id)
    expect(first.created).toBe(true)
    expect(repeated.created).toBe(false)
    expect((await db.query('SELECT "id" FROM "DecisionRecord"')).rows).toHaveLength(1)
  })

  it('deduplicates the same action when its recommendation set is regenerated for the gameweek', async () => {
    const { db, baseline, chosen, run } = await seeded()
    const first = await recordDecision(db, { recommendationSetId: 'set', candidateId: 'candidate', decision: 'ACCEPTED', selectedPlanId: chosen.id })
    await db.query(`INSERT INTO "RecommendationSet" ("id","plan_id","forecast_run_id","horizon","max_transfers","chip","uncertainty_penalty_rate","created_at","status","primary_candidate_id","input_hash") VALUES ('regenerated-set', $1, $2, 1, 1, NULL, 0, $3, 'SUCCEEDED', 'regenerated-candidate', 'regenerated-input')`, [baseline.id, run.id, '2026-08-15T19:02:00Z'])
    await db.query(`INSERT INTO "RecommendationCandidate" ("id","recommendation_set_id","rank","action","moves_json","raw_gain","hit_cost","uncertainty_penalty","net_expected_gain","probability_beats_roll","bank_after_tenths","affordability_status","expected_team_points","p10_points","p50_points","p90_points") VALUES ('regenerated-candidate','regenerated-set',1,'TRANSFER','[]',1,0,0,1,.7,0,'EXACT',10,8,10,12)`)
    const repeated = await recordDecision(db, { recommendationSetId: 'regenerated-set', candidateId: 'regenerated-candidate', decision: 'ACCEPTED', selectedPlanId: chosen.id })
    expect(repeated.id).toBe(first.id)
    expect(repeated.created).toBe(false)
    expect((await db.query('SELECT "id" FROM "DecisionRecord"')).rows).toHaveLength(1)
  })

  it('evaluates saved plans and separates forecast error from the recorded decision result', async () => {
    const { db, chosen, run } = await seeded()
    const rows = await db.query('SELECT "player_id", "fixture_id" FROM "PlayerFixtureForecast" WHERE "forecast_run_id"=$1', [run.id])
    for (const row of rows.rows) {
      const fixture = (await db.query('SELECT * FROM "Fixture" WHERE "id"=$1', [row.fixture_id])).rows[0]
      const player = (await db.query('SELECT "team_id" FROM "PlayerObservation" WHERE "player_id"=$1 ORDER BY "observed_at" DESC LIMIT 1', [row.player_id])).rows[0]
      const opponent = fixture.home_team_id === player.team_id ? fixture.away_team_id : fixture.home_team_id
      const forecastRun = (await db.query('SELECT "gameweek_id" FROM "ForecastRun" WHERE "id"=$1', [run.id])).rows[0]
      await db.query(`INSERT INTO "PlayerFixtureResult" ("player_id","fixture_id","gameweek_id","team_id","opponent_team_id","was_home","kickoff_at","total_points") VALUES ($1,$2,$3,$4,$5,1,'2026-08-22T12:00:00Z',5)`, [row.player_id, row.fixture_id, forecastRun.gameweek_id, player.team_id, opponent])
    }
    const decision = await recordDecision(db, { recommendationSetId: 'set', candidateId: 'candidate', decision: 'CUSTOM', selectedPlanId: chosen.id })
    const evaluated = await evaluateDecision(db, decision.id, '2026-08-23T12:00:00Z')
    expect(evaluated.outcome.status).toBe('REALIZED')
    expect(evaluated.outcome.modelForecastError).not.toBeNull()
    expect(evaluated.outcome.managerDecisionResult).toBe(0)
    expect(evaluated.outcome.baselinePlanId).toBe(evaluated.baselinePlanId)
  })

  it('only waits for the gameweeks covered by the recorded recommendation', async () => {
    const { db, baseline, chosen, run } = await seeded()
    const forecastGameweek = (await db.query('SELECT "gameweek_id" FROM "ForecastRun" WHERE "id"=$1', [run.id])).rows[0]
    const rows = await db.query(
      `SELECT forecast."player_id", forecast."fixture_id", fixture_observation."gameweek_id"
       FROM "PlayerFixtureForecast" forecast
       JOIN "FixtureObservation" fixture_observation ON fixture_observation."fixture_id"=forecast."fixture_id"
       JOIN "ForecastRun" run ON run."id"=forecast."forecast_run_id" AND fixture_observation."feed_run_id"=run."official_feed_run_id"
       WHERE forecast."forecast_run_id"=$1`, [run.id])
    for (const row of rows.rows.filter(row => row.gameweek_id === forecastGameweek.gameweek_id)) {
      const fixture = (await db.query('SELECT * FROM "Fixture" WHERE "id"=$1', [row.fixture_id])).rows[0]
      const player = (await db.query('SELECT "team_id" FROM "PlayerObservation" WHERE "player_id"=$1 ORDER BY "observed_at" DESC LIMIT 1', [row.player_id])).rows[0]
      const opponent = fixture.home_team_id === player.team_id ? fixture.away_team_id : fixture.home_team_id
      await db.query(`INSERT INTO "PlayerFixtureResult" ("player_id","fixture_id","gameweek_id","team_id","opponent_team_id","was_home","kickoff_at","total_points") VALUES ($1,$2,$3,$4,$5,1,'2026-08-22T12:00:00Z',5)`, [row.player_id, row.fixture_id, row.gameweek_id, player.team_id, opponent])
    }
    const decision = await recordDecision(db, { recommendationSetId: 'set', candidateId: 'candidate', decision: 'ACCEPTED', selectedPlanId: chosen.id })
    const [evaluated] = await evaluatePendingDecisions(db, { evaluatedAt: '2026-08-23T12:00:00Z' })
    expect(evaluated.id).toBe(decision.id)
    expect(evaluated.outcome.status).toBe('REALIZED')
    expect(evaluated.baselinePlanId).toBe(baseline.id)
  })
})
