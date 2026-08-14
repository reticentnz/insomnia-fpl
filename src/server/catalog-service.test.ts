import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '../../scripts/db.mjs'
import { ingestOfficialFpl } from '../../scripts/ingest-fpl.mjs'
import { ingestMarketEvents } from '../../scripts/ingest-signals.mjs'
import { assembleProjectionInputCatalog } from './catalog-service.ts'
import { selectStrengthMethod } from '../core/projection.ts'

const temporaryDirectories: string[] = []
const fixtureDirectory = path.resolve('scripts', 'fixtures')
const fixture = <T>(name: string) => JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), 'utf8')) as T

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-wp05-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'database.sqlite')
}

async function seededDatabase() {
  const databasePath = temporaryDatabase()
  await ingestOfficialFpl({
    bootstrap: fixture<any>('wp02-bootstrap.json'), fixtures: fixture<any[]>('wp02-fixtures.json'),
    elementSummaries: { '10': fixture<any>('wp02-element-summary-10.json'), '11': fixture<any>('wp02-element-summary-11.json') },
    dbPath: databasePath, season: '2026/27', observedAt: '2026-08-15T12:00:00Z',
  })
  return { databasePath, db: getDb(databasePath) }
}

async function feedRun(db: ReturnType<typeof getDb>, id: string, source: string) {
  await db.query(`INSERT INTO "FeedRun" ("id", "source", "status", "started_at", "finished_at", "source_updated_at") VALUES ($1, $2, 'SUCCEEDED', '2026-08-15T11:00:00Z', '2026-08-15T11:01:00Z', '2026-08-15T11:00:00Z')`, [id, source])
}

afterEach(async () => {
  await closeDb()
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
})

describe('WP-05 projection input catalogue', () => {
  it('excludes post-asOf and unmatched facts while hashing canonical inputs deterministically', async () => {
    const { databasePath, db } = await seededDatabase()
    const player = (await db.query('SELECT "id" FROM "Player" WHERE "fpl_id"=10')).rows[0]
    await closeDb()
    const updatedBootstrap = fixture<any>('wp02-bootstrap.json')
    updatedBootstrap.elements[0].now_cost = 99
    await ingestOfficialFpl({
      bootstrap: updatedBootstrap, fixtures: fixture<any[]>('wp02-fixtures.json'),
      elementSummaries: { '10': fixture<any>('wp02-element-summary-10.json'), '11': fixture<any>('wp02-element-summary-11.json') },
      dbPath: databasePath, season: '2026/27', observedAt: '2026-08-15T12:01:00Z',
    })
    const dbAfterRefresh = getDb(databasePath)
    await feedRun(dbAfterRefresh, 'underlying-run', 'UNDERLYING')
    await dbAfterRefresh.query(`INSERT INTO "UnderlyingObservation" ("id","feed_run_id","source","source_player_id","source_player_name","season","player_id","match_status","match_confidence","observed_at","raw_payload_json") VALUES ('matched','underlying-run','test','10','Player Ten','2026/27',$1,'MATCHED',1,'2026-08-15T11:00:00Z','{}')`, [player.id])
    await dbAfterRefresh.query(`INSERT INTO "UnderlyingObservation" ("id","feed_run_id","source","source_player_id","source_player_name","season","player_id","match_status","match_confidence","observed_at","raw_payload_json") VALUES ('unmatched','underlying-run','test','missing','Unknown','2026/27',NULL,'UNMATCHED',0,'2026-08-15T11:00:00Z','{}')`)
    await dbAfterRefresh.query(`INSERT INTO "UnderlyingObservation" ("id","feed_run_id","source","source_player_id","source_player_name","season","player_id","match_status","match_confidence","observed_at","raw_payload_json") VALUES ('future','underlying-run','test','future','Future','2026/27',$1,'MATCHED',1,'2026-08-15T12:01:00Z','{}')`, [player.id])
    const first = await assembleProjectionInputCatalog(dbAfterRefresh, { asOf: '2026-08-15T12:00:00Z', underlyingMaxAgeMs: 60 * 60 * 1000 })
    const second = await assembleProjectionInputCatalog(dbAfterRefresh, { asOf: '2026-08-15T12:00:00Z', underlyingMaxAgeMs: 60 * 60 * 1000 })
    expect(first.inputHash).toBe(second.inputHash)
    expect(first.players.find(item => item.fplId === 10)?.underlying?.id).toBe('matched')
    expect(first.players.find(item => item.fplId === 10)?.provenance.underlyingObservationId).toBe('matched')
    expect((first.players.find(item => item.fplId === 10)?.official.price_tenths)).toBe(55)
  })

  it('uses only current verified signals and exposes a manual override as the effective provenance', async () => {
    const { db } = await seededDatabase()
    const player = (await db.query('SELECT "id" FROM "Player" WHERE "fpl_id"=10')).rows[0]
    const base = [player.id, 'START_PROBABILITY', '{"startProbability":0.4}', '2026-08-15T10:00:00Z']
    for (const [id, status, validUntil, sourceType, value, observedAt] of [
      ['pending', 'PENDING', '2026-08-16T12:00:00Z', 'RESEARCH', base[2], base[3]],
      ['expired', 'VERIFIED', '2026-08-15T11:00:00Z', 'RESEARCH', base[2], base[3]],
      ['verified', 'VERIFIED', '2026-08-16T12:00:00Z', 'RESEARCH', base[2], base[3]],
      ['manual', 'VERIFIED', '2026-08-16T12:00:00Z', 'MANUAL_OVERRIDE', '{"startProbability":0.9}', '2026-08-15T11:30:00Z'],
    ]) await db.query(`INSERT INTO "PlayerSignal" ("id","player_id","kind","value_json","source_type","evidence_summary","confidence","observed_at","valid_until","status","created_at","updated_at") VALUES ($1,$2,$3,$4,$5,$1,1,$6,$7,$8,$6,$6)`, [id, player.id, base[1], value, sourceType, observedAt, validUntil, status])
    const catalogue = await assembleProjectionInputCatalog(db, { asOf: '2026-08-15T12:00:00Z' })
    const signals = catalogue.players.find(item => item.fplId === 10)!.roleSignals
    expect(signals.map(signal => signal.id)).toEqual(['manual'])
    expect(catalogue.players.find(item => item.fplId === 10)!.provenance).toMatchObject({ eligibleSignalIds: ['manual', 'verified'], manualOverrideSignalIds: ['manual'] })
  })

  it('selects only complete derived market xG and exposes its method and age for debug provenance', async () => {
    const { db } = await seededDatabase()
    const market = {
      id: 'odds-100', commence_time: '2026-08-20T18:00:00Z', home_team: 'Alpha FC', away_team: 'Beta United',
      bookmakers: [{ markets: [
        { key: 'h2h', outcomes: [{ name: 'Alpha FC', price: 2 }, { name: 'Draw', price: 3.5 }, { name: 'Beta United', price: 4 }] },
        { key: 'totals', outcomes: [{ name: 'Over 2.5', price: 2 }, { name: 'Under 2.5', price: 2 }] },
        { key: 'btts', outcomes: [{ name: 'Yes', price: 1.8 }, { name: 'No', price: 2.2 }] },
      ] }],
    }
    await ingestMarketEvents(db, { season: '2026/27', events: [market], capturedAt: '2026-08-15T12:30:00Z' })
    const withMarket = await assembleProjectionInputCatalog(db, { asOf: '2026-08-15T13:00:00Z' })
    const selected = withMarket.players.find(player => player.fplId === 10)!.fixtures.find(fixture => fixture.fplId === 100)!.market
    expect(selected).toMatchObject({ derivationMethod: 'POISSON_MARKETS_V2', capturedAt: '2026-08-15T12:30:00Z', ageMs: 1_800_000 })
    expect(selectStrengthMethod({ market: selected, official: { attack: 1200, defence: 1100 } })).toBe('MARKET_XG')

    await db.query('DELETE FROM "MarketFixtureObservation"')
    const fallback = await assembleProjectionInputCatalog(db, { asOf: '2026-08-15T13:00:00Z' })
    const fixture = fallback.players.find(player => player.fplId === 10)!.fixtures.find(item => item.fplId === 100)!
    expect(fixture.market).toBeNull()
    expect(selectStrengthMethod({ market: fixture.market, official: { attack: 1200, defence: 1100 } })).toBe('OFFICIAL_STRENGTH')
  })
})
