import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../../scripts/db.mjs'
import { ingestOfficialFpl } from '../../scripts/ingest-fpl.mjs'
import { createPlayerSignal, deletePlayerSignal, listPlayerSignals, revisePlayerSignalInterpretation, updatePlayerSignalStatuses } from './signal-service.ts'

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

  it('does not expire approved evidence when a new interpretation is still pending', async () => {
    const db = await seed()
    await createPlayerSignal(db, { id: 'approved', playerId: 10, kind: 'START_PROBABILITY', value: { startProbability: .8 }, sourceType: 'JOURNALIST', evidenceSummary: 'Expected starter', confidence: .8, observedAt: '2026-08-15T12:05:00Z', validUntil: '2026-08-22T12:05:00Z', status: 'VERIFIED' })
    await createPlayerSignal(db, { id: 'pending', playerId: 10, kind: 'START_PROBABILITY', value: { startProbability: .5 }, sourceType: 'USER_FEEDBACK', evidenceSummary: 'Possible rotation', confidence: .4, observedAt: '2026-08-15T12:06:00Z', validUntil: '2026-08-22T12:06:00Z', status: 'PENDING' })
    const signals = await listPlayerSignals(db, { playerId: 10 })
    expect(signals.find(signal=>signal.id==='approved')?.status).toBe('VERIFIED')
  })

  it('deletes a signal and its restricted provenance records atomically', async () => {
    const db = await seed()
    await createPlayerSignal(db, { id: 'obsolete', playerId: 10, kind: 'EXPECTED_ROLE', value: { minutesIfStarting: 60 }, sourceType: 'MANUAL_OVERRIDE', evidenceSummary: 'Community Shield minutes', confidence: 1, observedAt: '2026-08-15T12:05:00Z', validUntil: '2026-08-22T12:05:00Z', status: 'VERIFIED' })
    const deleted = await deletePlayerSignal(db, 'obsolete')
    expect(deleted).toMatchObject({ id: 'obsolete', playerId: 10, status: 'VERIFIED' })
    expect(await listPlayerSignals(db, { playerId: 10 })).toEqual([])
    expect((await db.query(`SELECT "id" FROM "PlayerSignalAudit" WHERE "signal_id"='obsolete'`)).rows).toEqual([])
    expect((await db.query(`SELECT "id" FROM "PlayerSignalInterpretation" WHERE "signal_id"='obsolete'`)).rows).toEqual([])
  })

  it('versions a user-adjusted interpretation and can finalize context with no impact', async () => {
    const db = await seed()
    const created = await createPlayerSignal(db, { id: 'ambiguous', playerId: 10, kind: 'VALUE_OPINION', value: { note: 'On my bench' }, sourceType: 'YOUTUBE_TRANSCRIPT', evidenceSummary: 'On my bench', claimClass: 'UNKNOWN', modelImpact: 'NONE', confidence: .6, observedAt: '2026-08-15T12:05:00Z', validUntil: '2026-08-22T12:05:00Z', status: 'PENDING' })
    const updated = await revisePlayerSignalInterpretation(db, String(created.id), { claimClass: 'FPL_SELECTION', modelImpact: 'NONE', value: { note: 'On my bench' }, finalizeContext: true })
    expect(updated).toMatchObject({ status: 'VERIFIED', interpretation: { origin: 'USER', modelImpact: 'NONE', status: 'APPROVED' } })
    const versions = await db.query(`SELECT "status" FROM "PlayerSignalInterpretation" WHERE "signal_id"='ambiguous' ORDER BY "created_at"`)
    expect(versions.rows.map(row=>row.status).sort()).toEqual(['APPROVED','SUPERSEDED'])
  })

  it('can accept a set-pieces interpretation as contextual evidence', async () => {
    const db = await seed()
    const created = await createPlayerSignal(db, { id: 'set-pieces', playerId: 10, kind: 'SET_PIECES', value: { note: 'Takes corners' }, sourceType: 'YOUTUBE_TRANSCRIPT', evidenceSummary: 'Takes corners and free kicks', confidence: .7, observedAt: '2026-08-15T12:05:00Z', validUntil: '2026-08-22T12:05:00Z', status: 'PENDING' })
    const updated = await revisePlayerSignalInterpretation(db, String(created.id), { claimClass: 'SET_PIECES', modelImpact: 'NONE', value: { note: created.evidenceSummary }, finalizeContext: true })
    expect(updated).toMatchObject({ status: 'VERIFIED', interpretation: { claimClass: 'SET_PIECES', modelImpact: 'NONE', status: 'APPROVED' } })
  })

  it('rejects contradictory interpretation payloads and blocks unresolved role claims from approval', async () => {
    const db = await seed()
    await expect(createPlayerSignal(db, { id: 'invalid-context-role', playerId: 10, kind: 'VALUE_OPINION', value: { note: 'context', startProbability: .7 }, sourceType: 'YOUTUBE_TRANSCRIPT', claimClass: 'VALUE_OPINION', modelImpact: 'NONE', evidenceSummary: 'Context', confidence: .6, observedAt: '2026-08-15T12:05:00Z', validUntil: '2026-08-22T12:05:00Z' })).rejects.toThrow('Context-only interpretations cannot contain role adjustments')
    await expect(createPlayerSignal(db, { id: 'invalid-empty-role', playerId: 10, kind: 'START_PROBABILITY', value: { note: 'ambiguous' }, sourceType: 'JOURNALIST', claimClass: 'REAL_WORLD_ROLE', modelImpact: 'ROLE', evidenceSummary: 'Ambiguous', confidence: .6, observedAt: '2026-08-15T12:05:00Z', validUntil: '2026-08-22T12:05:00Z' })).rejects.toThrow('requires a structured role adjustment')
    const unresolved = await createPlayerSignal(db, { id: 'unresolved-role', playerId: 10, kind: 'INJURY', value: { note: 'fitness concern' }, sourceType: 'JOURNALIST', claimClass: 'INJURY', modelImpact: 'NONE', evidenceSummary: 'Fitness concern', confidence: .6, observedAt: '2026-08-15T12:05:00Z', validUntil: '2026-08-22T12:05:00Z' })
    await expect(updatePlayerSignalStatuses(db, [{ id: unresolved.id, status: 'VERIFIED' }])).rejects.toThrow('requires an approved role interpretation')
    expect((await listPlayerSignals(db, { playerId: 10 })).find(signal => signal.id === unresolved.id)?.status).toBe('PENDING')
  })
})
