import fs from 'node:fs'
import path from 'node:path'
import { getDb } from './db.mjs'
import { ensureDatabaseSchema } from './db-push.mjs'

const SOURCE_UNDERSTAT = 'UNDERSTAT'
const SOURCE_ODDS = 'ODDS_MARKET'
const seasonStart = Number(process.env.FPL_SEASON_START_YEAR || new Date().getUTCFullYear())
const cacheDir = process.env.SIGNAL_CACHE_DIR || path.resolve(process.cwd(), '.cache', 'signal-feeds')
const headers = { 'user-agent': 'Insomnia-FPL/1.0 (+local analytics)', accept: 'text/html,application/json' }

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalize(value) {
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
    else if (next === 'u') { output += String.fromCharCode(parseInt(value.slice(index + 1, index + 5), 16)); index += 4 }
    else output += next
  }
  return output
}

function extractUnderstatJson(html, variable) {
  const match = html.match(new RegExp(`${variable}\\s*=\\s*JSON\\.parse\\('((?:\\\\.|[^'])*)'\\)`))
  if (!match) throw new Error(`Understat response did not contain ${variable}`)
  return JSON.parse(decodeSingleQuotedJs(match[1]))
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { headers, ...options })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.json()
}

async function fetchText(url) {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.text()
}

async function withCache(name, loader) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const filename = path.join(cacheDir, name)
  try {
    const fresh = await loader()
    fs.writeFileSync(filename, JSON.stringify({ capturedAt: new Date().toISOString(), payload: fresh }))
    return fresh
  } catch (error) {
    if (fs.existsSync(filename)) {
      const cached = JSON.parse(fs.readFileSync(filename, 'utf8'))
      console.warn(`source refresh failed; using cached ${name}: ${error.message}`)
      return cached.payload
    }
    throw error
  }
}

function playerIndex(players, teams) {
  const teamNames = new Map(teams.map(team => [team.id, team.name]))
  const byName = new Map()
  for (const player of players) {
    const key = normalize(player.name)
    const list = byName.get(key) || []
    list.push({ ...player, teamName: teamNames.get(player.clubId) || '' })
    byName.set(key, list)
  }
  return { byName, teamNames }
}

async function ingestUnderstat(db, index) {
  const url = `https://understat.com/league/EPL/${seasonStart}`
  const html = await withCache(`understat-epl-${seasonStart}.json`, () => fetchText(url))
  const rows = extractUnderstatJson(html, 'playersData')
  const capturedAt = new Date().toISOString()
  let inserted = 0
  let unmatched = 0
  for (const row of rows) {
    const candidates = index.byName.get(normalize(row.player_name)) || []
    const match = candidates.find(candidate => !row.team_title || normalize(candidate.teamName) === normalize(row.team_title)) || candidates[0]
    if (!match) { unmatched += 1; continue }
    const minutes = number(row.time)
    const expectedGoals = number(row.xG)
    const expectedAssists = number(row.xA)
    await db.query(`INSERT INTO "PlayerUnderlyingSnapshot" ("playerId","source","sourcePlayerId","capturedAt","games","minutes","goals","assists","expectedGoals","expectedAssists","nonPenaltyExpectedGoals","shots","keyPasses","xgPer90","xaPer90","rawPayload") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [
      match.id, SOURCE_UNDERSTAT, String(row.id || row.player_id), capturedAt, number(row.games), minutes, number(row.goals), number(row.assists), expectedGoals, expectedAssists,
      number(row.npxG), number(row.shots), number(row.key_passes), minutes ? expectedGoals / minutes * 90 : 0, minutes ? expectedAssists / minutes * 90 : 0, JSON.stringify(row)
    ])
    inserted += 1
  }
  console.log(`Understat: saved ${inserted} player snapshots (${unmatched} unmatched)`)
}

function marketProbabilities(bookmakers, marketKey) {
  const observations = []
  for (const bookmaker of bookmakers || []) {
    const market = (bookmaker.markets || []).find(candidate => candidate.key === marketKey)
    if (!market) continue
    const prices = (market.outcomes || []).map(outcome => ({ name: outcome.name, price: number(outcome.price) })).filter(item => item.price > 1)
    const denominator = prices.reduce((sum, item) => sum + 1 / item.price, 0)
    if (!denominator) continue
    observations.push(Object.fromEntries(prices.map(item => [item.name, (1 / item.price) / denominator])))
  }
  if (!observations.length) return null
  const names = [...new Set(observations.flatMap(observation => Object.keys(observation)))]
  return Object.fromEntries(names.map(name => [name, observations.reduce((sum, observation) => sum + (observation[name] || 0), 0) / observations.length]))
}

async function ingestOdds(db) {
  const apiKey = process.env.ODDS_API_KEY
  if (!apiKey) { console.warn('Odds: skipped; set ODDS_API_KEY to enable the importer'); return }
  const url = `https://api.the-odds-api.com/v4/sports/soccer_epl/odds?regions=${encodeURIComponent(process.env.ODDS_API_REGIONS || 'uk')}&markets=h2h&oddsFormat=decimal&dateFormat=iso&apiKey=${encodeURIComponent(apiKey)}`
  const events = await withCache('odds-epl.json', () => fetchJson(url))
  const capturedAt = new Date().toISOString()
  let inserted = 0
  for (const event of events) {
    const probabilities = marketProbabilities(event.bookmakers, 'h2h')
    if (!probabilities) continue
    const home = probabilities[event.home_team] ?? null
    const draw = probabilities.Draw ?? null
    const away = probabilities[event.away_team] ?? null
    await db.query(`INSERT INTO "TeamMarketSnapshot" ("source","externalEventId","capturedAt","kickoff","homeTeam","awayTeam","homeWinProb","drawProb","awayWinProb","rawPayload") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      SOURCE_ODDS, String(event.id), capturedAt, event.commence_time || null, event.home_team, event.away_team, home, draw, away, JSON.stringify(event)
    ])
    inserted += 1
  }
  console.log(`Odds: saved ${inserted} de-vigged match snapshots`)
}

await ensureDatabaseSchema()
const db = getDb()
try {
  const bootstrap = await withCache('fpl-bootstrap-static.json', () => fetchJson('https://fantasy.premierleague.com/api/bootstrap-static/'))
  const teams = bootstrap.teams.map(team => ({ id: team.id, name: team.name, shortName: team.short_name }))
  const players = bootstrap.elements.map(player => ({ id: player.id, name: player.web_name || `${player.first_name} ${player.second_name}`, clubId: player.team }))
  const index = playerIndex(players, teams)
  await ingestUnderstat(db, index)
  await ingestOdds(db)
} catch (error) {
  console.error(`signal ingestion failed: ${error.stack || error.message}`)
  process.exitCode = 1
} finally {
  await db.end()
}
