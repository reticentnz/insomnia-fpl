import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateDatabase } from './db-migrate.mjs'

const temporaryDirectories: string[] = []

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-wp01-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'database.sqlite')
}

afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
})

describe('canonical database migrations', () => {
  it('applies the initial migration and makes the second run a no-op', async () => {
    const databasePath = temporaryDatabase()
    const first = await migrateDatabase(databasePath)
    const second = await migrateDatabase(databasePath)

    expect(first.applied).toEqual(['001_initial_rebuild'])
    expect(second).toEqual({ applied: [], skipped: ['001_initial_rebuild'] })

    const db = new DatabaseSync(databasePath)
    const tables = db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE type = ?').get('table')
    expect(Number(tables.count)).toBe(29)
    db.close()
  })

  it('rejects a changed checksum for an already applied migration', async () => {
    const databasePath = temporaryDatabase()
    const db = new DatabaseSync(databasePath)
    db.exec('CREATE TABLE "SchemaMigration" ("version" TEXT PRIMARY KEY, "checksum" TEXT NOT NULL, "applied_at" TEXT NOT NULL)')
    db.prepare('INSERT INTO "SchemaMigration" ("version", "checksum", "applied_at") VALUES (?, ?, ?)').run('001_initial_rebuild', 'changed', new Date().toISOString())
    db.close()

    await expect(migrateDatabase(databasePath)).rejects.toThrow(/Migration 001_initial_rebuild checksum mismatch/)
  })

  it('enforces foreign keys for canonical child rows', async () => {
    const databasePath = temporaryDatabase()
    await migrateDatabase(databasePath)
    const db = new DatabaseSync(databasePath)
    db.exec('PRAGMA foreign_keys = ON')

    expect(() => db.prepare('INSERT INTO "OfficialSquadPlayer" ("squad_snapshot_id", "player_id", "position", "squad_order", "economics_source") VALUES (?, ?, ?, ?, ?)').run('missing-snapshot', 'missing-player', 'MID', 0, 'UNKNOWN')).toThrow()
    db.close()
  })
})
