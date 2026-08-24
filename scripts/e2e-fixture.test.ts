import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from './db.mjs'
import { ingestOfficialFpl } from './ingest-fpl.mjs'
import { importManagerPayload } from './manager-service.mjs'
import { createPlan, getActivePlan } from './plan-service.mjs'
import { updateManagerAssumptions } from './manager-service.mjs'
import { assembleProjectionInputCatalog } from '../src/server/catalog-service.ts'
import { latestEligibleForecastRun } from '../src/server/forecast-service.ts'
import { runBacktest } from '../src/server/backtest-service.ts'

const directories: string[] = []
const fixtures = path.resolve('scripts', 'fixtures')

function fixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8')) as T
}

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-e2e-'))
  directories.push(directory)
  return path.join(directory, 'database.sqlite')
}

afterEach(async () => {
  await closeDb()
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('fixture smoke workflow', () => {
  it('ingests, imports, confirms plan assumptions, and exposes reproducible forecast inputs', async () => {
    const databasePath = temporaryDatabase()
    const observedAt = '2026-08-15T18:30:00Z'
    const ingestion = await ingestOfficialFpl({
      dbPath: databasePath,
      season: '2026/27',
      observedAt,
      startedAt: '2026-08-15T18:31:00Z',
      finishedAt: '2026-08-15T18:31:05Z',
      bootstrap: fixture('wp02-bootstrap.json'),
      fixtures: fixture('wp02-fixtures.json'),
      elementSummaries: { '10': fixture('wp02-element-summary-10.json'), '11': fixture('wp02-element-summary-11.json') },
    })
    expect(ingestion.status).toBe('SUCCEEDED')
    expect(ingestion.forecast?.status).toBe('CREATED')

    const db = getDb(databasePath)
    const manager = await importManagerPayload(db, {
      season: '2026/27',
      gameweek: 1,
      importedAt: '2026-08-15T18:31:06Z',
      entry: fixture('wp03-entry.json'),
      picks: fixture('wp03-picks.json'),
    })
    expect(manager.squad).toHaveLength(2)
    expect(manager.squad[0].sellingPriceTenths).not.toBeNull()

    const confirmed = await updateManagerAssumptions(db, {
      fplEntryId: manager.account.teamId,
      season: '2026/27',
      gameweek: 1,
      freeTransfers: 2,
      createdAt: '2026-08-15T18:31:07Z',
    })
    expect(confirmed.freeTransfers).toBe(2)
    expect(confirmed.freeTransfersSource).toBe('USER_CONFIRMED')

    const active = await getActivePlan(db, { fplEntryId: manager.account.teamId })
    expect(active?.players).toHaveLength(2)
    const scenario = await createPlan(db, {
      fplEntryId: manager.account.teamId,
      parentPlanId: active!.id,
      playerIds: active!.players.map(player => player.fplId),
      freeTransfers: 2,
      name: 'Fixture scenario',
      status: 'SAVED',
      createdAt: '2026-08-15T18:31:08Z',
    })
    expect(scenario.parentPlanId).toBe(active!.id)

    const catalogue = await assembleProjectionInputCatalog(db, { season: '2026/27', asOf: observedAt })
    expect(catalogue.players).toHaveLength(2)
    expect(catalogue.freshness.official.observedAt).toBe(observedAt)
    expect(catalogue.inputHash).toMatch(/^[a-f0-9]{64}$/)

    const forecastRun = (await db.query('SELECT "gameweek_id" FROM "ForecastRun" WHERE "id"=$1', [ingestion.forecast?.forecastRunId])).rows[0]
    const baseline = await latestEligibleForecastRun(db, String(forecastRun.gameweek_id))
    expect(baseline?.id).toBe(ingestion.forecast?.forecastRunId)
    const backtest = await runBacktest(db)
    expect(backtest.observationCount).toBeGreaterThanOrEqual(0)
    expect(backtest.status).toBe('UNCALIBRATED')
  })
})
