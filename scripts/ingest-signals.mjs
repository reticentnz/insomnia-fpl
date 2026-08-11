import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { closeDb, getDb } from './db.mjs'
import { migrateDatabase } from './db-migrate.mjs'
import { failFeedRun, hashPayload, startFeedRun, succeedFeedRun } from './feed-run.mjs'

export const UNDERLYING_SOURCE = 'UNDERSTAT'
export const MARKET_SOURCE = 'ODDS_MARKET'
export const MARKET_XG_METHOD = 'POISSON_MARKETS_V1'

const defaultCacheDir = process.env.FPL_DATA_CACHE_FILE
  ? path.join(path.dirname(process.env.FPL_DATA_CACHE_FILE), 'signal-feeds')
  : path.resolve(process.cwd(), '.cache', 'signal-feeds')
const headers = { 'user-agent': 'Insomnia-FPL/1.0 (+local analytics)', accept: 'text/html,application/json' }

const finite = value => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function normalizeIdentity(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|afc|football club)\b/g, '').replace(/[^a-z0-9]/g, '')
}

function decodeSingleQuotedJs(value) {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char !== '\\') { output += char; continue }
    const next = value[++index]
    if (next === 'n') output += '\n'
    else if (next === 'r') output += '\r'
    else if (next === 't') output += '\t'
    else if (next === 'b') output += '\b'
    else if (next === 'f') output += '\f'
    else if (next === 'x') { output += String.fromCharCode(parseInt(value.slice(index + 1, index + 3), 16)); index += 2 }
    else if (next === 'u') { output += String.fromCharCode(parseInt(value.slice(index + 1, index + 5), 16)); index += 4 }
    else output += next
  }
  return output
}

export function extractUnderstatJson(html, variable) {
  const prefix = `(?:var|let|const)?\\s*${variable}\\s*=\\s*`
  const single = html.match(new RegExp(`${prefix}JSON\\.parse\\(\\s*'((?:\\\\.|[^'])*)'\\s*\\)`, 'i'))
  const double = html.match(new RegExp(`${prefix}JSON\\.parse\\(\\s*"((?:\\\\.|[^"])*)"\\s*\\)`, 'i'))
  const match = single || double
  if (match) return JSON.parse(decodeSingleQuotedJs(match[1]))
  const direct = html.match(new RegExp(`${prefix}([\\[]|[\\{])`, 'i'))
  if (direct) {
    const start = direct.index + direct[0].length - 1
    const opening = html[start]
    const closing = opening === '[' ? ']' : '}'
    let depth = 0
    let quoted = false
    let escaped = false
    for (let index = start; index < html.length; index += 1) {
      const char = html[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (char === '"') { quoted = true; continue }
      if (char === opening) depth += 1
      if (char === closing && --depth === 0) return JSON.parse(html.slice(start, index + 1))
    }
  }
  const pageHint = /cloudflare|captcha|access denied|just a moment/i.test(html) ? ' (the page appears to be a bot-protection challenge)' : ''
  throw new Error(`Understat response did not contain ${variable}${pageHint}`)
}

export function matchUnderlyingPlayer(row, players) {
  const nameMatches = players.filter(player => normalizeIdentity(player.web_name) === normalizeIdentity(row.player_name))
  const teamMatches = row.team_title
    ? nameMatches.filter(player => normalizeIdentity(player.team_name) === normalizeIdentity(row.team_title))
    : nameMatches
  if (teamMatches.length === 1) return { status: 'MATCHED', confidence: 1, playerId: teamMatches[0].id }
  if (teamMatches.length > 1 || (nameMatches.length > 0 && row.team_title)) return { status: 'AMBIGUOUS', confidence: 0, playerId: null }
  return { status: 'UNMATCHED', confidence: 0, playerId: null }
}

export function marketProbabilities(bookmakers, marketKey) {
  const observations = []
  for (const bookmaker of bookmakers || []) {
    const market = (bookmaker.markets || []).find(candidate => candidate.key === marketKey)
    if (!market) continue
    const prices = (market.outcomes || []).map(outcome => ({ name: outcome.name, price: finite(outcome.price) })).filter(item => item.price > 1)
    const denominator = prices.reduce((sum, item) => sum + 1 / item.price, 0)
    if (!denominator) continue
    observations.push(Object.fromEntries(prices.map(item => [item.name, (1 / item.price) / denominator])))
  }
  if (!observations.length) return null
  const names = [...new Set(observations.flatMap(observation => Object.keys(observation)))].sort()
  return Object.fromEntries(names.map(name => [name, observations.reduce((sum, observation) => sum + (observation[name] || 0), 0) / observations.length]))
}

function poisson(value, lambda) {
  let term = Math.exp(-lambda)
  let sum = term
  for (let index = 1; index <= value; index += 1) { term *= lambda / index; sum += term }
  return sum
}

function marketMetrics(home, away) {
  let homeWin = 0; let draw = 0; let over25 = 0; let btts = 0
  for (let homeGoals = 0; homeGoals <= 12; homeGoals += 1) for (let awayGoals = 0; awayGoals <= 12; awayGoals += 1) {
    const probability = poisson(homeGoals, home) * poisson(awayGoals, away)
    if (homeGoals > awayGoals) homeWin += probability
    if (homeGoals === awayGoals) draw += probability
    if (homeGoals + awayGoals > 2) over25 += probability
    if (homeGoals > 0 && awayGoals > 0) btts += probability
  }
  return { homeWin, draw, over25, btts }
}

/** Fit independent home/away Poisson rates to de-vigged H2H, totals and BTTS markets. */
export function deriveExpectedGoals(probabilities) {
  const homeWin = finite(probabilities?.homeWin)
  const draw = finite(probabilities?.draw)
  const awayWin = finite(probabilities?.awayWin)
  const over25 = finite(probabilities?.over25)
  const btts = finite(probabilities?.btts)
  if (![homeWin, draw, awayWin, over25, btts].every(value => value > 0 && value < 1)) return null
  if (Math.abs(homeWin + draw + awayWin - 1) > 0.04) return null
  let best = null
  for (let home = 0.2; home <= 4.5; home += 0.05) for (let away = 0.2; away <= 4.5; away += 0.05) {
    const fit = marketMetrics(home, away)
    const score = (fit.homeWin - homeWin) ** 2 + (fit.draw - draw) ** 2 + ((1 - fit.homeWin - fit.draw) - awayWin) ** 2 + (fit.over25 - over25) ** 2 + (fit.btts - btts) ** 2
    if (!best || score < best.score) best = { home, away, score }
  }
  return { homeExpectedGoals: Number(best.home.toFixed(2)), awayExpectedGoals: Number(best.away.toFixed(2)), derivationMethod: MARKET_XG_METHOD }
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.json()
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, { headers })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.text()
}

export function featuredOddsUrl({ apiKey, regions = 'uk' } = {}) {
  const params = new URLSearchParams({
    regions: String(regions),
    markets: 'h2h,totals',
    oddsFormat: 'decimal',
    dateFormat: 'iso',
    apiKey: String(apiKey || ''),
  })
  return `https://api.the-odds-api.com/v4/sports/soccer_epl/odds?${params}`
}

async function withCache(name, loader, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const filename = path.join(cacheDir, name)
  try {
    const fresh = await loader()
    fs.writeFileSync(filename, JSON.stringify({ capturedAt: new Date().toISOString(), payload: fresh }))
    return { payload: fresh, usedCache: false, cacheCapturedAt: null }
  } catch (error) {
    if (!fs.existsSync(filename)) throw error
    const cached = JSON.parse(fs.readFileSync(filename, 'utf8'))
    return { payload: cached.payload, usedCache: true, cacheCapturedAt: cached.capturedAt }
  }
}

async function currentSeasonPlayers(db, season) {
  return (await db.query(`SELECT player."id", player."web_name", team."name" AS "team_name"
    FROM "Player" player JOIN "PlayerObservation" observation ON observation."player_id"=player."id"
    JOIN "Team" team ON team."id"=observation."team_id"
    WHERE player."season"=$1
    AND observation."observed_at"=(SELECT MAX(candidate."observed_at") FROM "PlayerObservation" candidate WHERE candidate."player_id"=player."id")`, [season])).rows
}

async function currentSeasonFixtures(db, season) {
  return (await db.query(`SELECT fixture."id", home."name" AS "home_team_name", away."name" AS "away_team_name"
    FROM "Fixture" fixture JOIN "Team" home ON home."id"=fixture."home_team_id" JOIN "Team" away ON away."id"=fixture."away_team_id"
    WHERE fixture."season"=$1`, [season])).rows
}

function matchFixture(event, fixtures) {
  const matches = fixtures.filter(fixture => normalizeIdentity(fixture.home_team_name) === normalizeIdentity(event.home_team) && normalizeIdentity(fixture.away_team_name) === normalizeIdentity(event.away_team))
  return matches.length === 1 ? matches[0].id : null
}

export async function ingestUnderlyingRows(db, { season, rows, observedAt = new Date().toISOString(), source = UNDERLYING_SOURCE, feedDetails = {} }) {
  const runId = await startFeedRun(db, { source: 'UNDERLYING', startedAt: observedAt, sourceUpdatedAt: observedAt, payloadHash: hashPayload(rows), requestCount: feedDetails.requestCount || 1 })
  try {
    const players = await currentSeasonPlayers(db, season)
    let inserted = 0; let unmatched = 0
    for (const row of rows) {
      const match = matchUnderlyingPlayer(row, players)
      if (match.status !== 'MATCHED') unmatched += 1
      const minutes = finite(row.time)
      const xg = finite(row.xG); const xa = finite(row.xA)
      await db.query(`INSERT INTO "UnderlyingObservation" ("id","feed_run_id","source","source_player_id","source_player_name","source_team_name","season","player_id","match_status","match_confidence","observed_at","games","minutes","goals","assists","shots","key_passes","expected_goals","expected_assists","non_penalty_expected_goals","xg_per_90","xa_per_90","raw_payload_json") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`, [randomUUID(), runId, source, String(row.id || row.player_id || ''), String(row.player_name || ''), row.team_title || null, season, match.playerId, match.status, match.confidence, observedAt, finite(row.games), minutes, finite(row.goals), finite(row.assists), finite(row.shots), finite(row.key_passes), xg, xa, finite(row.npxG), minutes ? xg / minutes * 90 : 0, minutes ? xa / minutes * 90 : 0, JSON.stringify(row)])
      inserted += 1
    }
    await succeedFeedRun(db, runId, { finishedAt: new Date().toISOString(), insertedCount: inserted, unmatchedCount: unmatched, usedCache: feedDetails.usedCache, cacheCapturedAt: feedDetails.cacheCapturedAt })
    return { runId, inserted, unmatched }
  } catch (error) {
    await failFeedRun(db, runId, error)
    throw error
  }
}

export async function ingestMarketEvents(db, { season, events, capturedAt = new Date().toISOString(), source = MARKET_SOURCE, feedDetails = {} }) {
  const runId = await startFeedRun(db, { source: 'MARKET', startedAt: capturedAt, sourceUpdatedAt: capturedAt, payloadHash: hashPayload(events), requestCount: feedDetails.requestCount || 1 })
  try {
    const fixtures = await currentSeasonFixtures(db, season)
    let inserted = 0; let unmatched = 0
    for (const event of events) {
      const h2h = marketProbabilities(event.bookmakers, 'h2h')
      const totals = marketProbabilities(event.bookmakers, 'totals')
      const btts = marketProbabilities(event.bookmakers, 'btts')
      const homeWin = h2h?.[event.home_team] ?? null
      const draw = h2h?.Draw ?? null
      const awayWin = h2h?.[event.away_team] ?? null
      const over25 = totals?.['Over 2.5'] ?? totals?.Over ?? null
      const bothTeamsToScore = btts?.Yes ?? null
      const expected = deriveExpectedGoals({ homeWin, draw, awayWin, over25, btts: bothTeamsToScore })
      const fixtureId = matchFixture(event, fixtures)
      if (!fixtureId) unmatched += 1
      await db.query(`INSERT INTO "MarketFixtureObservation" ("id","feed_run_id","source","external_event_id","fixture_id","captured_at","kickoff_at","home_team_name","away_team_name","home_win_probability","draw_probability","away_win_probability","over_2_5_probability","btts_probability","home_expected_goals","away_expected_goals","derivation_method","raw_payload_json") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [randomUUID(), runId, source, String(event.id), fixtureId, capturedAt, event.commence_time || null, event.home_team, event.away_team, homeWin, draw, awayWin, over25, bothTeamsToScore, expected?.homeExpectedGoals ?? null, expected?.awayExpectedGoals ?? null, expected?.derivationMethod ?? null, JSON.stringify(event)])
      inserted += 1
    }
    await succeedFeedRun(db, runId, { finishedAt: new Date().toISOString(), insertedCount: inserted, unmatchedCount: unmatched, usedCache: feedDetails.usedCache, cacheCapturedAt: feedDetails.cacheCapturedAt })
    return { runId, inserted, unmatched }
  } catch (error) {
    await failFeedRun(db, runId, error)
    throw error
  }
}

export async function resolveSignalSeason(db, { season, env = process.env } = {}) {
  const configured = season || env.FPL_SEASON
  if (configured) return String(configured)
  const result = await db.query(`SELECT "season" FROM "Gameweek" ORDER BY "created_at" DESC, "fpl_id" DESC LIMIT 1`)
  const stored = result.rows[0]?.season
  if (stored) return String(stored)
  throw new Error('No active FPL season is available; run Sync FPL data first or set FPL_SEASON')
}

export async function ingestSignalFeeds({ db, season, fetchImpl = fetch, cacheDir = process.env.SIGNAL_CACHE_DIR || defaultCacheDir, understatRows, marketEvents } = {}) {
  const activeSeason = await resolveSignalSeason(db, { season })
  const underlying = understatRows === undefined
    ? await withCache(`understat-epl-${activeSeason.slice(0, 4)}.json`, async () => extractUnderstatJson(await fetchText(`https://understat.com/league/EPL/${activeSeason.slice(0, 4)}`, fetchImpl), 'playersData'), cacheDir)
    : { payload: understatRows, usedCache: false, cacheCapturedAt: null }
  const results = { underlying: await ingestUnderlyingRows(db, { season: activeSeason, rows: underlying.payload, feedDetails: underlying }) }
  if (marketEvents !== undefined) results.market = await ingestMarketEvents(db, { season: activeSeason, events: marketEvents })
  else if (process.env.ODDS_API_KEY) {
    const url = featuredOddsUrl({ apiKey: process.env.ODDS_API_KEY, regions: process.env.ODDS_API_REGIONS || 'uk' })
    const market = await withCache('odds-epl.json', () => fetchJson(url, fetchImpl), cacheDir)
    results.market = await ingestMarketEvents(db, { season: activeSeason, events: market.payload, feedDetails: market })
  }
  return results
}

export async function refreshBettingOdds({ db, season, fetchImpl = fetch, cacheDir = process.env.SIGNAL_CACHE_DIR || defaultCacheDir } = {}) {
  const activeSeason = await resolveSignalSeason(db, { season })
  if (!process.env.ODDS_API_KEY) throw new Error('ODDS_API_KEY is not configured')
  const url = featuredOddsUrl({ apiKey: process.env.ODDS_API_KEY, regions: process.env.ODDS_API_REGIONS || 'uk' })
  const market = await withCache('odds-epl.json', () => fetchJson(url, fetchImpl), cacheDir)
  return ingestMarketEvents(db, { season: activeSeason, events: market.payload, feedDetails: market })
}

async function main() {
  let db
  try {
    await migrateDatabase()
    db = getDb()
    if (process.argv.includes('--market-only')) {
      const market = await refreshBettingOdds({ db })
      console.log(`Odds: saved ${market.inserted} market observations (${market.unmatched} unresolved fixtures)`)
    } else {
      const result = await ingestSignalFeeds({ db })
      console.log(`Understat: saved ${result.underlying.inserted} observations (${result.underlying.unmatched} reviewable unmatched/ambiguous)`)
      if (result.market) console.log(`Odds: saved ${result.market.inserted} market observations (${result.market.unmatched} unresolved fixtures)`)
    }
  } finally {
    await closeDb()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`signal ingestion failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
}
