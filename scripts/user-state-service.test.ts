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
})
