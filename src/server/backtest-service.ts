import { createHash } from 'node:crypto'
import { canonicalJson } from '../../scripts/feed-run.mjs'
import { evaluateBacktestMetrics, evaluateBaselineMetrics, summarizeBacktestRows, type BacktestMetric, type BacktestRow, type BaselineMetric } from '../backtest.ts'

type Database = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

export type BacktestObservation = BacktestRow & {
  modelVersion: string
  forecastRunId: string
  gameweekId: string
  deadlineAt: string
  createdAt: string
}

export type BacktestResult = {
  observationCount: number
  status: 'UNCALIBRATED' | 'CALIBRATED'
  trainingCutoff: string | null
  models: Array<{ modelVersion: string; lastForecastAt: string | null; calibrationSetId: string | null; status: 'UNCALIBRATED' | 'CALIBRATED'; trainingCutoff: string | null; observationCount: number; metrics: BacktestMetric[]; summary: BacktestMetric; baselines: BaselineMetric[]; gameweeks: Array<{ gameweekId: string; sampleSize: number; model: BacktestMetric; baselines: BaselineMetric[] }> }>
}

const number = (value: unknown) => Number(value)

/**
 * Returns only one, latest forecast for each model/player/fixture and requires
 * that it was successful and created before the fixture gameweek deadline.
 * That deadline predicate is repeated rather than trusting a mutable display
 * field, preventing a later run from leaking into historical evaluation.
 */
export async function eligibleBacktestObservations(db: Database, modelVersion?: string): Promise<BacktestObservation[]> {
  const result = await db.query(`
    SELECT
      run."id" AS forecast_run_id, run."model_version", run."created_at", result."gameweek_id",
      forecast."player_id", forecast."fixture_id", forecast."mean_points", forecast."p10_points", forecast."p90_points",
      forecast."minutes_confidence", forecast."strength_method", result."total_points",
      player_observation."position", player_observation."ep_next", player_observation."form", player_observation."points_per_game",
      gameweek."fpl_id" - target_gameweek."fpl_id" + 1 AS horizon,
      (SELECT deadline_observation."deadline_at" FROM "GameweekObservation" deadline_observation
        JOIN "FeedRun" deadline_feed ON deadline_feed."id"=deadline_observation."feed_run_id"
        WHERE deadline_observation."gameweek_id"=result."gameweek_id"
          AND datetime(deadline_observation."observed_at")<=datetime(run."as_of")
          AND deadline_feed."status" IN ('SUCCEEDED','PARTIAL')
        ORDER BY datetime(deadline_observation."observed_at") DESC, deadline_observation."id" DESC LIMIT 1) AS deadline_at
    FROM "PlayerFixtureForecast" forecast
    JOIN "ForecastRun" run ON run."id"=forecast."forecast_run_id"
    JOIN "PlayerFixtureResult" result ON result."player_id"=forecast."player_id" AND result."fixture_id"=forecast."fixture_id"
    JOIN "Gameweek" gameweek ON gameweek."id"=result."gameweek_id"
    JOIN "Gameweek" target_gameweek ON target_gameweek."id"=run."gameweek_id"
    JOIN "PlayerObservation" player_observation ON player_observation."player_id"=forecast."player_id"
      AND player_observation."observed_at"=(SELECT MAX(candidate_observation."observed_at") FROM "PlayerObservation" candidate_observation
        JOIN "FeedRun" observation_feed ON observation_feed."id"=candidate_observation."feed_run_id"
        WHERE candidate_observation."player_id"=forecast."player_id"
          AND datetime(candidate_observation."observed_at")<=datetime(run."as_of") AND observation_feed."status" IN ('SUCCEEDED','PARTIAL'))
    WHERE run."status"='SUCCEEDED' AND run."eligible_for_backtest"=1
      AND ($1 IS NULL OR run."model_version"=$1)
  `, [modelVersion || null])
  const latest = new Map<string, any>()
  for (const row of result.rows) {
    if (!row.deadline_at || Date.parse(String(row.created_at)) > Date.parse(String(row.deadline_at))) continue
    const key = [row.model_version, row.player_id, row.fixture_id].join('\u0000')
    const current = latest.get(key)
    if (!current || Date.parse(String(row.created_at)) > Date.parse(String(current.created_at)) || (row.created_at === current.created_at && String(row.forecast_run_id) > String(current.forecast_run_id))) latest.set(key, row)
  }
  return [...latest.values()].map(row => ({
    modelVersion: String(row.model_version), forecastRunId: String(row.forecast_run_id), gameweekId: String(row.gameweek_id), deadlineAt: String(row.deadline_at), createdAt: String(row.created_at),
    position: row.position, expectedPoints: number(row.mean_points), actualPoints: number(row.total_points), p10Points: number(row.p10_points), p90Points: number(row.p90_points),
    horizon: Math.max(1, number(row.horizon)), minutesConfidence: String(row.minutes_confidence), strengthMethod: String(row.strength_method),
    baselines: { FPL_EP_NEXT: number(row.ep_next), FPL_FORM: number(row.form), FPL_POINTS_PER_GAME: number(row.points_per_game) },
  })).sort((left, right) => left.modelVersion.localeCompare(right.modelVersion) || left.gameweekId.localeCompare(right.gameweekId) || left.forecastRunId.localeCompare(right.forecastRunId))
}

function calibrationSetId(modelVersion: string, cutoff: string) {
  return `calibration:${createHash('sha256').update(`${modelVersion}\u0000${cutoff}`).digest('hex').slice(0, 32)}`
}

async function persistCalibration(db: Database, modelVersion: string, rows: BacktestObservation[], metrics: BacktestMetric[]) {
  const cutoff = rows.map(row => row.deadlineAt).sort().at(-1)!
  const id = calibrationSetId(modelVersion, cutoff)
  const status = rows.length >= 100 ? 'CALIBRATED' : 'UNCALIBRATED'
  const config = canonicalJson({ factorRange: [0.85, 1.15], minimumObservations: 100, metricVersion: 'wp12-v1' })
  await db.query('BEGIN IMMEDIATE')
  try {
    await db.query(`INSERT INTO "CalibrationSet" ("id","model_version","trained_at","training_cutoff","observation_count","status","config_json") VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT("id") DO UPDATE SET "observation_count"=excluded."observation_count", "status"=excluded."status", "config_json"=excluded."config_json"`, [id, modelVersion, cutoff, cutoff, rows.length, status, config])
    await db.query('DELETE FROM "CalibrationMetric" WHERE "calibration_set_id"=$1', [id])
    for (const metric of metrics) await db.query(`INSERT INTO "CalibrationMetric" ("calibration_set_id","position","horizon","confidence_band","strength_method","sample_size","mae","rmse","bias","interval_coverage","rank_correlation","applied_factor") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, metric.position, metric.horizon, metric.confidenceBand, metric.strengthMethod, metric.sampleSize, metric.mae, metric.rmse, metric.bias, metric.intervalCoverage, metric.rankCorrelation, metric.factor])
    await db.query('COMMIT')
  } catch (error) {
    try { await db.query('ROLLBACK') } catch {}
    throw error
  }
  return { id, cutoff, status: status as 'UNCALIBRATED' | 'CALIBRATED' }
}

export async function runBacktest(db: Database, options: { modelVersion?: string } = {}): Promise<BacktestResult> {
  const observations = await eligibleBacktestObservations(db, options.modelVersion)
  // Models with recent forecasts often have no completed fixtures yet. Include
  // them in the review so they do not disappear until their first backtest can
  // be calculated.
  const recordedModels = await db.query(`
    SELECT "model_version", MAX("created_at") AS "last_forecast_at"
    FROM "ForecastRun"
    WHERE "status"='SUCCEEDED' AND ($1 IS NULL OR "model_version"=$1)
    GROUP BY "model_version"
  `, [options.modelVersion || null])
  const lastForecastAt = new Map(recordedModels.rows.map(row => [String(row.model_version), row.last_forecast_at ? String(row.last_forecast_at) : null]))
  const models = [...new Set([...observations.map(row => row.modelVersion), ...lastForecastAt.keys()])]
  // A requested version should be visible even while it has no eligible results.
  if (options.modelVersion && !models.includes(options.modelVersion)) models.push(options.modelVersion)
  const summaries: BacktestResult['models'] = []
  for (const modelVersion of models.sort()) {
    const rows = observations.filter(row => row.modelVersion === modelVersion)
    const metrics = evaluateBacktestMetrics(rows)
    const summary = summarizeBacktestRows(rows, { position: 'ALL', horizon: 1, confidenceBand: 'ALL', strengthMethod: 'ALL' })
    const saved = rows.length ? await persistCalibration(db, modelVersion, rows, metrics) : null
    const gameweeks = [...new Set(rows.map(row => row.gameweekId))].sort().map(gameweekId => {
      const gameweekRows = rows.filter(row => row.gameweekId === gameweekId)
      return { gameweekId, sampleSize: gameweekRows.length, model: summarizeBacktestRows(gameweekRows, { position: 'ALL', horizon: 1, confidenceBand: 'ALL', strengthMethod: 'ALL' }), baselines: evaluateBaselineMetrics(gameweekRows) }
    })
    summaries.push({ modelVersion, lastForecastAt: lastForecastAt.get(modelVersion) || null, calibrationSetId: saved?.id || null, status: saved?.status || 'UNCALIBRATED', trainingCutoff: saved?.cutoff || null, observationCount: rows.length, metrics, summary, baselines: evaluateBaselineMetrics(rows), gameweeks })
  }
  return { observationCount: observations.length, status: summaries.some(model => model.status === 'CALIBRATED') ? 'CALIBRATED' : 'UNCALIBRATED', trainingCutoff: observations.map(row => row.deadlineAt).sort().at(-1) || null, models: summaries }
}
