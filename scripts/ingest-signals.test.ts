import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from './db.mjs'
import { ingestOfficialFpl } from './ingest-fpl.mjs'
import { canonicalTeamIdentity, cleanSheetProbabilities, deriveExpectedGoals, eventTeamTotalsUrl, featuredOddsUrl, ingestMarketEvents, ingestUnderlyingRows, loadUnderstatRows, matchUnderlyingPlayer, redactedProviderUrl, resolveSignalSeason } from './ingest-signals.mjs'

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
const teamTotals = { key: 'team_totals', outcomes: [
  { name: 'Over', description: 'Alpha FC', point: 0.5, price: 1.25 },
  { name: 'Under', description: 'Alpha FC', point: 0.5, price: 4 },
  { name: 'Over', description: 'Beta United', point: 0.5, price: 1.5 },
  { name: 'Under', description: 'Beta United', point: 0.5, price: 2.5 },
] }

afterEach(async () => {
  await closeDb()
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('WP-07 optional source ingestion', () => {
  it('canonicalizes Odds API club names to their FPL equivalents', () => {
    const aliases = [
      ['Manchester United', 'Man Utd'],
      ['Nottingham Forest', "Nott'm Forest"],
      ['Leeds United', 'Leeds'],
      ['Tottenham Hotspur', 'Spurs'],
      ['Brighton and Hove Albion', 'Brighton'],
      ['Manchester City', 'Man City'],
      ['Newcastle United', 'Newcastle'],
    ]
    for (const [oddsName, fplName] of aliases) {
      expect(canonicalTeamIdentity(oddsName)).toBe(canonicalTeamIdentity(fplName))
    }
  })

  it('requests only markets supported by the featured odds endpoint', () => {
    const url = new URL(featuredOddsUrl({ apiKey: 'secret', regions: 'uk' }))
    expect(url.searchParams.get('markets')).toBe('h2h,totals')
    expect(url.searchParams.get('markets')).not.toContain('btts')
    const eventUrl = new URL(eventTeamTotalsUrl({ eventId: 'event/one', apiKey: 'secret', regions: 'uk' }))
    expect(eventUrl.pathname).toContain('/events/event%2Fone/odds')
    expect(eventUrl.searchParams.get('markets')).toBe('btts,team_totals')
  })

  it('redacts provider credentials from diagnostic URLs', () => {
    const value = redactedProviderUrl('https://example.test/odds?apiKey=super-secret&regions=uk')
    expect(value).not.toContain('super-secret')
    expect(value).toContain('%5BREDACTED%5D')
  })

  it('de-vigs opponent Under 0.5 team totals into clean-sheet probabilities', () => {
    expect(cleanSheetProbabilities([{ markets: [teamTotals] }], 'Alpha FC', 'Beta United')).toEqual({
      homeCleanSheet: 0.375,
      awayCleanSheet: 0.23809523809523808,
    })
    expect(cleanSheetProbabilities([], 'Alpha FC', 'Beta United')).toEqual({ homeCleanSheet: null, awayCleanSheet: null })
  })

  it('falls back to market-fitted Poisson clean-sheet probabilities when team totals are unavailable', () => {
    expect(cleanSheetProbabilities([], 'Alpha FC', 'Beta United', { homeExpectedGoals: 1.8, awayExpectedGoals: 1.1 })).toEqual({
      homeCleanSheet: Math.exp(-1.1),
      awayCleanSheet: Math.exp(-1.8),
    })
  })

  it('resolves the season from official data when no environment override exists', async () => {
    const db = await seed()
    expect(await resolveSignalSeason(db, { env: {} })).toBe('2026/27')
  })

  it('does not derive expected goals from H2H-only markets', () => {
    expect(deriveExpectedGoals({ homeWin: .5, draw: .25, awayWin: .25, over25: null, btts: null })).toBeNull()
  })

  it('derives expected goals from the H2H and totals markets returned by the featured endpoint', () => {
    const expected = deriveExpectedGoals({ homeWin: .5, draw: .25, awayWin: .25, over25: .5, btts: null })
    expect(expected).toMatchObject({ derivationMethod: 'POISSON_MARKETS_V2' })
    expect(expected.homeExpectedGoals).toBeGreaterThan(expected.awayExpectedGoals)
    expect(expected.homeExpectedGoals).toBeLessThan(3)
    expect(expected.awayExpectedGoals).toBeGreaterThan(.4)
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
    expect(matchUnderlyingPlayer({ player_name: 'Bruno Fernandes', team_title: 'Manchester United' }, [
      { id: 'bruno', web_name: 'B.Fernandes', first_name: 'Bruno', second_name: 'Borges Fernandes', team_name: 'Manchester United' },
    ])).toEqual({ status: 'MATCHED', confidence: 1, playerId: 'bruno' })
    expect(matchUnderlyingPlayer({ player_name: 'Transferred Player', team_title: 'Old Club' }, [
      { id: 'moved', web_name: 'Transferred Player', first_name: 'Transferred', second_name: 'Player', team_name: 'New Club' },
    ])).toEqual({ status: 'MATCHED', confidence: .85, playerId: 'moved' })
  })

  it('uses the completed prior Understat season when the new season has no player rows', async () => {
    const calls: string[] = []
    const fetchImpl = async (_url: string, options: any) => {
      const season = String(options.body.get('season'))
      calls.push(season)
      return { ok: true, json: async () => season === '2026' ? { players: [] } : { players: [{ id: '1', player_name: 'Prior Player' }] } } as any
    }
    const result = await loadUnderstatRows('2026/27', fetchImpl as any)
    expect(calls).toEqual(['2026', '2025'])
    expect(result).toMatchObject({ sourceSeason: 2025, rows: [expect.objectContaining({ _sourceSeason: '2025' })] })
  })

  it('stores expected goals when H2H and totals inputs are available', async () => {
    const db = await seed()
    await ingestMarketEvents(db, { season: '2026/27', capturedAt: '2026-08-15T12:30:00Z', events: [marketEvent([h2h])] })
    await ingestMarketEvents(db, { season: '2026/27', capturedAt: '2026-08-15T12:31:00Z', events: [marketEvent([h2h, totals])] })
    const rows = (await db.query('SELECT "home_expected_goals", "away_expected_goals", "derivation_method" FROM "MarketFixtureObservation" ORDER BY "captured_at"')).rows
    expect(rows[0]).toEqual({ home_expected_goals: null, away_expected_goals: null, derivation_method: null })
    expect(rows[1]).toMatchObject({ derivation_method: 'POISSON_MARKETS_V2' })
    expect(rows[1].home_expected_goals).toBeGreaterThan(0)
    expect(rows[1].away_expected_goals).toBeGreaterThan(0)
  })

  it('stores Poisson clean-sheet probabilities when team-total markets are unavailable', async () => {
    const db = await seed()
    await ingestMarketEvents(db, { season: '2026/27', capturedAt: '2026-08-15T12:31:00Z', events: [marketEvent([h2h, totals])] })
    const row = (await db.query('SELECT "home_clean_sheet_probability", "away_clean_sheet_probability", "home_expected_goals", "away_expected_goals" FROM "MarketFixtureObservation"')).rows[0]
    expect(row.home_clean_sheet_probability).toBeCloseTo(Math.exp(-row.away_expected_goals))
    expect(row.away_clean_sheet_probability).toBeCloseTo(Math.exp(-row.home_expected_goals))
  })

  it('stores clean-sheet probabilities from team-total markets', async () => {
    const db = await seed()
    await ingestMarketEvents(db, { season: '2026/27', capturedAt: '2026-08-15T12:31:00Z', events: [marketEvent([h2h, teamTotals])] })
    const row = (await db.query('SELECT "home_clean_sheet_probability", "away_clean_sheet_probability" FROM "MarketFixtureObservation"')).rows[0]
    expect(row.home_clean_sheet_probability).toBeCloseTo(0.375)
    expect(row.away_clean_sheet_probability).toBeCloseTo(0.238095)
  })
})
