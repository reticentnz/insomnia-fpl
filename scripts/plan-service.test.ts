import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from './db.mjs'
import { ingestOfficialFpl } from './ingest-fpl.mjs'
import { importManagerPayload } from './manager-service.mjs'
import { createPlan, getActivePlan, getPlan, selectPlan } from './plan-service.mjs'

const temporaryDirectories: string[] = []
const fixtureDirectory = path.resolve('scripts', 'fixtures')

function readFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), 'utf8')) as T
}

async function seededManager() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-wp04-'))
  temporaryDirectories.push(directory)
  const databasePath = path.join(directory, 'database.sqlite')
  await ingestOfficialFpl({
    bootstrap: readFixture<any>('wp02-bootstrap.json'),
    fixtures: readFixture<any[]>('wp02-fixtures.json'),
    elementSummaries: {
      '10': readFixture<any>('wp02-element-summary-10.json'),
      '11': readFixture<any>('wp02-element-summary-11.json'),
    },
    dbPath: databasePath,
    season: '2026/27',
    observedAt: '2026-08-15T18:30:00Z',
  })
  const db = getDb(databasePath)
  const manager = await importManagerPayload(db, {
    entry: readFixture<any>('wp03-entry.json'),
    picks: readFixture<any>('wp03-picks.json'),
    gameweek: 1,
    season: '2026/27',
    importedAt: '2026-08-15T19:00:00Z',
  })
  return { databasePath, db, manager }
}

afterEach(async () => {
  await closeDb()
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
})

describe('WP-04 immutable plans', () => {
  it('creates an active plan from the official snapshot and keeps official state isolated', async () => {
    const { db, manager } = await seededManager()
    expect(manager.activePlan).toMatchObject({ status: 'ACTIVE', officialSquadSnapshotId: manager.snapshot.id })
    const initial = manager.activePlan
    const child = await createPlan(db, {
      fplEntryId: 123456,
      parentPlanId: initial.id,
      name: 'Local scenario',
      status: 'ACTIVE',
      changeSummary: { kind: 'LOCAL_EDIT', description: 'scenario revision' },
      createdAt: '2026-08-15T19:10:00Z',
    })
    expect(child.parentPlanId).toBe(initial.id)
    expect(child.status).toBe('ACTIVE')
    const snapshotPlayers = await db.query('SELECT * FROM "OfficialSquadPlayer" WHERE "squad_snapshot_id"=$1', [manager.snapshot.id])
    const initialPlanPlayers = await db.query('SELECT * FROM "PlanPlayer" WHERE "plan_id"=$1', [initial.id])
    expect(snapshotPlayers.rows).toHaveLength(2)
    expect(initialPlanPlayers.rows).toHaveLength(2)
    expect((await getPlan(db, initial.id)).status).toBe('SAVED')
    expect((await getActivePlan(db, { fplEntryId: 123456 })).id).toBe(child.id)
  })

  it('undoes by selecting the exact parent revision and retains both revisions', async () => {
    const { db, manager } = await seededManager()
    const first = manager.activePlan
    const second = await createPlan(db, { fplEntryId: 123456, parentPlanId: first.id, name: 'Second', status: 'ACTIVE', createdAt: '2026-08-15T19:10:00Z' })
    const third = await createPlan(db, { fplEntryId: 123456, parentPlanId: second.id, name: 'Third', status: 'ACTIVE', createdAt: '2026-08-15T19:20:00Z' })
    expect((await getActivePlan(db, { fplEntryId: 123456 })).id).toBe(third.id)
    const undone = await selectPlan(db, second.id)
    expect(undone.id).toBe(second.id)
    expect((await getActivePlan(db, { fplEntryId: 123456 })).id).toBe(second.id)
    expect((await getPlan(db, third.id)).parentPlanId).toBe(second.id)
    expect((await getPlan(db, first.id)).players).toEqual((await getPlan(db, second.id)).players)
  })

  it('retains named saved scenarios without changing the active plan', async () => {
    const { db, manager } = await seededManager()
    const saved = await createPlan(db, { fplEntryId: 123456, parentPlanId: manager.activePlan.id, name: 'Wildcard idea', status: 'SAVED', createdAt: '2026-08-15T19:30:00Z' })
    expect(saved.status).toBe('SAVED')
    expect((await getActivePlan(db, { fplEntryId: 123456 })).id).toBe(manager.activePlan.id)
  })
})
