import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDb } from './db.mjs'
import { migrateDatabase } from './db-migrate.mjs'
import { loadUnderstatRows, matchUnderlyingPlayer } from './ingest-signals.mjs'

const ARCHIVE_SOURCE = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data'
const cacheDir = process.env.FPL_DATA_CACHE_FILE ? path.join(path.dirname(process.env.FPL_DATA_CACHE_FILE), 'historical-priors') : path.resolve(process.cwd(), '.cache', 'historical-priors')
const headers = { 'user-agent': 'Insomnia-FPL/1.0 (+local analytics)', accept: 'text/csv,application/json' }
const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0

/** Small CSV parser for quoted fields in the FPL archive. */
export function parseCsv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1 }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(field); field = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field); field = ''
      if (row.some(value => value !== '')) rows.push(row)
      row = []
    } else field += char
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const [header = [], ...values] = rows
  return values.map(value => Object.fromEntries(header.map((key, index) => [key, value[index] ?? ''])))
}

async function cachedValue(name, loader) {
  const filename = path.join(cacheDir, name)
  try {
    const payload = await loader()
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(filename, JSON.stringify({ capturedAt: new Date().toISOString(), payload }))
    return { payload, cached: false }
  } catch (error) {
    if (!fs.existsSync(filename)) throw error
    return { payload: JSON.parse(fs.readFileSync(filename, 'utf8')).payload, cached: true }
  }
}

export async function fetchHistoricalFplRows(season, fetchImpl = fetch) {
  const url = `${ARCHIVE_SOURCE}/${encodeURIComponent(season)}/players_raw.csv`
  const response = await fetchImpl(url, { headers })
  if (!response.ok) throw new Error(`FPL archive returned HTTP ${response.status}`)
  return parseCsv(await response.text())
}

async function currentPlayers(db, season) {
  return (await db.query(`SELECT player."id", player."web_name", player."first_name", player."second_name", team."name" AS "team_name"
    FROM "Player" player JOIN "PlayerObservation" observation ON observation."player_id"=player."id" JOIN "Team" team ON team."id"=observation."team_id"
    WHERE player."season"=$1 AND observation."observed_at"=(SELECT MAX(candidate."observed_at") FROM "PlayerObservation" candidate WHERE candidate."player_id"=player."id")`, [season])).rows
}

function priorFromUnderstat(row, sourceSeason) {
  return { source: 'UNDERSTAT', sourceSeason, sourcePlayerId: String(row.id || row.player_id || ''), sourcePlayerName: String(row.player_name || ''), lookup: { player_name: row.player_name, team_title: row.team_title }, minutes: finite(row.time), starts: 0, totalPoints: 0, goals: finite(row.goals), assists: finite(row.assists), bonus: 0, bps: 0, expectedGoals: finite(row.xG), expectedAssists: finite(row.xA), nonPenaltyExpectedGoals: finite(row.npxG), shots: finite(row.shots), keyPasses: finite(row.key_passes), raw: row }
}

function priorFromFpl(row, sourceSeason) {
  const name = [row.first_name, row.second_name].filter(Boolean).join(' ') || row.web_name
  return { source: 'FPL_ARCHIVE', sourceSeason, sourcePlayerId: String(row.id || row.code || row.web_name), sourcePlayerName: String(name), lookup: { player_name: name, team_title: null }, minutes: finite(row.minutes), starts: finite(row.starts), totalPoints: finite(row.total_points), goals: finite(row.goals_scored), assists: finite(row.assists), bonus: finite(row.bonus), bps: finite(row.bps), expectedGoals: finite(row.expected_goals), expectedAssists: finite(row.expected_assists), nonPenaltyExpectedGoals: 0, shots: 0, keyPasses: 0, raw: row }
}

export async function persistHistoricalPriors(db, { season, priors, capturedAt = new Date().toISOString() }) {
  const players = await currentPlayers(db, season)
  let inserted = 0, unmatched = 0
  for (const prior of priors) {
    const match = matchUnderlyingPlayer(prior.lookup, players)
    if (match.status !== 'MATCHED') { unmatched += 1; continue }
    await db.query(`INSERT INTO "HistoricalPlayerPrior" ("id","current_player_id","source","source_season","source_player_id","source_player_name","match_confidence","captured_at","minutes","starts","total_points","goals","assists","bonus","bps","expected_goals","expected_assists","non_penalty_expected_goals","shots","key_passes","raw_payload_json") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT("source","source_season","source_player_id") DO UPDATE SET "current_player_id"=excluded."current_player_id", "match_confidence"=excluded."match_confidence", "captured_at"=excluded."captured_at", "minutes"=excluded."minutes", "starts"=excluded."starts", "total_points"=excluded."total_points", "goals"=excluded."goals", "assists"=excluded."assists", "bonus"=excluded."bonus", "bps"=excluded."bps", "expected_goals"=excluded."expected_goals", "expected_assists"=excluded."expected_assists", "non_penalty_expected_goals"=excluded."non_penalty_expected_goals", "shots"=excluded."shots", "key_passes"=excluded."key_passes", "raw_payload_json"=excluded."raw_payload_json"`, [randomUUID(), match.playerId, prior.source, prior.sourceSeason, prior.sourcePlayerId, prior.sourcePlayerName, match.confidence, capturedAt, prior.minutes, prior.starts, prior.totalPoints, prior.goals, prior.assists, prior.bonus, prior.bps, prior.expectedGoals, prior.expectedAssists, prior.nonPenaltyExpectedGoals, prior.shots, prior.keyPasses, JSON.stringify(prior.raw)])
    inserted += 1
  }
  return { inserted, unmatched }
}

export async function ingestHistoricalPriors({ db, season, sourceSeason, fetchImpl = fetch } = {}) {
  const currentSeason = String(season || process.env.FPL_SEASON || '')
  if (!/^\d{4}\/\d{2}$/.test(currentSeason)) throw new Error('Set FPL_SEASON (for example 2026/27) before importing historical priors')
  const priorSeason = sourceSeason || `${Number(currentSeason.slice(0, 4)) - 1}-${currentSeason.slice(0, 4).slice(2)}`
  const understatYear = Number(priorSeason.slice(0, 4))
  const [understat, archivedFpl] = await Promise.all([
    cachedValue(`understat-epl-${understatYear}.json`, async () => (await loadUnderstatRows(`${understatYear}/${String(understatYear + 1).slice(-2)}`, fetchImpl)).rows),
    cachedValue(`fpl-${priorSeason}-players_raw.json`, async () => fetchHistoricalFplRows(priorSeason, fetchImpl)),
  ])
  const capturedAt = new Date().toISOString()
  const understatResult = await persistHistoricalPriors(db, { season: currentSeason, capturedAt, priors: understat.payload.map(row => priorFromUnderstat(row, priorSeason)) })
  const fplResult = await persistHistoricalPriors(db, { season: currentSeason, capturedAt, priors: archivedFpl.payload.map(row => priorFromFpl(row, priorSeason)) })
  return { sourceSeason: priorSeason, understat: { ...understatResult, cached: understat.cached }, fplArchive: { ...fplResult, cached: archivedFpl.cached } }
}

async function main() {
  await migrateDatabase()
  const db = getDb()
  try {
    const result = await ingestHistoricalPriors({ db, sourceSeason: process.argv[2] })
    console.log(`Historical ${result.sourceSeason}: Understat ${result.understat.inserted} matched (${result.understat.unmatched} unmatched)${result.understat.cached ? ' from cache' : ''}; FPL archive ${result.fplArchive.inserted} matched (${result.fplArchive.unmatched} unmatched)${result.fplArchive.cached ? ' from cache' : ''}`)
  } finally { await closeDb() }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
