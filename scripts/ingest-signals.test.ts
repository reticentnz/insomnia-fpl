import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from './db.mjs'
import { ingestOfficialFpl } from './ingest-fpl.mjs'
import { deriveExpectedGoals, ingestMarketEvents, ingestUnderlyingRows, matchUnderlyingPlayer, resolveSignalSeason } from './ingest-signals.mjs'

const directories: string[] = []
const fixtureDirectory = path.resolve('scripts', 'fixtures')
const fixture = <T>(name: string) => JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), 'utf8')) as T

async function seed() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-wp07-'))
  directories.push(directory)
  const databasePath = path.join(directory, 'database.sqlite')
  await ingestOfficialFpl({
    bootstrap: fixture('wp02-bootstrap.json'), fixtures: fixture('wp02-fixtures.json'),
    elementSummaries: { 10: fixture('wp02-element-summary-10.json'), 11: fixture('wp02-element-summary-11.json') },
    dbPath: databasePath, season: '2026/27', observedAt: '2026-08-15T12:00:00Z',
  })
  return getDb(databasePath)
}

const marketEvent = (markets: any[]) => ({ id: 'odds-100', commence_time: '2026-08-20T18:00:00Z', home_team: 'Alpha FC', away_team: 'Beta United', bookmakers: [{ markets }] })
const h2h = { key: 'h2h', outcomes: [{ name: 'Alpha FC', price: 2 }, { name: 'Draw', price: 3.5 }, { name: 'Beta United', price: 4 }] }
const totals = { key: 'totals', outcomes: [{ name: 'Over 2.5', price: 2 }, { name: 'Under 2.5', price: 2 }] }
const btts = { key: 'btts', outcomes: [{ name: 'Yes', price: 1.8 }, { name: 'No', price: 2.2 }] }

afterEach(async () => {
  await closeDb()
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('WP-07 optional source ingestion', () => {
  it('resolves the season from official data when no environment override exists', async () => {
    const db = await seed()
    expect(await resolveSignalSeason(db, { env: {} })).toBe('2026/27')
  })

  it('does not derive expected goals from H2H-only markets', () => {
    expect(deriveExpectedGoals({ homeWin: .5, draw: .25, awayWin: .25, over25: null, btts: null })).toBeNull()
  })

  it('records reviewable underlying statuses and never auto-selects ambiguous identities', async () => {
    const db = await seed()
    const result = await ingestUnderlyingRows(db, { season: '2026/27', observedAt: '2026-08-15T12:30:00Z', rows: [
      { id: 'match', player_name: 'A Alpha', team_title: 'Alpha FC', time: 90, xG: .5, xA: .2 },
      { id: 'unmatched', player_name: 'Nobody', team_title: 'Unknown', time: 90 },
    ] })
    expect(result).toMatchObject({ inserted: 2, unmatched: 1 })
    const rows = (await db.query('SELECT "source_player_id", "player_id", "match_status", "match_confidence" FROM "UnderlyingObservation" ORDER BY "source_player_id"')).rows
    expect(rows).toEqual([
      expect.objectContaining({ source_player_id: 'match', match_status: 'MATCHED', match_confidence: 1 }),
      expect.objectContaining({ source_player_id: 'unmatched', player_id: null, match_status: 'UNMATCHED', match_confidence: 0 }),
    ])
    expect(matchUnderlyingPlayer({ player_name: 'Same Name', team_title: 'Alpha' }, [
      { id: 'one', web_name: 'Same Name', team_name: 'Alpha' }, { id: 'two', web_name: 'Same Name', team_name: 'Alpha' },
    ])).toEqual({ status: 'AMBIGUOUS', confidence: 0, playerId: null })
  })

  it('stores expected goals only when complete goal-market inputs are available', async () => {
    const db = await seed()
    await ingestMarketEvents(db, { season: '2026/27', capturedAt: '2026-08-15T12:30:00Z', events: [marketEvent([h2h])] })
    await ingestMarketEvents(db, { season: '2026/27', capturedAt: '2026-08-15T12:31:00Z', events: [marketEvent([h2h, totals, btts])] })
    const rows = (await db.query('SELECT "home_expected_goals", "away_expected_goals", "derivation_method" FROM "MarketFixtureObservation" ORDER BY "captured_at"')).rows
    expect(rows[0]).toEqual({ home_expected_goals: null, away_expected_goals: null, derivation_method: null })
    expect(rows[1]).toMatchObject({ derivation_method: 'POISSON_MARKETS_V1' })
    expect(rows[1].home_expected_goals).toBeGreaterThan(0)
    expect(rows[1].away_expected_goals).toBeGreaterThan(0)
  })
})
