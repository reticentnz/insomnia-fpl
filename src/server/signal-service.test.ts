import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../../scripts/db.mjs'
import { ingestOfficialFpl } from '../../scripts/ingest-fpl.mjs'
import { createPlayerSignal, listPlayerSignals, updatePlayerSignalStatuses } from './signal-service.ts'

const directories: string[] = []
const fixtures = path.resolve('scripts', 'fixtures')
const fixture = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'))

async function seed() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-signals-'))
  directories.push(directory)
  const databasePath = path.join(directory, 'database.sqlite')
  await ingestOfficialFpl({ dbPath: databasePath, season: '2026/27', observedAt: '2026-08-15T12:00:00Z', bootstrap: fixture('wp02-bootstrap.json'), fixtures: fixture('wp02-fixtures.json'), elementSummaries: {} })
  return getDb(databasePath)
}

afterEach(async () => {
  await closeDb()
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('canonical signal service', () => {
  it('resolves API ids, records status audits, and returns camel-case API rows', async () => {
    const db = await seed()
    const created = await createPlayerSignal(db, { id: 'signal-1', playerId: 10, kind: 'START_PROBABILITY', value: { startProbability: .8 }, sourceType: 'MANUAL_OVERRIDE', evidenceSummary: 'Confirmed starter', confidence: 1, observedAt: '2026-08-15T12:05:00Z', validUntil: '2026-08-22T12:05:00Z', status: 'VERIFIED' })
    expect(created).toMatchObject({ id: 'signal-1', playerId: 10, sourceType: 'MANUAL_OVERRIDE', value: { startProbability: .8 }, status: 'VERIFIED' })
    expect(await listPlayerSignals(db, { playerId: 10 })).toHaveLength(1)
    const [updated] = await updatePlayerSignalStatuses(db, [{ id: created.id, status: 'REJECTED' }], { updatedAt: '2026-08-16T12:05:00Z' })
    expect(updated.status).toBe('REJECTED')
    const audit = await db.query(`SELECT "from_status", "to_status" FROM "PlayerSignalAudit" WHERE "signal_id"='signal-1' ORDER BY "created_at"`)
    expect(audit.rows).toEqual([{ from_status: null, to_status: 'VERIFIED' }, { from_status: 'VERIFIED', to_status: 'REJECTED' }])
  })
})
