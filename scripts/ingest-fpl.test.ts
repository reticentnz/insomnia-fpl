import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ingestOfficialFpl, refreshOfficialFpl, resolveOfficialCachePath, resolveSeason } from './ingest-fpl.mjs'

const temporaryDirectories: string[] = []
const fixtureDirectory = path.resolve('scripts', 'fixtures')

function readFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), 'utf8')) as T
}

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-wp02-'))
  temporaryDirectories.push(directory)
  return { directory, databasePath: path.join(directory, 'database.sqlite') }
}

function fixturePayloads() {
  return {
    bootstrap: readFixture<any>('wp02-bootstrap.json'),
    fixtures: readFixture<any[]>('wp02-fixtures.json'),
    elementSummaries: {
      '10': readFixture<any>('wp02-element-summary-10.json'),
      '11': readFixture<any>('wp02-element-summary-11.json'),
    },
  }
}

function queryRows(databasePath: string, sql: string, params: unknown[] = []) {
  const db = new DatabaseSync(databasePath)
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
})

describe('season resolution', () => {
  it('derives the season from the earliest official gameweek deadline', () => {
    vi.stubEnv('FPL_SEASON', '')
    vi.stubEnv('FPL_SEASON_START_YEAR', '')

    expect(resolveSeason({
      bootstrap: {
        events: [
          { deadline_time: '2026-08-21T17:30:00Z' },
          { deadline_time: '2026-08-14T17:30:00Z' },
        ],
      },
    })).toBe('2026/27')
  })

  it('keeps an explicit season override authoritative', () => {
    expect(resolveSeason({
      season: '2027/28',
      bootstrap: { events: [{ deadline_time: '2026-08-14T17:30:00Z' }] },
    })).toBe('2027/28')
  })
})

describe('official cache path resolution', () => {
  it('uses the legacy container cache setting instead of the read-only working directory', () => {
    expect(resolveOfficialCachePath({ env: { FPL_DATA_CACHE_FILE: '/app/data/cache/fpl-data.json' }, cwd: '/app' })).toBe('/app/data/cache/fpl-data.json')
  })

  it('prefers the dedicated setting and otherwise stores cache below the app data directory', () => {
    expect(resolveOfficialCachePath({ env: { FPL_INGEST_CACHE_PATH: '/data/official.json', FPL_DATA_CACHE_FILE: '/data/legacy.json' }, cwd: '/app' })).toBe('/data/official.json')
    expect(resolveOfficialCachePath({ env: { APP_DATA_DIR: '/app/data' }, cwd: '/app' })).toBe('/app/data/cache/fpl-official.json')
  })
})

describe('WP-02 official feed ingestion', () => {
  it('ingests saved official payloads with source freshness, news, prices and results', async () => {
    const { databasePath } = temporaryDatabase()
    const payloads = fixturePayloads()
    const sourceObservedAt = '2026-08-15T18:30:00Z'
    const result = await ingestOfficialFpl({
      ...payloads,
      dbPath: databasePath,
      season: '2026/27',
      startedAt: '2026-08-15T18:31:00Z',
      observedAt: sourceObservedAt,
      finishedAt: '2026-08-15T18:31:05Z',
    })

    expect(result.status).toBe('SUCCEEDED')
    expect(result.counts).toMatchObject({ teams: 2, gameweeks: 2, fixtures: 2, players: 2, resultsInserted: 2 })
    expect(result.freshnessAt).toBe(sourceObservedAt)

    const feedRuns = queryRows(databasePath, 'SELECT * FROM "FeedRun"') as any[]
    expect(feedRuns).toHaveLength(1)
    expect(feedRuns[0]).toMatchObject({
      status: 'SUCCEEDED',
      started_at: '2026-08-15T18:31:00Z',
      finished_at: '2026-08-15T18:31:05Z',
      source_updated_at: sourceObservedAt,
      used_cache: 0,
    })
    expect(feedRuns[0].payload_hash).toMatch(/^[a-f0-9]{64}$/)

    const player = queryRows(
      databasePath,
      'SELECT * FROM "PlayerObservation" WHERE "player_id"=?',
      ['player:2026%2F27:10'],
    ) as any[]
    expect(player).toHaveLength(1)
    expect(player[0]).toMatchObject({
      news: 'Available after a full training week.',
      news_added_at: '2026-08-13T09:15:00Z',
      price_tenths: 55,
      ownership_percent: 10.5,
      expected_goal_involvements: 0.6,
      defensive_contribution: 6.2,
    })
    expect(JSON.parse(player[0].raw_payload_json).id).toBe(10)

    const counts = queryRows(databasePath, `
      SELECT
        (SELECT COUNT(*) FROM "TeamObservation") AS team_observations,
        (SELECT COUNT(*) FROM "GameweekObservation") AS gameweek_observations,
        (SELECT COUNT(*) FROM "FixtureObservation") AS fixture_observations,
        (SELECT COUNT(*) FROM "PlayerObservation") AS player_observations,
        (SELECT COUNT(*) FROM "PlayerFixtureResult") AS results,
        (SELECT COUNT(*) FROM "ForecastRun") AS forecast_runs,
        (SELECT COUNT(*) FROM "PlayerFixtureForecast") AS forecasts
    `) as any[]
    expect(counts[0]).toMatchObject({
      team_observations: 2,
      gameweek_observations: 2,
      fixture_observations: 2,
      player_observations: 2,
      results: 2,
      forecast_runs: 1,
      forecasts: 2,
    })

    await ingestOfficialFpl({
      ...payloads,
      dbPath: databasePath,
      season: '2027/28',
      startedAt: '2027-08-15T18:31:00Z',
      observedAt: '2027-08-15T18:30:00Z',
      finishedAt: '2027-08-15T18:31:05Z',
    })
    const seasonScopedIds = queryRows(
      databasePath,
      'SELECT "season", "id" FROM "Player" WHERE "fpl_id"=? ORDER BY "season"',
      [10],
    ) as any[]
    const fixtureScopedIds = queryRows(
      databasePath,
      'SELECT "season", "id" FROM "Fixture" WHERE "fpl_id"=? ORDER BY "season"',
      [100],
    ) as any[]
    expect(seasonScopedIds).toHaveLength(2)
    expect(seasonScopedIds[0].id).not.toBe(seasonScopedIds[1].id)
    expect(fixtureScopedIds[0].id).not.toBe(fixtureScopedIds[1].id)
  })

  it('rolls back fact writes and retains a sanitized failed feed run', async () => {
    const { databasePath } = temporaryDatabase()
    await expect(ingestOfficialFpl({
      ...fixturePayloads(),
      dbPath: databasePath,
      season: '2026/27',
      startedAt: '2026-08-15T18:31:00Z',
      observedAt: '2026-08-15T18:30:00Z',
      finishedAt: '2026-08-15T18:31:05Z',
      failureAfterStage: 'teams',
    })).rejects.toThrow('Injected failure after teams writes')

    const counts = queryRows(databasePath, `
      SELECT
        (SELECT COUNT(*) FROM "Team") AS teams,
        (SELECT COUNT(*) FROM "TeamObservation") AS team_observations,
        (SELECT COUNT(*) FROM "Gameweek") AS gameweeks,
        (SELECT COUNT(*) FROM "Fixture") AS fixtures,
        (SELECT COUNT(*) FROM "Player") AS players,
        (SELECT COUNT(*) FROM "PlayerObservation") AS player_observations
    `) as any[]
    expect(counts[0]).toEqual({ teams: 0, team_observations: 0, gameweeks: 0, fixtures: 0, players: 0, player_observations: 0 })

    const failed = queryRows(databasePath, 'SELECT * FROM "FeedRun"') as any[]
    expect(failed).toHaveLength(1)
    expect(failed[0].status).toBe('FAILED')
    expect(failed[0].error_summary).toContain('Injected failure after teams writes')
    expect(failed[0].error_summary).not.toContain('secret')
    expect(failed[0].finished_at).toBe('2026-08-15T18:31:05Z')
  })

  it('keeps stable identities while recording immutable observations on repeated ingestion', async () => {
    const { databasePath } = temporaryDatabase()
    const payloads = fixturePayloads()
    const first = await ingestOfficialFpl({ ...payloads, dbPath: databasePath, season: '2026/27', observedAt: '2026-08-15T18:30:00Z' })
    const second = await ingestOfficialFpl({ ...payloads, dbPath: databasePath, season: '2026/27', observedAt: '2026-08-15T19:30:00Z' })

    expect(first.feedRunId).not.toBe(second.feedRunId)
    expect(second.counts.resultsSkipped).toBe(2)
    const counts = queryRows(databasePath, `
      SELECT
        (SELECT COUNT(*) FROM "FeedRun") AS feed_runs,
        (SELECT COUNT(*) FROM "Team") AS teams,
        (SELECT COUNT(*) FROM "Fixture") AS fixtures,
        (SELECT COUNT(*) FROM "Player") AS players,
        (SELECT COUNT(*) FROM "TeamObservation") AS team_observations,
        (SELECT COUNT(*) FROM "GameweekObservation") AS gameweek_observations,
        (SELECT COUNT(*) FROM "FixtureObservation") AS fixture_observations,
        (SELECT COUNT(*) FROM "PlayerObservation") AS player_observations,
        (SELECT COUNT(*) FROM "PlayerFixtureResult") AS results
    `) as any[]
    expect(counts[0]).toEqual({
      feed_runs: 2,
      teams: 2,
      fixtures: 2,
      players: 2,
      team_observations: 4,
      gameweek_observations: 4,
      fixture_observations: 4,
      player_observations: 4,
      results: 2,
    })
  })

  it('uses an eligible cache as a partial refresh without making it fresh', async () => {
    const { directory, databasePath } = temporaryDatabase()
    const payloads = fixturePayloads()
    const cacheCapturedAt = new Date().toISOString()
    const sourceUpdatedAt = '2026-08-15T18:30:00Z'
    const cachePath = path.join(directory, 'official-cache.json')
    fs.writeFileSync(cachePath, JSON.stringify({ ...payloads, capturedAt: cacheCapturedAt, sourceUpdatedAt }))

    const result = await refreshOfficialFpl({
      dbPath: databasePath,
      season: '2026/27',
      cachePath,
      cacheMaxAgeMs: 60 * 60 * 1000,
      startedAt: '2026-08-15T19:00:00Z',
      finishedAt: '2026-08-15T19:00:05Z',
      fetchJson: async () => { throw new Error('request failed with token=supersecret') },
    })

    expect(result.status).toBe('PARTIAL')
    const feedRun = queryRows(databasePath, 'SELECT * FROM "FeedRun"') as any[]
    expect(feedRun[0]).toMatchObject({
      status: 'PARTIAL',
      used_cache: 1,
      cache_captured_at: cacheCapturedAt,
      source_updated_at: sourceUpdatedAt,
      finished_at: '2026-08-15T19:00:05Z',
    })
    expect(feedRun[0].error_summary).toContain('using eligible cache')
    expect(feedRun[0].error_summary).not.toContain('supersecret')
  })
})
