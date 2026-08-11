import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from './db.mjs'
import { migrateDatabase } from './db-migrate.mjs'
import { getUserState, updateAiState, updateUserState } from './user-state-service.mjs'

const directories: string[] = []

afterEach(async () => {
  await closeDb()
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('canonical application state', () => {
  it('persists non-plan preferences and AI settings without legacy tables', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-state-'))
    directories.push(directory)
    const databasePath = path.join(directory, 'database.sqlite')
    await migrateDatabase(databasePath)
    const db = getDb(databasePath)

    await updateUserState(db, {
      userName: 'Stew', bank: 1.4, freeTransfers: 3, defaultLeagueId: 99,
      onboardingCompleted: true, challengeResult: { status: 'done' }, stagedReviews: { 10: 'VERIFIED' },
    }, '2026-08-16T00:00:00Z')
    await updateAiState(db, { provider: 'openai' }, '2026-08-16T00:01:00Z')

    await expect(db.query('SELECT * FROM "UserPreference"')).rejects.toThrow()
    expect(await getUserState(db)).toMatchObject({
      preferences: {
        userName: 'Stew', bank: 1.4, freeTransfers: 3, defaultLeagueId: 99,
        onboardingCompleted: true, challengeResult: { status: 'done' }, stagedReviews: { 10: 'VERIFIED' },
      },
      ai: { provider: 'openai' },
    })
  })

  it('persists and reloads GW1 draft fields and account-scoped season mode activation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-draft-state-'))
    directories.push(directory)
    const databasePath = path.join(directory, 'database.sqlite')
    await migrateDatabase(databasePath)
    const db = getDb(databasePath)

    await updateUserState(db, {
      draftSeason: '2026/27',
      draftPlayerIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      draftLockedPlayerIds: [1, 2],
      draftRevision: '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15|1,2',
      draftUpdatedAt: '2026-08-16T12:00:00Z',
      seasonModeManagerAccountId: 'acc-123',
      seasonModeSeason: '2026/27',
    })

    const state = await getUserState(db)
    expect(state.preferences).toMatchObject({
      draftSeason: '2026/27',
      draftPlayerIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      draftLockedPlayerIds: [1, 2],
      draftRevision: '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15',
      draftUpdatedAt: '2026-08-16T12:00:00Z',
      seasonModeManagerAccountId: 'acc-123',
      seasonModeSeason: '2026/27',
    })

    // Rejects 16 IDs
    await expect(updateUserState(db, {
      draftPlayerIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    })).rejects.toThrow('draftPlayerIds must contain exactly 15 unique integer player IDs')

    // Rejects updating player IDs if existing lock is excluded
    await expect(updateUserState(db, {
      draftPlayerIds: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    })).rejects.toThrow('Existing locked player 1 is not present in updated draft player IDs')

    // Clears locks and revision when draft is set to []
    await updateUserState(db, { draftPlayerIds: [] })
    const clearedState = await getUserState(db)
    expect(clearedState.preferences.draftPlayerIds).toEqual([])
    expect(clearedState.preferences.draftLockedPlayerIds).toEqual([])
    expect(clearedState.preferences.draftRevision).toBe('')
  })
})
