import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../../scripts/db.mjs'
import { ingestOfficialFpl } from '../../scripts/ingest-fpl.mjs'
import { createForecastRun, latestEligibleForecastRun } from './forecast-service.ts'

const directories: string[] = []
const fixture = <T>(name: string) => JSON.parse(fs.readFileSync(path.resolve('scripts/fixtures', name), 'utf8')) as T
function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-wp08-'))
  directories.push(directory)
  return path.join(directory, 'database.sqlite')
}
async function seeded() {
  const databasePath = temporaryDatabase()
  await ingestOfficialFpl({ bootstrap: fixture<any>('wp02-bootstrap.json'), fixtures: fixture<any[]>('wp02-fixtures.json'), elementSummaries: { '10': fixture<any>('wp02-element-summary-10.json'), '11': fixture<any>('wp02-element-summary-11.json') }, dbPath: databasePath, season: '2026/27', observedAt: '2026-08-15T12:00:00Z', finishedAt: '2026-08-15T12:01:00Z' })
  return getDb(databasePath)
}
afterEach(async () => { await closeDb(); while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true }) })

describe('WP-08 immutable forecast ledger', () => {
  it('creates immutable runs, marks deadline eligibility, and selects the latest eligible baseline', async () => {
    const db = await seeded()
    const first = await createForecastRun(db, { asOf: '2026-08-15T12:00:00Z', createdAt: '2026-08-20T12:00:00Z' })
    const second = await createForecastRun(db, { asOf: '2026-08-15T12:00:00Z', createdAt: '2026-08-21T17:00:00Z' })
    const late = await createForecastRun(db, { asOf: '2026-08-15T12:00:00Z', createdAt: '2026-08-21T18:31:00Z' })
    expect(first.status).toBe('SUCCEEDED'); expect(second.status).toBe('SUCCEEDED'); expect(late.status).toBe('SUCCEEDED')
    expect(first.eligibleForBacktest).toBe(true); expect(second.eligibleForBacktest).toBe(true)
    expect(new Set([first.id, second.id, late.id]).size).toBe(3)
    expect(late.eligibleForBacktest).toBe(false)
    const gameweek = (await db.query('SELECT "gameweek_id" FROM "ForecastRun" WHERE "id"=$1', [first.id])).rows[0].gameweek_id
    expect((await latestEligibleForecastRun(db, gameweek)).id).toBe(second.id)
    expect((await db.query('SELECT COUNT(*) AS count FROM "PlayerFixtureForecast" WHERE "forecast_run_id"=$1', [first.id])).rows[0].count).toBeGreaterThan(0)
    const outcome = (await db.query('SELECT "standard_deviation", "p10_points", "p50_points", "p90_points" FROM "PlayerFixtureForecast" WHERE "forecast_run_id"=$1 LIMIT 1', [first.id])).rows[0]
    expect(Number(outcome.standard_deviation)).toBeGreaterThanOrEqual(0)
    expect(Number(outcome.p10_points)).toBeLessThanOrEqual(Number(outcome.p50_points))
    expect(Number(outcome.p50_points)).toBeLessThanOrEqual(Number(outcome.p90_points))
    expect((await db.query('SELECT "config_json" FROM "ForecastRun" WHERE "id"=$1', [first.id])).rows[0].config_json).toContain('"simulationCount":2000')
  })

  it('retains a failed ledger row without partial children', async () => {
    const db = await seeded()
    const result = await createForecastRun(db, { asOf: '2026-08-15T12:00:00Z', projectFixture: () => { throw new Error('injected projection failure') } })
    expect(result.status).toBe('FAILED')
    expect((await db.query('SELECT "status", "error_summary" FROM "ForecastRun" WHERE "id"=$1', [result.id])).rows[0]).toMatchObject({ status: 'FAILED', error_summary: 'injected projection failure' })
    expect((await db.query('SELECT COUNT(*) AS count FROM "PlayerFixtureForecast" WHERE "forecast_run_id"=$1', [result.id])).rows[0].count).toBe(0)
  })
})
