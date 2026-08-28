import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseCsv } from './ingest-historical-priors.mjs'
import { projectCatalogFixture } from '../src/server/forecast-service.ts'
import { MODEL_VERSION } from '../src/core/projection.ts'
import { evaluateBaselineMetrics, summarizeBacktestRows, type BacktestRow } from '../src/backtest.ts'
import { evaluateReplayBaselines, evaluateReplayDecisionMetrics, type ArchiveReplayPlayer } from '../src/archive-replay.ts'
import { decisionRankingScores } from '../src/core/decision-ranking.ts'
import type { ProjectionCatalogPlayer, ProjectionInputCatalog } from '../src/core/types.ts'

type CsvRow = Record<string, string>
type Commit = { sha: string; committedAt: string; url: string }

const REPOSITORY = 'olbauday/FPL-Core-Insights'
const SEASON = '2025-2026'
const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}
const flag = (name: string) => args.includes(name)
const cacheDir = path.resolve(option('--cache-dir') || '.cache/fpl-core-replay')
const refresh = flag('--refresh')
const simulate = !flag('--no-simulate')
const outputFile = option('--output')
const summaryOnly = flag('--summary-only')

function parseGameweeks(value: string | null) {
  const source = value || '1-5'
  const values = source.split(',').flatMap(part => {
    const range = part.trim().match(/^(\d+)-(\d+)$/)
    if (!range) return [Number(part)]
    const start = Number(range[1]), end = Number(range[2])
    return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index)
  })
  const result = [...new Set(values)].filter(value => Number.isInteger(value) && value >= 1 && value <= 38).sort((a, b) => a - b)
  if (!result.length) throw new Error('Use --gameweeks with values between 1 and 38, for example 1-5 or 2,4,6.')
  return result
}

const gameweeks = parseGameweeks(option('--gameweeks'))
const numeric = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
const nullable = (value: unknown) => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null
const numericKey = (value: unknown) => String(numeric(value))
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const encodedPath = (value: string) => value.split('/').map(encodeURIComponent).join('/')
const rawUrl = (revision: string, file: string) => `https://raw.githubusercontent.com/${REPOSITORY}/${revision}/${encodedPath(file)}`

async function fetchText(url: string) {
  await fs.mkdir(cacheDir, { recursive: true })
  const filename = path.join(cacheDir, `${sha256(url)}.txt`)
  if (!refresh) {
    try { return await fs.readFile(filename, 'utf8') } catch {}
  }
  const headers: Record<string, string> = { accept: url.includes('api.github.com') ? 'application/vnd.github+json' : 'text/csv', 'user-agent': 'Insomnia-FPL-archive-replay/1.0' }
  if (process.env.GITHUB_TOKEN && url.includes('api.github.com')) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`Archive request failed (${response.status}) for ${url}`)
  const text = await response.text()
  await fs.writeFile(filename, text, 'utf8')
  return text
}

async function csv(revision: string, file: string) {
  const text = await fetchText(rawUrl(revision, file))
  return { rows: parseCsv(text) as CsvRow[], sha256: sha256(text), file }
}

async function latestCommit() {
  const payload = JSON.parse(await fetchText(`https://api.github.com/repos/${REPOSITORY}/commits?sha=main&per_page=1`))
  const row = payload[0]
  if (!row?.sha) throw new Error('No repository HEAD commit was returned.')
  return { sha: String(row.sha), committedAt: String(row.commit?.committer?.date || row.commit?.author?.date), url: String(row.html_url) } satisfies Commit
}

async function inputCommitBefore(deadline: string) {
  const until = encodeURIComponent(new Date(Date.parse(deadline) - 1).toISOString())
  const file = encodeURIComponent(`data/${SEASON}/playerstats.csv`)
  const payload = JSON.parse(await fetchText(`https://api.github.com/repos/${REPOSITORY}/commits?path=${file}&until=${until}&per_page=1`))
  const row = payload[0]
  if (!row?.sha) throw new Error(`No playerstats commit exists before ${deadline}.`)
  const committedAt = String(row.commit?.committer?.date || row.commit?.author?.date)
  if (Date.parse(committedAt) >= Date.parse(deadline)) throw new Error(`Leakage guard rejected ${row.sha}: commit is not before deadline.`)
  return { sha: String(row.sha), committedAt, url: String(row.html_url) } satisfies Commit
}

const positionMap: Record<string, 'GK' | 'DEF' | 'MID' | 'FWD'> = {
  goalkeeper: 'GK', gkp: 'GK', defender: 'DEF', def: 'DEF', midfielder: 'MID', mid: 'MID', forward: 'FWD', fwd: 'FWD',
}
const teamStrength = (team: CsvRow) => ({
  strengthOverallHome: nullable(team.strength_overall_home), strengthOverallAway: nullable(team.strength_overall_away),
  strengthAttackHome: nullable(team.strength_attack_home), strengthAttackAway: nullable(team.strength_attack_away),
  strengthDefenceHome: nullable(team.strength_defence_home), strengthDefenceAway: nullable(team.strength_defence_away),
})
const zeroCurrentTotals = (row: CsvRow): CsvRow => ({
  ...row, total_points: '0', event_points: '0', minutes: '0', goals_scored: '0', assists: '0', clean_sheets: '0', goals_conceded: '0', own_goals: '0', penalties_saved: '0', penalties_missed: '0', yellow_cards: '0', red_cards: '0', saves: '0', starts: '0', bonus: '0', bps: '0', expected_goals: '0', expected_assists: '0', expected_goal_involvements: '0', expected_goals_conceded: '0', expected_goals_per_90: '0', expected_assists_per_90: '0', expected_goal_involvements_per_90: '0', expected_goals_conceded_per_90: '0', defensive_contribution: '0', defensive_contribution_per_90: '0',
})

function catalogForGameweek(input: {
  gameweek: number; deadline: string; commit: Commit; stats: CsvRow[]; players: CsvRow[]; teams: CsvRow[]; fixtures: CsvRow[]; priorOutcomes: CsvRow[]
}) {
  const teamsByCode = new Map(input.teams.map(row => [numericKey(row.code), row]))
  const playersById = new Map(input.players.map(row => [String(row.player_id), row]))
  const statsById = new Map<string, CsvRow[]>()
  for (const row of input.stats) {
    const values = statsById.get(String(row.id)) || []
    values.push(row); statsById.set(String(row.id), values)
  }
  const premierLeagueFixtures = input.fixtures.filter(row => {
    const tournament = String(row.tournament || 'prem').toLowerCase()
    return numeric(row.gameweek) === input.gameweek && (tournament === 'prem' || tournament.includes('premier'))
  })
  const fixturesByTeam = new Map<string, CsvRow[]>()
  for (const fixture of premierLeagueFixtures) for (const code of [numericKey(fixture.home_team), numericKey(fixture.away_team)]) fixturesByTeam.set(code, [...(fixturesByTeam.get(code) || []), fixture])
  const priorTotals = new Map<string, { points: number; minutes: number }>()
  for (const row of input.priorOutcomes) {
    const id = String(row.id), current = priorTotals.get(id) || { points: 0, minutes: 0 }
    current.points += numeric(row.event_points); current.minutes += numeric(row.minutes); priorTotals.set(id, current)
  }
  let missingIdentity = 0, missingTeam = 0, missingCurrentSnapshot = 0, rejectedUnreconciledSnapshot = 0
  const catalogPlayers: ProjectionCatalogPlayer[] = []
  const metadata = new Map<string, { baseline: ArchiveReplayPlayer['baselines']; position: 'GK' | 'DEF' | 'MID' | 'FWD'; name: string }>()

  for (const [playerId, identity] of playersById) {
    const position = positionMap[String(identity.position || '').toLowerCase()]
    if (!position) { missingIdentity += 1; continue }
    const playerTeamCode = numericKey(identity.team_code)
    const team = teamsByCode.get(playerTeamCode)
    if (!team) { missingTeam += 1; continue }
    const snapshots = statsById.get(playerId) || []
    const prior = snapshots.find(row => numeric(row.gw, -1) === 0) || null
    const exact = snapshots.filter(row => numeric(row.gw, -1) === input.gameweek).at(-1) || null
    const current = exact || (input.gameweek === 1 && prior ? zeroCurrentTotals(prior) : null)
    if (!current) { missingCurrentSnapshot += 1; continue }
    const expectedPrior = priorTotals.get(playerId) || { points: 0, minutes: 0 }
    if (numeric(current.total_points) !== expectedPrior.points || numeric(current.minutes) !== expectedPrior.minutes) {
      rejectedUnreconciledSnapshot += 1
      continue
    }
    const playerFixtures = (fixturesByTeam.get(playerTeamCode) || []).flatMap(fixture => {
      const isHome = numericKey(fixture.home_team) === playerTeamCode
      const opponent = teamsByCode.get(numericKey(isHome ? fixture.away_team : fixture.home_team))
      if (!opponent) return []
      return [{
        id: String(fixture.match_id || fixture.fotmob_id || `${input.gameweek}:${fixture.home_team}:${fixture.away_team}`),
        fplId: numeric(fixture.fotmob_id), gameweekId: `archive:${SEASON}:gw${input.gameweek}`, gameweekFplId: input.gameweek,
        kickoffAt: fixture.kickoff_time || null, isHome, difficulty: 3,
        opponent: { id: String(opponent.code), fplId: numeric(opponent.id), name: opponent.name, shortName: opponent.short_name, teamStrength: teamStrength(opponent) },
        market: null,
      }]
    })
    if (!playerFixtures.length) continue
    const observedAt = input.commit.committedAt
    const chance = nullable(current.chance_of_playing_next_round)
    const official = {
      observed_at: observedAt, position, status: current.status || 'a', chance_of_playing: chance,
      active: !['u'].includes(String(current.status)), price_tenths: Math.round(numeric(current.now_cost) * 10), ownership_percent: numeric(current.selected_by_percent),
      form: numeric(current.form), ep_next: numeric(current.ep_next), points_per_game: numeric(current.points_per_game),
      minutes: numeric(current.minutes), starts: numeric(current.starts), total_points: numeric(current.total_points), goals: numeric(current.goals_scored), assists: numeric(current.assists),
      clean_sheets: numeric(current.clean_sheets), goals_conceded: numeric(current.goals_conceded), saves: numeric(current.saves), bonus: numeric(current.bonus), bps: numeric(current.bps),
      yellow_cards: numeric(current.yellow_cards), red_cards: numeric(current.red_cards), own_goals: numeric(current.own_goals), penalties_missed: numeric(current.penalties_missed), penalties_saved: numeric(current.penalties_saved),
      expected_goals: numeric(current.expected_goals), expected_assists: numeric(current.expected_assists), expected_goals_conceded: numeric(current.expected_goals_conceded),
      expected_goals_per_90: numeric(current.expected_goals_per_90), expected_assists_per_90: numeric(current.expected_assists_per_90), expected_goals_conceded_per_90: numeric(current.expected_goals_conceded_per_90),
      defensive_contribution: numeric(current.defensive_contribution), defensive_contribution_per_90: numeric(current.defensive_contribution_per_90),
    }
    const priorMinutes = numeric(prior?.minutes)
    const historicalPrior = prior && priorMinutes >= 360 ? {
      sourceSeason: '2024-2025', confidence: 1, minutes: priorMinutes, starts: numeric(prior.starts),
      expectedGoalsPer90: numeric(prior.expected_goals_per_90, numeric(prior.expected_goals) * 90 / Math.max(1, priorMinutes)),
      expectedAssistsPer90: numeric(prior.expected_assists_per_90, numeric(prior.expected_assists) * 90 / Math.max(1, priorMinutes)),
      bonusPer90: numeric(prior.bonus) * 90 / Math.max(1, priorMinutes),
    } : null
    const name = identity.web_name || [identity.first_name, identity.second_name].filter(Boolean).join(' ')
    catalogPlayers.push({
      id: `archive:${SEASON}:player:${playerId}`, fplId: numeric(playerId), name,
      team: { id: String(team.code), fplId: numeric(team.id), name: team.name, shortName: team.short_name }, official,
      teamStrength: teamStrength(team), fixtures: playerFixtures, underlying: null, historicalPrior, roleSignals: [],
      provenance: { officialObservationId: `${input.commit.sha}:${playerId}:gw${input.gameweek}`, underlyingObservationId: null, eligibleSignalIds: [], manualOverrideSignalIds: [], excluded: { underlying: ['archive replay has no point-in-time underlying feed'], signals: ['archive replay has no creator signal ledger'] } },
    })
    metadata.set(playerId, { name, position, baseline: { FPL_EP_NEXT: numeric(current.ep_next), FPL_FORM: numeric(current.form), FPL_POINTS_PER_GAME: numeric(current.points_per_game) } })
  }
  const catalog: ProjectionInputCatalog = {
    asOf: input.commit.committedAt, season: SEASON, players: catalogPlayers,
    gameweeks: [{ id: `archive:${SEASON}:gw${input.gameweek}`, gameweek: input.gameweek, deadline: input.deadline, isCurrent: false, isNext: true, finished: false }],
    sourceRunIds: { official: [input.commit.sha], underlying: [], market: [] },
    freshness: {
      official: { source: 'OFFICIAL_FPL', observedAt: input.commit.committedAt, feedRunIds: [input.commit.sha], status: 'FRESH' },
      underlying: { source: 'UNDERLYING', observedAt: null, feedRunIds: [], status: 'MISSING' },
      market: { source: 'MARKET', observedAt: null, feedRunIds: [], status: 'MISSING' },
      signals: { source: 'SIGNALS', observedAt: null, feedRunIds: [], status: 'MISSING' },
    }, inputHash: sha256(`${input.commit.sha}\u0000${input.gameweek}`),
  }
  return { catalog, metadata, coverage: { inputPlayers: catalogPlayers.length, fixtures: premierLeagueFixtures.length, missingIdentity, missingTeam, missingCurrentSnapshot, rejectedUnreconciledSnapshot } }
}

const analyticalPoints = (row: ReturnType<typeof projectCatalogFixture>) => row.appearancePoints + row.goalPoints + row.assistPoints + row.cleanSheetPoints + row.goalsConcededPoints + row.savePoints + row.penaltyPoints + row.defensiveContributionPoints + row.bonusPoints + row.cardPoints
const descriptiveSummary = (rows: BacktestRow[]) => {
  const { factor: _factor, calibrated: _calibrated, ...metric } = summarizeBacktestRows(rows, { position: 'ALL', horizon: 1, confidenceBand: 'ALL', strengthMethod: 'ALL' })
  return metric
}

function projectEpisode(catalog: ProjectionInputCatalog, metadata: Map<string, { baseline: ArchiveReplayPlayer['baselines']; position: 'GK' | 'DEF' | 'MID' | 'FWD'; name: string }>, outcomes: CsvRow[], gameweek: number) {
  const projected = new Map<string, { expected: number; noBonus: number; p10: number; p90: number; expectedMinutes: number; expectedGoals: number; expectedAssists: number; expectedCleanSheetPoints: number; startProbability: number; noShowProbability: number; strengthMethods: Set<string> }>()
  for (const player of catalog.players) for (const fixture of player.fixtures) {
    const row = projectCatalogFixture(player, fixture, catalog, { forecastRunId: `archive:${SEASON}:gw${gameweek}`, modelVersion: MODEL_VERSION, completedGameweeks: gameweek - 1, deterministic: !simulate })
    const playerId = String(player.fplId)
    const current = projected.get(playerId) || { expected: 0, noBonus: 0, p10: 0, p90: 0, expectedMinutes: 0, expectedGoals: 0, expectedAssists: 0, expectedCleanSheetPoints: 0, startProbability: 0, noShowProbability: 1, strengthMethods: new Set<string>() }
    const expected = analyticalPoints(row)
    current.expected += expected; current.noBonus += expected - row.bonusPoints; current.p10 += row.p10Points; current.p90 += row.p90Points; current.expectedMinutes += row.expectedMinutes
    const goalValue = player.official.position === 'GK' || player.official.position === 'DEF' ? 6 : player.official.position === 'MID' ? 5 : 4
    current.expectedGoals += row.goalPoints / goalValue; current.expectedAssists += row.assistPoints / 3; current.expectedCleanSheetPoints += row.cleanSheetPoints
    current.startProbability = 1 - (1 - current.startProbability) * (1 - row.startProbability)
    current.noShowProbability *= row.noShowProbability
    current.strengthMethods.add(row.strengthMethod)
    projected.set(playerId, current)
  }
  const actualById = new Map(outcomes.filter(row => numeric(row.gw, gameweek) === gameweek).map(row => [String(row.id), { points: numeric(row.event_points), minutes: numeric(row.minutes), bonus: numeric(row.bonus), goals: numeric(row.goals_scored), assists: numeric(row.assists), cleanSheets: numeric(row.clean_sheets) }]))
  const players: ArchiveReplayPlayer[] = []
  const backtestRows: BacktestRow[] = [], noBonusRows: BacktestRow[] = []
  const details: Array<Record<string, unknown>> = []
  for (const [playerId, prediction] of projected) {
    const actual = actualById.get(playerId), info = metadata.get(playerId)
    if (!actual || !info) continue
    const replay: ArchiveReplayPlayer = { playerId, name: info.name, position: info.position, expectedPoints: prediction.expected, expectedPointsWithoutBonus: prediction.noBonus, actualPoints: actual.points, actualMinutes: actual.minutes, startProbability: prediction.startProbability, noShowProbability: prediction.noShowProbability, baselines: info.baseline }
    players.push(replay)
    backtestRows.push({ position: info.position, expectedPoints: prediction.expected, actualPoints: actual.points, p10Points: simulate ? prediction.p10 : undefined, p90Points: simulate ? prediction.p90 : undefined, horizon: 1, minutesConfidence: 'ARCHIVE', strengthMethod: [...prediction.strengthMethods].sort().join('+'), baselines: info.baseline })
    noBonusRows.push({ position: info.position, expectedPoints: prediction.noBonus, actualPoints: actual.points - actual.bonus })
    const cleanSheetPointValue = info.position === 'GK' || info.position === 'DEF' ? 4 : info.position === 'MID' ? 1 : 0
    details.push({ playerId, name: info.name, position: info.position, expectedPoints: +prediction.expected.toFixed(4), actualPoints: actual.points, expectedPointsWithoutBonus: +prediction.noBonus.toFixed(4), actualPointsWithoutBonus: actual.points - actual.bonus, actualMinutes: actual.minutes, expectedMinutes: +prediction.expectedMinutes.toFixed(2), startProbability: +prediction.startProbability.toFixed(4), noShowProbability: +prediction.noShowProbability.toFixed(4), expectedGoals: +prediction.expectedGoals.toFixed(4), actualGoals: actual.goals, expectedAssists: +prediction.expectedAssists.toFixed(4), actualAssists: actual.assists, expectedCleanSheetProbability: cleanSheetPointValue ? +Math.min(1, prediction.expectedCleanSheetPoints / cleanSheetPointValue).toFixed(4) : null, actualCleanSheet: actual.cleanSheets > 0, p10: simulate ? +prediction.p10.toFixed(2) : null, p90: simulate ? +prediction.p90.toFixed(2) : null, baselines: info.baseline, strengthMethods: [...prediction.strengthMethods].sort() })
  }
  const rankingScores = decisionRankingScores(players.map(row => ({ playerId: row.playerId, expectedPoints: row.expectedPoints, expectedPointsWithoutBonus: row.expectedPointsWithoutBonus, pointsPerGame: row.baselines.FPL_POINTS_PER_GAME })))
  for (const player of players) player.selectionScore = rankingScores.get(player.playerId)
  for (const detail of details) detail.selectionScore = rankingScores.get(String(detail.playerId))
  const appearedDetails = details.filter(row => Number(row.actualMinutes) > 0)
  const cleanSheetDetails = appearedDetails.filter(row => Number(row.actualMinutes) >= 60 && row.expectedCleanSheetProbability != null)
  const mae = (values: number[]) => values.length ? +(values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length).toFixed(6) : null
  const diagnostics = {
    expectedMinutesMae: mae(appearedDetails.map(row => Number(row.expectedMinutes) - Number(row.actualMinutes))),
    allPlayerExpectedMinutesMae: mae(details.map(row => Number(row.expectedMinutes) - Number(row.actualMinutes))),
    noShowBrier: details.length ? +(details.reduce((sum, row) => sum + (Number(row.noShowProbability) - (Number(row.actualMinutes) <= 0 ? 1 : 0)) ** 2, 0) / details.length).toFixed(6) : null,
    predictedNoShowRate: details.length ? +(details.reduce((sum, row) => sum + Number(row.noShowProbability), 0) / details.length).toFixed(6) : null,
    observedNoShowRate: details.length ? +(details.filter(row => Number(row.actualMinutes) <= 0).length / details.length).toFixed(6) : null,
    uncertainRoleCohort: (() => {
      const cohort = details.filter(row => Number(row.expectedMinutes) >= 45 && Number(row.expectedMinutes) <= 75)
      return {
        sampleSize: cohort.length,
        pointsBias: cohort.length ? +(cohort.reduce((sum, row) => sum + Number(row.expectedPoints) - Number(row.actualPoints), 0) / cohort.length).toFixed(6) : null,
        minutesBias: cohort.length ? +(cohort.reduce((sum, row) => sum + Number(row.expectedMinutes) - Number(row.actualMinutes), 0) / cohort.length).toFixed(6) : null,
      }
    })(),
    expectedGoalsMae: mae(appearedDetails.map(row => Number(row.expectedGoals) - Number(row.actualGoals))),
    expectedAssistsMae: mae(appearedDetails.map(row => Number(row.expectedAssists) - Number(row.actualAssists))),
    cleanSheetBrier: cleanSheetDetails.length ? +(cleanSheetDetails.reduce((sum, row) => sum + (Number(row.expectedCleanSheetProbability) - Number(Boolean(row.actualCleanSheet))) ** 2, 0) / cleanSheetDetails.length).toFixed(6) : null,
    cleanSheetSampleSize: cleanSheetDetails.length,
  }
  return { players, backtestRows, noBonusRows, details, diagnostics }
}

const head = await latestCommit()
const summaries = await csv(head.sha, `data/${SEASON}/gameweek_summaries.csv`)
const deadlines = new Map(summaries.rows.map(row => [numeric(row.id || row.event || row.gameweek), row.deadline_time || row.deadline_at || row.deadline]))
const episodes: Array<Record<string, unknown>> = []
for (const gameweek of gameweeks) {
  const deadline = deadlines.get(gameweek)
  if (!deadline || Number.isNaN(Date.parse(deadline))) throw new Error(`No valid deadline found for GW${gameweek}.`)
  const commit = await inputCommitBefore(deadline)
  const [stats, players, teams, fixtures, outcomes] = await Promise.all([
    csv(commit.sha, `data/${SEASON}/playerstats.csv`), csv(commit.sha, `data/${SEASON}/players.csv`), csv(commit.sha, `data/${SEASON}/teams.csv`),
    csv(commit.sha, `data/${SEASON}/By Gameweek/GW${gameweek}/fixtures.csv`), csv(head.sha, `data/${SEASON}/By Gameweek/GW${gameweek}/player_gameweek_stats.csv`),
  ])
  const priorOutcomeFiles = await Promise.all(Array.from({ length: gameweek - 1 }, (_, index) => csv(head.sha, `data/${SEASON}/By Gameweek/GW${index + 1}/player_gameweek_stats.csv`)))
  const built = catalogForGameweek({ gameweek, deadline, commit, stats: stats.rows, players: players.rows, teams: teams.rows, fixtures: fixtures.rows, priorOutcomes: priorOutcomeFiles.flatMap(file => file.rows) })
  const replay = projectEpisode(built.catalog, built.metadata, outcomes.rows, gameweek)
  const appearedRows = replay.backtestRows.filter((_, index) => replay.players[index]?.actualMinutes > 0)
  episodes.push({
    gameweek, deadline, inputCommit: commit, snapshotAgeHours: +((Date.parse(deadline) - Date.parse(commit.committedAt)) / 3_600_000).toFixed(2),
    provenance: { stats: stats.sha256, players: players.sha256, teams: teams.sha256, fixtures: fixtures.sha256, outcomes: outcomes.sha256, outcomeCommit: head },
    coverage: { ...built.coverage, joinedPlayers: replay.players.length, appearedPlayers: replay.players.filter(row => row.actualMinutes > 0).length },
    metrics: {
      allPlayers: descriptiveSummary(replay.backtestRows),
      appearedPlayers: descriptiveSummary(appearedRows),
      withoutBonus: descriptiveSummary(replay.noBonusRows),
      components: replay.diagnostics,
      baselines: evaluateBaselineMetrics(replay.backtestRows),
      decisions: evaluateReplayDecisionMetrics(replay.players),
      eliteRanking: { version: 'elite-selection-rank-v1', ...(() => { const metric = evaluateReplayDecisionMetrics(replay.players, row => row.selectionScore ?? row.expectedPoints); return { eligiblePlayers: metric.eligiblePlayers, topK: metric.topK } })() },
      baselineDecisions: evaluateReplayBaselines(replay.players),
    },
    players: replay.details.sort((left, right) => Number(right.expectedPoints) - Number(left.expectedPoints)),
  })
}

const pooledRows = episodes.flatMap(episode => (episode.players as Array<any>).map(row => ({
  position: row.position, expectedPoints: row.expectedPoints, actualPoints: row.actualPoints,
  p10Points: row.p10, p90Points: row.p90,
  baselines: row.baselines,
})) as BacktestRow[])
const pooledAppearedRows = pooledRows.filter((_, index) => Number(episodes.flatMap(episode => episode.players as Array<any>)[index]?.actualMinutes) > 0)
const pooledNoBonusRows = episodes.flatMap(episode => (episode.players as Array<any>).map(row => ({ position: row.position, expectedPoints: row.expectedPointsWithoutBonus, actualPoints: row.actualPointsWithoutBonus }))) as BacktestRow[]
const reportEpisodes = summaryOnly ? episodes.map(({ players: _players, ...episode }) => episode) : episodes
const report = {
  schemaVersion: 1, scope: 'archive-compatible core-model walk-forward replay', season: SEASON, modelVersion: MODEL_VERSION,
  generatedAt: new Date().toISOString(), gameweeks, simulate, sourceRepository: `https://github.com/${REPOSITORY}`,
  limitations: [
    'Input files are pinned to the latest repository commit strictly before each deadline; target files contribute only realized points, minutes, bonus, goals, assists, and clean-sheet outcomes.',
    'Market odds, point-in-time underlying feeds, and creator/verified role signals are unavailable, so this is not an exact production forecast replay.',
    'The current model contains explicit 2026/27 bonus assumptions; withoutBonus metrics isolate part of that cross-season rule mismatch.',
    'Formation-global XI metrics enforce formation only, not budget, club limits, a 15-player squad, autosubs, or transfers.',
    'For double gameweeks, fixture quantiles are summed; analytical expected points remain correctly aggregated.',
  ],
  pooled: { model: descriptiveSummary(pooledRows), appearedPlayers: descriptiveSummary(pooledAppearedRows), withoutBonus: descriptiveSummary(pooledNoBonusRows), baselines: evaluateBaselineMetrics(pooledRows), calibrationApplied: false },
  episodes: reportEpisodes,
}
const rendered = `${JSON.stringify(report, null, 2)}\n`
if (outputFile) {
  const resolved = path.resolve(outputFile)
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  await fs.writeFile(resolved, rendered, 'utf8')
}
else process.stdout.write(rendered)
