import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../../scripts/db.mjs'
import { ingestOfficialFpl } from '../../scripts/ingest-fpl.mjs'
import { evaluateBaselineMetrics, summarizeBacktestRows } from '../backtest.ts'
import { MODEL_VERSION } from '../core/projection.ts'
import { createForecastRun } from './forecast-service.ts'
import { eligibleBacktestObservations, runBacktest } from './backtest-service.ts'

const directories: string[] = []
const fixture = <T>(name: string) => JSON.parse(fs.readFileSync(path.resolve('scripts/fixtures', name), 'utf8')) as T
function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-wp12-'))
  directories.push(directory)
  return path.join(directory, 'database.sqlite')
}
async function seeded() {
  const databasePath = temporaryDatabase()
  await ingestOfficialFpl({ bootstrap: fixture<any>('wp02-bootstrap.json'), fixtures: fixture<any[]>('wp02-fixtures.json'), elementSummaries: { '10': fixture<any>('wp02-element-summary-10.json'), '11': fixture<any>('wp02-element-summary-11.json') }, dbPath: databasePath, season: '2026/27', observedAt: '2026-08-13T12:00:00Z', finishedAt: '2026-08-13T12:01:00Z' })
  return getDb(databasePath)
}
afterEach(async () => { await closeDb(); while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true }) })

describe('WP-12 deadline-safe backtesting and calibration', () => {
  it('compares forecasts with simple pre-deadline FPL baselines', () => {
    const metrics = evaluateBaselineMetrics([
      { position: 'MID', expectedPoints: 6, actualPoints: 8, baselines: { FPL_EP_NEXT: 7, FPL_FORM: 4, FPL_POINTS_PER_GAME: 5 } },
      { position: 'MID', expectedPoints: 3, actualPoints: 2, baselines: { FPL_EP_NEXT: 3, FPL_FORM: 2, FPL_POINTS_PER_GAME: 4 } },
    ])
    expect(metrics.find(metric => metric.name === 'FPL_EP_NEXT')).toMatchObject({ sampleSize: 2, mae: 1 })
  })

  it('selects only the latest eligible pre-deadline baseline for each model and is idempotent', async () => {
    const db = await seeded()
    const early = await createForecastRun(db, { modelVersion: 'model-a', asOf: '2026-08-13T12:00:00Z', createdAt: '2026-08-13T13:00:00Z' })
    const latest = await createForecastRun(db, { modelVersion: 'model-a', asOf: '2026-08-13T12:00:00Z', createdAt: '2026-08-14T17:00:00Z' })
    const late = await createForecastRun(db, { modelVersion: 'model-a', asOf: '2026-08-13T12:00:00Z', createdAt: '2026-08-14T18:00:00Z' })
    const otherModel = await createForecastRun(db, { modelVersion: 'model-b', asOf: '2026-08-13T12:00:00Z', createdAt: '2026-08-14T17:00:00Z' })
    expect(early.status).toBe('SUCCEEDED'); expect(latest.status).toBe('SUCCEEDED'); expect(late.eligibleForBacktest).toBe(false); expect(otherModel.status).toBe('SUCCEEDED')
    await db.query('UPDATE "PlayerFixtureForecast" SET "mean_points"=99 WHERE "forecast_run_id"=$1', [late.id])
    const rows = await eligibleBacktestObservations(db)
    expect(rows).toHaveLength(6)
    expect(rows.filter(row => row.modelVersion === 'model-a').every(row => row.forecastRunId === latest.id)).toBe(true)
    expect(rows.some(row => row.expectedPoints === 99)).toBe(false)
    const first = await runBacktest(db)
    const second = await runBacktest(db)
    expect(first).toEqual(second)
    expect(first.models.map(model => model.modelVersion)).toEqual(['model-a', 'model-b', MODEL_VERSION])
    expect((await db.query('SELECT COUNT(*) AS count FROM "CalibrationSet"')).rows[0].count).toBe(3)
  })

  it('does not mix requested model versions and reports explicit zero-observation state', async () => {
    const db = await seeded()
    await createForecastRun(db, { modelVersion: 'model-a', asOf: '2026-08-13T12:00:00Z', createdAt: '2026-08-14T17:00:00Z' })
    const isolated = await runBacktest(db, { modelVersion: 'model-a' })
    expect(isolated.models).toHaveLength(1)
    expect(isolated.models[0].modelVersion).toBe('model-a')
    expect(isolated.models[0].status).toBe('UNCALIBRATED')
    expect(isolated.models[0].summary.factor).toBe(1)
    const empty = await runBacktest(db, { modelVersion: 'no-results-model' })
    expect(empty).toMatchObject({ observationCount: 0, status: 'UNCALIBRATED', trainingCutoff: null })
    expect(empty.models[0]).toMatchObject({ modelVersion: 'no-results-model', observationCount: 0, calibrationSetId: null })
  })

  it('enforces the 100-observation threshold, capped factors, coverage and rank correlation', () => {
    const inputs = Array.from({ length: 99 }, () => ({ position: 'MID' as const, expectedPoints: 4, actualPoints: 8, p10Points: 2, p90Points: 7 }))
    const dimensions = { position: 'MID' as const, horizon: 1, confidenceBand: 'HIGH', strengthMethod: 'MARKET_XG' }
    expect(summarizeBacktestRows(inputs, dimensions)).toMatchObject({ sampleSize: 99, calibrated: false, factor: 1, intervalCoverage: 0, rankCorrelation: null })
    const qualified = summarizeBacktestRows([...inputs, { ...inputs[0], actualPoints: 8, p10Points: 2, p90Points: 9 }], dimensions)
    expect(qualified.calibrated).toBe(true)
    expect(qualified.factor).toBe(1.15)
    expect(qualified.intervalCoverage).toBe(0.01)
    expect(qualified.rankCorrelation).toBeNull()
  })
})
