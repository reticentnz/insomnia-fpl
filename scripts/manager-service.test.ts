import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from './db.mjs'
import { migrateDatabase } from './db-migrate.mjs'
import { ingestOfficialFpl } from './ingest-fpl.mjs'
import { fetchManagerPayload, getCurrentManager, importManagerPayload, linkManagerAccount, unlinkCurrentManager, updateManagerAssumptions } from './manager-service.mjs'

const temporaryDirectories: string[] = []
const fixtureDirectory = path.resolve('scripts', 'fixtures')

function readFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), 'utf8')) as T
}

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-wp03-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'database.sqlite')
}

async function seededDatabase() {
  const databasePath = temporaryDatabase()
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
  return databasePath
}

afterEach(async () => {
  await closeDb()
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
})

describe('WP-03 manager import and exact economics', () => {
  it('distinguishes a valid pre-deadline account from a missing account', async () => {
    const entry = readFixture<any>('wp03-entry.json')
    const fetchJson = async (endpoint: string) => {
      if (endpoint === 'entry/123456/') return entry
      throw Object.assign(new Error('not public'), { status: 404 })
    }
    const payload = await fetchManagerPayload({ teamId: 123456, gameweek: 1, fetchJson })
    expect(payload).toMatchObject({ entry, picks: null, gameweek: 1, squadAvailable: false })

    await expect(fetchManagerPayload({
      teamId: 999999,
      gameweek: 1,
      fetchJson: async () => { throw Object.assign(new Error('missing'), { status: 404 }) },
    })).rejects.toThrow('No FPL account exists for Team ID 999999')
  })

  it('links pre-deadline account metadata without inventing an official squad', async () => {
    const databasePath = await seededDatabase()
    await migrateDatabase(databasePath)
    const db = getDb(databasePath)
    const current = await linkManagerAccount(db, {
      entry: readFixture<any>('wp03-entry.json'),
      gameweek: 1,
      linkedAt: '2026-08-15T19:00:00Z',
    })

    expect(current.account).toMatchObject({ teamId: 123456, teamName: 'Exact Economics FC' })
    expect(current.snapshot).toBeNull()
    expect(current.squad).toEqual([])
    expect(Number((await db.query('SELECT COUNT(*) AS count FROM "OfficialSquadSnapshot"')).rows[0].count)).toBe(0)
    expect((await getCurrentManager(db)).account.teamId).toBe(123456)
  })

  it('persists official purchase and selling prices in an immutable squad snapshot', async () => {
    const databasePath = await seededDatabase()
    await migrateDatabase(databasePath)
    const db = getDb(databasePath)
    const current = await importManagerPayload(db, {
      entry: readFixture<any>('wp03-entry.json'),
      picks: readFixture<any>('wp03-picks.json'),
      gameweek: 1,
      season: '2026/27',
      importedAt: '2026-08-15T19:00:00Z',
    })

    expect(current.account.bankTenths).toBe(5)
    expect(current.account.totalTransfers).toBe(3)
    expect(current.snapshot.bankTenths).toBe(5)
    expect(current.squad[0]).toMatchObject({
      fplId: 10,
      purchasePriceTenths: 50,
      sellingPriceTenths: 52,
      economicsSource: 'OFFICIAL',
    })
    expect(current.squad[1]).toMatchObject({
      fplId: 11,
      purchasePriceTenths: 48,
      sellingPriceTenths: null,
      economicsSource: 'UNKNOWN',
    })
    expect(current.economics.status).toBe('AFFORDABILITY_UNKNOWN')
  })

  it('records user-confirmed free transfers and missing selling prices without mutating the official snapshot', async () => {
    const databasePath = await seededDatabase()
    await migrateDatabase(databasePath)
    const db = getDb(databasePath)
    await importManagerPayload(db, {
      entry: readFixture<any>('wp03-entry.json'),
      picks: readFixture<any>('wp03-picks.json'),
      gameweek: 1,
      season: '2026/27',
      importedAt: '2026-08-15T19:00:00Z',
    })
    const current = await updateManagerAssumptions(db, {
      fplEntryId: 123456,
      season: '2026/27',
      gameweek: 1,
      freeTransfers: 2,
      sellingPrices: [{ fplId: 11, sellingPriceTenths: 50 }],
      createdAt: '2026-08-15T19:05:00Z',
    })

    expect(current.freeTransfers).toBe(2)
    expect(current.freeTransfersSource).toBe('USER_CONFIRMED')
    expect(current.economics.status).toBe('EXACT')
    expect(current.squad.find(player => player.fplId === 11)).toMatchObject({ sellingPriceTenths: 50, economicsSource: 'USER_CONFIRMED' })
    expect(current.snapshot.bankTenths).toBe(5)
    expect(current.assumptions).toHaveLength(2)
    expect(current.assumptions.every(assumption => assumption.source === 'USER_CONFIRMED')).toBe(true)
  })

  it('creates a new immutable snapshot on a second import', async () => {
    const databasePath = await seededDatabase()
    await migrateDatabase(databasePath)
    const db = getDb(databasePath)
    const payload = { entry: readFixture<any>('wp03-entry.json'), picks: readFixture<any>('wp03-picks.json'), gameweek: 1, season: '2026/27' }
    await importManagerPayload(db, { ...payload, importedAt: '2026-08-15T19:00:00Z' })
    await importManagerPayload(db, { ...payload, importedAt: '2026-08-15T20:00:00Z' })
    const snapshots = await db.query('SELECT COUNT(*) AS count FROM "OfficialSquadSnapshot"')
    const players = await db.query('SELECT COUNT(*) AS count FROM "OfficialSquadPlayer"')
    expect(Number(snapshots.rows[0].count)).toBe(2)
    expect(Number(players.rows[0].count)).toBe(4)
    const latest = await getCurrentManager(db, { fplEntryId: 123456 })
    expect(latest.snapshot.importedAt).toBe('2026-08-15T20:00:00Z')
  })

  it('rolls back the manager snapshot when initial plan creation fails', async () => {
    const databasePath = await seededDatabase()
    await migrateDatabase(databasePath)
    const db = getDb(databasePath)
    await expect(importManagerPayload(db, {
      entry: readFixture<any>('wp03-entry.json'), picks: readFixture<any>('wp03-picks.json'),
      gameweek: 1, season: '2026/27', importedAt: '2026-08-15T19:00:00Z',
      beforeInitialPlan: async () => { throw new Error('injected plan failure') },
    })).rejects.toThrow('injected plan failure')
    expect(Number((await db.query('SELECT COUNT(*) AS count FROM "ManagerAccount"')).rows[0].count)).toBe(0)
    expect(Number((await db.query('SELECT COUNT(*) AS count FROM "OfficialSquadSnapshot"')).rows[0].count)).toBe(0)
  })

  it('unlinks without deleting immutable official history', async () => {
    const databasePath = await seededDatabase()
    await migrateDatabase(databasePath)
    const db = getDb(databasePath)
    await importManagerPayload(db, {
      entry: readFixture<any>('wp03-entry.json'), picks: readFixture<any>('wp03-picks.json'),
      gameweek: 1, season: '2026/27', importedAt: '2026-08-15T19:00:00Z',
    })
    await unlinkCurrentManager(db)
    expect((await getCurrentManager(db)).account).toBeNull()
    expect(Number((await db.query('SELECT COUNT(*) AS count FROM "OfficialSquadSnapshot"')).rows[0].count)).toBe(1)
  })
})
