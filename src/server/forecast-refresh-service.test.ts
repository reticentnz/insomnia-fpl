import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../../scripts/db.mjs'
import { ingestOfficialFpl } from '../../scripts/ingest-fpl.mjs'
import { ForecastRefreshCoordinator, refreshForecastIfInputsChanged } from './forecast-refresh-service.ts'

const directories: string[] = []
const fixture = <T>(name: string) => JSON.parse(fs.readFileSync(path.resolve('scripts/fixtures', name), 'utf8')) as T
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-refresh-'))
  directories.push(directory)
  return path.join(directory, 'database.sqlite')
}

async function seed(databasePath: string, observedAt = '2026-08-15T12:00:00Z') {
  await ingestOfficialFpl({
    bootstrap: fixture<any>('wp02-bootstrap.json'), fixtures: fixture<any[]>('wp02-fixtures.json'),
    elementSummaries: { '10': fixture<any>('wp02-element-summary-10.json'), '11': fixture<any>('wp02-element-summary-11.json') },
    dbPath: databasePath, season: '2026/27', observedAt,
  })
}

afterEach(async () => {
  await closeDb()
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('forecast refresh on changed inputs', () => {
  it('skips a later no-op refresh after official ingestion created the immutable run', async () => {
    const databasePath = temporaryDatabase()
    await seed(databasePath)
    const db = getDb(databasePath)
    const first = await refreshForecastIfInputsChanged(db, { asOf: '2026-08-15T12:00:00Z', reasons: ['official'] })
    const second = await refreshForecastIfInputsChanged(db, { asOf: '2026-08-15T12:00:00Z', reasons: ['market'] })

    expect(first.status).toBe('UNCHANGED')
    expect(second).toMatchObject({ status: 'UNCHANGED', previousRunId: first.previousRunId, inputHash: first.inputHash })
    expect((await db.query('SELECT COUNT(*) AS count FROM "ForecastRun"')).rows[0].count).toBe(1)
  })

  it('creates one new immutable run when an official value changes', async () => {
    const databasePath = temporaryDatabase()
    await seed(databasePath)
    const db = getDb(databasePath)
    const first = await refreshForecastIfInputsChanged(db, { asOf: '2026-08-15T12:00:00Z', reasons: ['official'] })
    await closeDb()
    const changed = fixture<any>('wp02-bootstrap.json')
    changed.elements[0].now_cost = 99
    await ingestOfficialFpl({ bootstrap: changed, fixtures: fixture<any[]>('wp02-fixtures.json'), elementSummaries: { '10': fixture<any>('wp02-element-summary-10.json'), '11': fixture<any>('wp02-element-summary-11.json') }, dbPath: databasePath, season: '2026/27', observedAt: '2026-08-15T12:01:00Z' })
    const after = getDb(databasePath)
    const second = await refreshForecastIfInputsChanged(after, { asOf: '2026-08-15T12:01:00Z', reasons: ['official'] })

    expect(first.status).toBe('UNCHANGED')
    expect(second.status).toBe('UNCHANGED')
    expect(second.inputHash).not.toBe(first.inputHash)
    expect((await after.query('SELECT COUNT(*) AS count FROM "ForecastRun" WHERE "status"=\'SUCCEEDED\'')).rows[0].count).toBe(2)
  })

  it('invalidates the immutable decision snapshot when event transfer pressure changes', async () => {
    const databasePath = temporaryDatabase()
    await seed(databasePath)
    const db = getDb(databasePath)
    const first = await refreshForecastIfInputsChanged(db, { asOf: '2026-08-15T12:00:00Z', reasons: ['official'] })
    await closeDb()
    const changed = fixture<any>('wp02-bootstrap.json')
    changed.elements[0].transfers_in_event = Number(changed.elements[0].transfers_in_event || 0) + 1
    await ingestOfficialFpl({ bootstrap: changed, fixtures: fixture<any[]>('wp02-fixtures.json'), elementSummaries: { '10': fixture<any>('wp02-element-summary-10.json'), '11': fixture<any>('wp02-element-summary-11.json') }, dbPath: databasePath, season: '2026/27', observedAt: '2026-08-15T12:01:00Z' })
    const after = getDb(databasePath)
    const second = await refreshForecastIfInputsChanged(after, { asOf: '2026-08-15T12:01:00Z', reasons: ['official'] })

    expect(second.status).toBe('UNCHANGED')
    expect(second.inputHash).not.toBe(first.inputHash)
    expect((await after.query('SELECT COUNT(*) AS count FROM "ForecastRun" WHERE "status"=\'SUCCEEDED\'')).rows[0].count).toBe(2)
  })

  it('coalesces concurrent refresh triggers into one state check with all reasons', async () => {
    const calls: string[][] = []
    const coordinator = new ForecastRefreshCoordinator(async reasons => {
      calls.push(reasons)
      return { status: 'UNCHANGED', reason: reasons, checkedAt: new Date().toISOString() }
    }, 5)
    expect(coordinator.request('official').status).toBe('started')
    expect(coordinator.request('market').status).toBe('queued')
    expect(coordinator.request('signal').status).toBe('queued')
    await wait(30)
    expect(calls).toEqual([['official', 'market', 'signal']])
  })
})
