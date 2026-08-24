import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../../scripts/db.mjs'
import { ingestOfficialFpl } from '../../scripts/ingest-fpl.mjs'
import { baseRole, catalogFixtureStrength, createForecastRun, latestEligibleForecastRun, latestForecastSummary } from './forecast-service.ts'
import { SIMULATION_ENGINE_VERSION, simulateFixtureOutcomes, simulateFromStoredForecast } from '../core/uncertainty.ts'

const directories: string[] = []
const fixture = <T>(name: string) => JSON.parse(fs.readFileSync(path.resolve('scripts/fixtures', name), 'utf8')) as T
function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-wp08-'))
  directories.push(directory)
  return path.join(directory, 'database.sqlite')
}
async function seeded() {
  const databasePath = temporaryDatabase()
  await ingestOfficialFpl({ bootstrap: fixture<any>('wp02-bootstrap.json'), fixtures: fixture<any[]>('wp02-fixtures.json'), elementSummaries: { '10': fixture<any>('wp02-element-summary-10.json'), '11': fixture<any>('wp02-element-summary-11.json') }, dbPath: databasePath, season: '2026/27', observedAt: '2026-08-15T12:00:00Z', finishedAt: '2026-08-15T12:01:00Z' })
  return getDb(databasePath)
}
afterEach(async () => { await closeDb(); while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true }) })

describe('WP-08 immutable forecast ledger', () => {
  it('normalizes early-season role evidence by completed matches', () => {
    const player = { official: { position: 'GK', status: 'a', chance_of_playing: null, minutes: 90, starts: 1 } } as any
    const starter = baseRole(player, 1)
    const unused = baseRole({ ...player, official: { ...player.official, minutes: 0, starts: 0 } }, 1)
    expect(starter.startProbability).toBeGreaterThan(.7)
    expect(unused.startProbability).toBeLessThan(.35)
    expect(starter.confidence).toBe('MEDIUM')
    expect(unused.confidence).toBe('LOW')
  })

  it('uses shrunk observed team xG ratings when official strengths and future odds are absent', () => {
    const team = (id: string, xg: number, xgc: number) => ({
      id: `p-${id}`, fplId: Number(id), name: id, team: { id, fplId: Number(id), name: id, shortName: id },
      official: { position: 'MID', status: 'a', minutes: 90, starts: 1, expected_goals: xg, expected_goals_conceded: xgc },
      teamStrength: { strengthAttackHome: 0, strengthDefenceHome: 0, strengthAttackAway: 0, strengthDefenceAway: 0 }, fixtures: [], underlying: null, roleSignals: [], provenance: {},
    }) as any
    const home = team('1', 2.1, .7), away = team('2', .7, 2.1)
    const catalog = { players: [home, away] } as any
    const fixture = { isHome: true, opponent: { id: '2', teamStrength: { strengthAttackAway: 0, strengthDefenceAway: 0 } }, market: null } as any
    const strength = catalogFixtureStrength(home, fixture, catalog, 1)
    expect(strength?.method).toBe('DERIVED_TEAM_RATING')
    expect(strength!.attackMultiplier).toBeGreaterThan(1)
    expect(strength!.defenceMultiplier).toBeLessThan(1)
  })

  it('treats a null FPL chance-of-playing value as healthy in GW1 forecasts', async () => {
    const databasePath = temporaryDatabase()
    const bootstrap = fixture<any>('wp02-bootstrap.json')
    bootstrap.elements[0].chance_of_playing_next_round = null
    bootstrap.elements[0].chance_of_playing_this_round = null
    await ingestOfficialFpl({ bootstrap, fixtures: fixture<any[]>('wp02-fixtures.json'), elementSummaries: { '10': fixture<any>('wp02-element-summary-10.json'), '11': fixture<any>('wp02-element-summary-11.json') }, dbPath: databasePath, season: '2026/27', observedAt: '2026-08-15T12:00:00Z', finishedAt: '2026-08-15T12:01:00Z' })
    const db = getDb(databasePath)

    const run = await createForecastRun(db, { asOf: '2026-08-15T12:00:00Z' })
    expect(run.status).toBe('SUCCEEDED')
    const role = (await db.query(`SELECT forecast."start_probability", forecast."no_show_probability", forecast."mean_points"
      FROM "PlayerFixtureForecast" forecast
      JOIN "Player" player ON player."id"=forecast."player_id"
      WHERE forecast."forecast_run_id"=$1 AND player."fpl_id"=10
      LIMIT 1`, [run.id])).rows[0]
    expect(Number(role.start_probability)).toBeGreaterThan(.5)
    expect(Number(role.no_show_probability)).toBeLessThan(.5)
    expect(Number(role.mean_points)).toBeGreaterThan(1)
  })

  it('creates immutable runs, marks deadline eligibility, and selects the latest eligible baseline', async () => {
    const db = await seeded()
    const first = await createForecastRun(db, { asOf: '2026-08-15T12:00:00Z', createdAt: '2026-08-20T12:00:00Z' })
    const second = await createForecastRun(db, { asOf: '2026-08-15T12:00:00Z', createdAt: '2026-08-21T17:00:00Z' })
    const late = await createForecastRun(db, { asOf: '2026-08-15T12:00:00Z', createdAt: '2026-08-21T18:31:00Z' })
    expect(first.status).toBe('SUCCEEDED'); expect(second.status).toBe('SUCCEEDED'); expect(late.status).toBe('SUCCEEDED')
    expect(first.eligibleForBacktest).toBe(true); expect(second.eligibleForBacktest).toBe(true)
    expect(new Set([first.id, second.id, late.id]).size).toBe(3)
    expect(late.eligibleForBacktest).toBe(false)
    const gameweek = (await db.query('SELECT "gameweek_id" FROM "ForecastRun" WHERE "id"=$1', [first.id])).rows[0].gameweek_id
    expect((await latestEligibleForecastRun(db, gameweek)).id).toBe(second.id)
    expect((await db.query('SELECT COUNT(*) AS count FROM "PlayerFixtureForecast" WHERE "forecast_run_id"=$1', [first.id])).rows[0].count).toBeGreaterThan(0)
    const outcome = (await db.query('SELECT "standard_deviation", "p10_points", "p50_points", "p90_points" FROM "PlayerFixtureForecast" WHERE "forecast_run_id"=$1 LIMIT 1', [first.id])).rows[0]
    expect(Number(outcome.standard_deviation)).toBeGreaterThanOrEqual(0)
    expect(Number(outcome.p10_points)).toBeLessThanOrEqual(Number(outcome.p50_points))
    expect(Number(outcome.p50_points)).toBeLessThanOrEqual(Number(outcome.p90_points))
    expect((await db.query('SELECT "config_json" FROM "ForecastRun" WHERE "id"=$1', [first.id])).rows[0].config_json).toContain('"simulationCount":2000')
  })

  it('retains a failed ledger row without partial children', async () => {
    const db = await seeded()
    const result = await createForecastRun(db, { asOf: '2026-08-15T12:00:00Z', projectFixture: () => { throw new Error('injected projection failure') } })
    expect(result.status).toBe('FAILED')
    expect((await db.query('SELECT "status", "error_summary" FROM "ForecastRun" WHERE "id"=$1', [result.id])).rows[0]).toMatchObject({ status: 'FAILED', error_summary: 'injected projection failure' })
    expect((await db.query('SELECT COUNT(*) AS count FROM "PlayerFixtureForecast" WHERE "forecast_run_id"=$1', [result.id])).rows[0].count).toBe(0)
  })

  it('regenerates bit-for-bit identical point and minute arrays from stored forecast ledger rows', async () => {
    const db = await seeded()
    const run = await createForecastRun(db, { asOf: '2026-08-15T12:00:00Z' })
    expect(run.status).toBe('SUCCEEDED')
    const forecastRow = (await db.query(`SELECT * FROM "PlayerFixtureForecast" WHERE "forecast_run_id"=$1 LIMIT 1`, [run.id])).rows[0]
    expect(forecastRow).toBeDefined()

    const roleSource = JSON.parse(forecastRow.role_source_json)
    expect(roleSource.simulationInput).toBeDefined()
    expect(roleSource.simulationInput).toMatchObject({ engineVersion: SIMULATION_ENGINE_VERSION, samples: 2_000 })
    expect(roleSource.simulationInput.role.startingMinutesSpread).toBeGreaterThanOrEqual(0)

    const directSimulation = simulateFixtureOutcomes(roleSource.simulationInput)
    const regenerated = simulateFromStoredForecast(forecastRow)

    expect(regenerated).not.toBeNull()
    expect(regenerated!.samples).toEqual(directSimulation.samples)
    expect(regenerated!.minuteSamples).toEqual(directSimulation.minuteSamples)
    expect(regenerated!.mean).toBeCloseTo(Number(forecastRow.mean_points), 4)
    expect(regenerated!.standardDeviation).toBeCloseTo(Number(forecastRow.standard_deviation), 4)
    expect(regenerated!.p10).toBeCloseTo(Number(forecastRow.p10_points), 4)
    expect(regenerated!.p50).toBeCloseTo(Number(forecastRow.p50_points), 4)
    expect(regenerated!.p90).toBeCloseTo(Number(forecastRow.p90_points), 4)
  })

  it('exposes aggregated football-event probabilities with the point distribution', async () => {
    const db = await seeded()
    const run = await createForecastRun(db, { asOf: '2026-08-15T12:00:00Z' })
    expect(run.status).toBe('SUCCEEDED')
    const summary = await latestForecastSummary(db, { horizon: 1 })
    const player = summary?.players[0]
    expect(player).toBeDefined()
    expect(player!.expectedGoals).toBeGreaterThanOrEqual(0)
    expect(player!.expectedAssists).toBeGreaterThanOrEqual(0)
    expect(player!.goalProbability).toBeGreaterThanOrEqual(0)
    expect(player!.goalProbability).toBeLessThanOrEqual(1)
    expect(player!.cleanSheetProbability).toBeGreaterThanOrEqual(0)
    expect(player!.cleanSheetProbability).toBeLessThanOrEqual(1)
  })

  it('refuses to fabricate empirical streams for legacy forecast rows without simulationInput', () => {
    const legacyRow = {
      player_id: 'p-1',
      fixture_id: 'f-1',
      mean_points: 5.5,
      standard_deviation: 2.0,
      p10_points: 3.0,
      p50_points: 5.5,
      p90_points: 8.0,
      start_probability: 0.9,
      no_show_probability: 0.05,
      role_source_json: JSON.stringify({ derivedSignalIds: ['sig-1'] }),
    }
    const result = simulateFromStoredForecast(legacyRow)
    expect(result).toBeNull()
  })
})
