import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { migrateDatabase } from './db-migrate.mjs'
import { closeDb, getDb } from './db.mjs'
import {
  canonicalJson,
  failFeedRun,
  finishFeedRun,
  hashPayload,
  sanitizeError,
  startFeedRun,
} from './feed-run.mjs'
import { createForecastRun } from '../src/server/forecast-service.ts'

const positions = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' }
const playerObservationColumns = [
  'id', 'player_id', 'feed_run_id', 'observed_at', 'team_id', 'position', 'active', 'status',
  'chance_of_playing', 'news', 'news_added_at', 'price_tenths', 'ownership_percent',
  'transfers_in', 'transfers_out', 'minutes', 'starts', 'total_points', 'points_per_game',
  'form', 'ep_next', 'goals', 'assists', 'clean_sheets', 'goals_conceded', 'saves', 'bonus',
  'bps', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'penalties_saved',
  'expected_goals', 'expected_assists', 'expected_goal_involvements', 'expected_goals_conceded',
  'expected_goals_per_90', 'expected_assists_per_90', 'expected_goal_involvements_per_90',
  'expected_goals_conceded_per_90', 'clearances_blocks_interceptions', 'tackles', 'recoveries',
  'defensive_contribution', 'defensive_contribution_per_90', 'raw_payload_json',
]
const resultColumns = [
  'player_id', 'fixture_id', 'gameweek_id', 'team_id', 'opponent_team_id', 'was_home', 'kickoff_at',
  'minutes', 'total_points', 'goals', 'assists', 'clean_sheets', 'goals_conceded', 'saves',
  'bonus', 'bps', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'penalties_saved',
  'clearances_blocks_interceptions', 'tackles', 'recoveries', 'defensive_contribution',
]

function loadEnvironment() {
  for (const envFile of ['.env.local', '.env']) {
    if (!fs.existsSync(envFile)) continue
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '')
    }
  }
}

loadEnvironment()

function numeric(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function nonNegativeNumber(value, fallback = 0) {
  return Math.max(0, numeric(value, fallback))
}

function integer(value, fallback = 0) {
  const parsed = numeric(value, fallback)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

function nonNegativeInteger(value, fallback = 0) {
  return Math.max(0, integer(value, fallback))
}

function nullableInteger(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function booleanValue(value) {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function requiredInteger(value, label) {
  const parsed = nullableInteger(value)
  if (parsed === null) throw new Error(`${label} must be an integer`)
  return parsed
}

function internalId(kind, season, fplId) {
  return `${kind}:${encodeURIComponent(season)}:${fplId}`
}

export function resolveSeason({ season, bootstrap } = {}) {
  const configuredSeason = season || process.env.FPL_SEASON
  if (configuredSeason) return String(configuredSeason)

  const startYear = integer(process.env.FPL_SEASON_START_YEAR, NaN)
  if (Number.isFinite(startYear) && startYear >= 1900 && startYear <= 3000) {
    return `${startYear}/${String(startYear + 1).slice(-2)}`
  }

  const bootstrapSeason = bootstrap?.season || bootstrap?.meta?.season
  if (bootstrapSeason) return String(bootstrapSeason)

  const firstDeadline = (bootstrap?.events || [])
    .map(event => event?.deadline_time)
    .filter(Boolean)
    .map(value => new Date(value))
    .filter(value => Number.isFinite(value.getTime()))
    .sort((left, right) => left.getTime() - right.getTime())[0]
  if (firstDeadline) {
    const deadlineYear = firstDeadline.getUTCFullYear()
    const startYear = firstDeadline.getUTCMonth() >= 6 ? deadlineYear : deadlineYear - 1
    return `${startYear}/${String(startYear + 1).slice(-2)}`
  }

  throw new Error('FPL season could not be derived; set FPL_SEASON or FPL_SEASON_START_YEAR')
}

function normalizeElementSummaries(input) {
  const summaries = {}
  if (!input) return summaries

  if (input instanceof Map) {
    for (const [playerId, summary] of input.entries()) summaries[String(playerId)] = summary
    return summaries
  }

  if (Array.isArray(input)) {
    for (const entry of input) {
      if (!entry || entry.playerId === undefined && entry.id === undefined) continue
      const playerId = entry.playerId ?? entry.id
      summaries[String(playerId)] = entry.summary ?? entry
    }
    return summaries
  }

  for (const [playerId, summary] of Object.entries(input)) summaries[String(playerId)] = summary
  return summaries
}

function payloadBundle({ bootstrap, fixtures, elementSummaries }) {
  return { bootstrap, fixtures, elementSummaries }
}

function defaultTimes({ startedAt, observedAt, sourceUpdatedAt, finishedAt } = {}) {
  const started = startedAt || new Date().toISOString()
  const observed = observedAt || sourceUpdatedAt || started
  return {
    startedAt: started,
    observedAt: observed,
    sourceUpdatedAt: sourceUpdatedAt || observed,
    finishedAt: finishedAt || new Date().toISOString(),
  }
}

function feedCounts() {
  return {
    teams: 0,
    gameweeks: 0,
    fixtures: 0,
    players: 0,
    teamObservations: 0,
    gameweekObservations: 0,
    fixtureObservations: 0,
    playerObservations: 0,
    resultsInserted: 0,
    resultsUpdated: 0,
    resultsSkipped: 0,
  }
}

function stageHook(options, stage) {
  const requestedFailure = options.failureAfterStage || options.failAfterStage
  if (requestedFailure === stage) throw new Error(`Injected failure after ${stage} writes`)
  if (typeof options.onStage === 'function') return options.onStage(stage)
  return undefined
}

async function upsertIdentity(db, {
  existsSql,
  existsParams,
  upsertSql,
  upsertParams,
  counts,
}) {
  const existing = await db.query(existsSql, existsParams)
  await db.query(upsertSql, upsertParams)
  if (existing.rows.length) counts.updatedCount += 1
  else counts.insertedCount += 1
}

async function insertTeamFacts(db, bootstrap, feedRunId, season, observedAt, createdAt, counts, maps) {
  for (const raw of bootstrap.teams || []) {
    const fplId = requiredInteger(raw.id, 'team.id')
    const teamId = internalId('team', season, fplId)
    maps.teams.set(String(fplId), { id: teamId, fplId, raw })
    await upsertIdentity(db, {
      existsSql: 'SELECT 1 FROM "Team" WHERE "season"=$1 AND "fpl_id"=$2',
      existsParams: [season, fplId],
      upsertSql: `INSERT INTO "Team" ("id", "season", "fpl_id", "name", "short_name", "created_at")
                  VALUES ($1, $2, $3, $4, $5, $6)
                  ON CONFLICT ("season", "fpl_id") DO UPDATE SET
                    "name"=EXCLUDED."name", "short_name"=EXCLUDED."short_name"`,
      upsertParams: [teamId, season, fplId, String(raw.name || raw.short_name || `Team ${fplId}`), String(raw.short_name || raw.name || `T${fplId}`), createdAt],
      counts,
    })
    await db.query(
      `INSERT INTO "TeamObservation" (
        "id", "team_id", "feed_run_id", "observed_at", "strength_attack_home",
        "strength_attack_away", "strength_defence_home", "strength_defence_away", "active", "raw_payload_json"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT ("team_id", "feed_run_id") DO NOTHING`,
      [
        cryptoRandomId(), teamId, feedRunId, observedAt,
        nullableNumber(raw.strength_attack_home), nullableNumber(raw.strength_attack_away),
        nullableNumber(raw.strength_defence_home), nullableNumber(raw.strength_defence_away),
        booleanValue(raw.active !== undefined ? raw.active : true), canonicalJson(raw),
      ],
    )
    counts.teamObservations += 1
  }
}

async function insertGameweekFacts(db, bootstrap, feedRunId, season, observedAt, createdAt, counts, maps) {
  for (const raw of bootstrap.events || []) {
    const fplId = requiredInteger(raw.id, 'event.id')
    const gameweekId = internalId('gameweek', season, fplId)
    maps.gameweeks.set(String(fplId), { id: gameweekId, fplId, raw })
    await upsertIdentity(db, {
      existsSql: 'SELECT 1 FROM "Gameweek" WHERE "season"=$1 AND "fpl_id"=$2',
      existsParams: [season, fplId],
      upsertSql: `INSERT INTO "Gameweek" ("id", "season", "fpl_id", "name", "created_at")
                  VALUES ($1, $2, $3, $4, $5)
                  ON CONFLICT ("season", "fpl_id") DO UPDATE SET "name"=EXCLUDED."name"`,
      upsertParams: [gameweekId, season, fplId, String(raw.name || `Gameweek ${fplId}`), createdAt],
      counts,
    })
    await db.query(
      `INSERT INTO "GameweekObservation" (
        "id", "gameweek_id", "feed_run_id", "observed_at", "deadline_at", "finished", "is_current", "is_next", "raw_payload_json"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT ("gameweek_id", "feed_run_id") DO NOTHING`,
      [
        cryptoRandomId(), gameweekId, feedRunId, observedAt, raw.deadline_time || null,
        booleanValue(raw.finished), booleanValue(raw.is_current), booleanValue(raw.is_next), canonicalJson(raw),
      ],
    )
    counts.gameweekObservations += 1
  }
}

async function insertFixtureFacts(db, fixtures, feedRunId, season, observedAt, createdAt, counts, maps) {
  for (const raw of fixtures || []) {
    const fplId = nullableInteger(raw.id)
    const homeTeam = maps.teams.get(String(raw.team_h))
    const awayTeam = maps.teams.get(String(raw.team_a))
    if (fplId === null || !homeTeam || !awayTeam) {
      counts.unmatchedCount += 1
      continue
    }
    const fixtureId = internalId('fixture', season, fplId)
    const event = raw.event === null || raw.event === undefined ? null : maps.gameweeks.get(String(raw.event))
    maps.fixtures.set(String(fplId), {
      id: fixtureId,
      fplId,
      raw,
      gameweekId: event?.id || null,
      finished: booleanValue(raw.finished),
      homeTeamId: homeTeam.id,
      awayTeamId: awayTeam.id,
    })
    await upsertIdentity(db, {
      existsSql: 'SELECT 1 FROM "Fixture" WHERE "season"=$1 AND "fpl_id"=$2',
      existsParams: [season, fplId],
      upsertSql: `INSERT INTO "Fixture" (
                    "id", "season", "fpl_id", "home_team_id", "away_team_id", "created_at"
                  ) VALUES ($1, $2, $3, $4, $5, $6)
                  ON CONFLICT ("season", "fpl_id") DO UPDATE SET
                    "home_team_id"=EXCLUDED."home_team_id", "away_team_id"=EXCLUDED."away_team_id"`,
      upsertParams: [fixtureId, season, fplId, homeTeam.id, awayTeam.id, createdAt],
      counts,
    })
    await db.query(
      `INSERT INTO "FixtureObservation" (
        "id", "fixture_id", "feed_run_id", "observed_at", "gameweek_id", "kickoff_at",
        "difficulty_home", "difficulty_away", "started", "finished", "raw_payload_json"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT ("fixture_id", "feed_run_id") DO NOTHING`,
      [
        cryptoRandomId(), fixtureId, feedRunId, observedAt, event?.id || null, raw.kickoff_time || null,
        nullableDifficulty(raw.team_h_difficulty), nullableDifficulty(raw.team_a_difficulty),
        booleanValue(raw.started), booleanValue(raw.finished), canonicalJson(raw),
      ],
    )
    counts.fixtureObservations += 1
  }
}

function nullableDifficulty(value) {
  const parsed = nullableInteger(value)
  return parsed !== null && parsed >= 1 && parsed <= 5 ? parsed : null
}

function playerObservationValues({ raw, playerId, teamId, position, feedRunId, observedAt, rawPayload = raw }) {
  const status = raw.status === undefined || raw.status === null ? null : String(raw.status)
  const chance = nullableInteger(raw.chance_of_playing_next_round ?? raw.chance_of_playing_this_round)
  return [
    cryptoRandomId(), playerId, feedRunId, observedAt, teamId, position,
    status !== 'u' && status !== 'n', status, chance,
    raw.news === undefined || raw.news === null ? null : String(raw.news), raw.news_added || null,
    nonNegativeInteger(raw.now_cost), nonNegativeNumber(raw.selected_by_percent),
    nonNegativeInteger(raw.transfers_in), nonNegativeInteger(raw.transfers_out),
    nonNegativeInteger(raw.minutes), nonNegativeInteger(raw.starts), integer(raw.total_points),
    nonNegativeNumber(raw.points_per_game), nonNegativeNumber(raw.form), nonNegativeNumber(raw.ep_next),
    nonNegativeInteger(raw.goals_scored), nonNegativeInteger(raw.assists), nonNegativeInteger(raw.clean_sheets),
    nonNegativeInteger(raw.goals_conceded), nonNegativeInteger(raw.saves), nonNegativeInteger(raw.bonus),
    integer(raw.bps), nonNegativeInteger(raw.yellow_cards), nonNegativeInteger(raw.red_cards),
    nonNegativeInteger(raw.own_goals), nonNegativeInteger(raw.penalties_missed), nonNegativeInteger(raw.penalties_saved),
    nonNegativeNumber(raw.expected_goals), nonNegativeNumber(raw.expected_assists),
    nonNegativeNumber(raw.expected_goal_involvements), nonNegativeNumber(raw.expected_goals_conceded),
    nonNegativeNumber(raw.expected_goals_per_90), nonNegativeNumber(raw.expected_assists_per_90),
    nonNegativeNumber(raw.expected_goal_involvements_per_90), nonNegativeNumber(raw.expected_goals_conceded_per_90),
    nonNegativeInteger(raw.clearances_blocks_interceptions), nonNegativeInteger(raw.tackles),
    nonNegativeInteger(raw.recoveries), nonNegativeNumber(raw.defensive_contribution),
    nonNegativeNumber(raw.defensive_contribution_per_90), canonicalJson(rawPayload),
  ]
}

async function insertPlayerObservation(db, values) {
  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ')
  await db.query(
    `INSERT INTO "PlayerObservation" (${playerObservationColumns.map(column => `"${column}"`).join(', ')})
     VALUES (${placeholders})
     ON CONFLICT ("player_id", "feed_run_id") DO NOTHING`,
    values,
  )
}

async function insertPlayerFacts(db, bootstrap, feedRunId, season, observedAt, createdAt, counts, maps) {
  for (const raw of bootstrap.elements || []) {
    const fplId = requiredInteger(raw.id, 'element.id')
    const team = maps.teams.get(String(raw.team))
    if (!team) {
      counts.unmatchedCount += 1
      continue
    }
    const position = positions[raw.element_type]
    if (!position) throw new Error(`Unsupported FPL element type for player ${fplId}`)
    const playerId = internalId('player', season, fplId)
    maps.players.set(String(fplId), { id: playerId, fplId, raw, teamId: team.id, position })
    await upsertIdentity(db, {
      existsSql: 'SELECT 1 FROM "Player" WHERE "season"=$1 AND "fpl_id"=$2',
      existsParams: [season, fplId],
      upsertSql: `INSERT INTO "Player" (
                    "id", "season", "fpl_id", "first_name", "second_name", "web_name", "created_at", "updated_at"
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                  ON CONFLICT ("season", "fpl_id") DO UPDATE SET
                    "first_name"=EXCLUDED."first_name", "second_name"=EXCLUDED."second_name",
                    "web_name"=EXCLUDED."web_name", "updated_at"=EXCLUDED."updated_at"`,
      upsertParams: [
        playerId, season, fplId, raw.first_name || null, raw.second_name || null,
        String(raw.web_name || `${raw.first_name || ''} ${raw.second_name || ''}`.trim() || `Player ${fplId}`),
        createdAt, observedAt,
      ],
      counts,
    })
    await insertPlayerObservation(db, playerObservationValues({
      raw,
      playerId,
      teamId: team.id,
      position,
      feedRunId,
      observedAt,
    }))
    counts.playerObservations += 1
  }
}

function resultValues({ raw, playerId, fixture, gameweekId }) {
  const wasHome = booleanValue(raw.was_home)
  const teamId = wasHome ? fixture.homeTeamId : fixture.awayTeamId
  const opponentTeamId = wasHome ? fixture.awayTeamId : fixture.homeTeamId
  const kickoffAt = raw.kickoff_time || fixture.raw.kickoff_time
  if (!gameweekId || !kickoffAt) return null
  return [
    playerId, fixture.id, gameweekId, teamId, opponentTeamId, wasHome, kickoffAt,
    nonNegativeInteger(raw.minutes), integer(raw.total_points), nonNegativeInteger(raw.goals_scored),
    nonNegativeInteger(raw.assists), nonNegativeInteger(raw.clean_sheets), nonNegativeInteger(raw.goals_conceded),
    nonNegativeInteger(raw.saves), nonNegativeInteger(raw.bonus), integer(raw.bps),
    nonNegativeInteger(raw.yellow_cards), nonNegativeInteger(raw.red_cards), nonNegativeInteger(raw.own_goals),
    nonNegativeInteger(raw.penalties_missed), nonNegativeInteger(raw.penalties_saved),
    nonNegativeInteger(raw.clearances_blocks_interceptions), nonNegativeInteger(raw.tackles),
    nonNegativeInteger(raw.recoveries), nonNegativeNumber(raw.defensive_contribution),
  ]
}

async function upsertCompletedResults(db, bootstrap, elementSummaries, feedRunId, maps, counts) {
  const summaryMap = normalizeElementSummaries(elementSummaries)
  const updateColumns = resultColumns.slice(2).map(column => `"${column}"=EXCLUDED."${column}"`).join(', ')
  const placeholders = resultColumns.map((_, index) => `$${index + 1}`).join(', ')
  const insertSql = `INSERT INTO "PlayerFixtureResult" (${resultColumns.map(column => `"${column}"`).join(', ')})
                    VALUES (${placeholders})
                    ON CONFLICT ("player_id", "fixture_id") DO UPDATE SET ${updateColumns}`

  for (const rawPlayer of bootstrap.elements || []) {
    const player = maps.players.get(String(rawPlayer.id))
    if (!player) continue
    const history = summaryMap[String(rawPlayer.id)]?.history || []
    for (const rawResult of history) {
      const fixture = maps.fixtures.get(String(rawResult.fixture))
      if (!fixture || !fixture.finished) {
        counts.unmatchedCount += 1
        continue
      }
      const eventId = rawResult.round ?? fixture.raw.event
      const gameweek = maps.gameweeks.get(String(eventId))
      const values = resultValues({ raw: rawResult, playerId: player.id, fixture, gameweekId: gameweek?.id })
      if (!values) {
        counts.unmatchedCount += 1
        continue
      }
      const existing = await db.query(
        'SELECT 1 FROM "PlayerFixtureResult" WHERE "player_id"=$1 AND "fixture_id"=$2',
        [player.id, fixture.id],
      )
      if (existing.rows.length) {
        const currentObservation = await db.query(
          `SELECT "finished" FROM "FixtureObservation"
           WHERE "fixture_id"=$1 AND "feed_run_id"=$2`,
          [fixture.id, feedRunId],
        )
        if (currentObservation.rows[0]?.finished) {
          counts.resultsSkipped += 1
          continue
        }
        await db.query(insertSql, values)
        counts.resultsUpdated += 1
      } else {
        await db.query(insertSql, values)
        counts.resultsInserted += 1
      }
    }
  }
}

async function markAbsentPlayersInactive(db, feedRunId, season, observedAt, maps, counts) {
  const players = await db.query('SELECT "id" FROM "Player" WHERE "season"=$1', [season])
  for (const playerRow of players.rows) {
    if (maps.players.has(String(playerRow.id).split(':').pop())) continue
    const latest = await db.query(
      `SELECT * FROM "PlayerObservation"
       WHERE "player_id"=$1
       ORDER BY "observed_at" DESC, "id" DESC
       LIMIT 1`,
      [playerRow.id],
    )
    const previous = latest.rows[0]
    if (!previous) continue
    const rawPayload = {
      inactive_reason: 'absent_from_bootstrap',
      previous_observation_id: previous.id,
    }
    await insertPlayerObservation(db, [
      cryptoRandomId(), previous.player_id, feedRunId, observedAt, previous.team_id, previous.position,
      false, 'u', previous.chance_of_playing, previous.news, previous.news_added_at, previous.price_tenths,
      previous.ownership_percent, previous.transfers_in, previous.transfers_out, previous.minutes, previous.starts,
      previous.total_points, previous.points_per_game, previous.form, previous.ep_next, previous.goals, previous.assists,
      previous.clean_sheets, previous.goals_conceded, previous.saves, previous.bonus, previous.bps, previous.yellow_cards,
      previous.red_cards, previous.own_goals, previous.penalties_missed, previous.penalties_saved, previous.expected_goals,
      previous.expected_assists, previous.expected_goal_involvements, previous.expected_goals_conceded,
      previous.expected_goals_per_90, previous.expected_assists_per_90, previous.expected_goal_involvements_per_90,
      previous.expected_goals_conceded_per_90, previous.clearances_blocks_interceptions, previous.tackles,
      previous.recoveries, previous.defensive_contribution, previous.defensive_contribution_per_90, canonicalJson(rawPayload),
    ])
    counts.playerObservations += 1
  }
}

async function writeOfficialFacts(db, {
  bootstrap,
  fixtures,
  elementSummaries,
  feedRunId,
  season,
  observedAt,
  createdAt,
  options,
}) {
  const counts = feedCounts()
  const writeCounts = {
    insertedCount: 0,
    updatedCount: 0,
    unmatchedCount: 0,
    teamObservations: 0,
    gameweekObservations: 0,
    fixtureObservations: 0,
    playerObservations: 0,
    resultsInserted: 0,
    resultsUpdated: 0,
    resultsSkipped: 0,
  }
  const maps = {
    teams: new Map(),
    gameweeks: new Map(),
    fixtures: new Map(),
    players: new Map(),
  }
  let transactionOpen = false
  try {
    db.sqlite.exec('BEGIN IMMEDIATE')
    transactionOpen = true

    await insertTeamFacts(db, bootstrap, feedRunId, season, observedAt, createdAt, writeCounts, maps)
    counts.teams = maps.teams.size
    await stageHook(options, 'teams')

    await insertGameweekFacts(db, bootstrap, feedRunId, season, observedAt, createdAt, writeCounts, maps)
    counts.gameweeks = maps.gameweeks.size
    await insertFixtureFacts(db, fixtures, feedRunId, season, observedAt, createdAt, writeCounts, maps)
    counts.fixtures = maps.fixtures.size
    await insertPlayerFacts(db, bootstrap, feedRunId, season, observedAt, createdAt, writeCounts, maps)
    counts.players = maps.players.size
    await upsertCompletedResults(db, bootstrap, elementSummaries, feedRunId, maps, writeCounts)
    await markAbsentPlayersInactive(db, feedRunId, season, observedAt, maps, writeCounts)

    await stageHook(options, 'facts')
    db.sqlite.exec('COMMIT')
    transactionOpen = false
  } catch (error) {
    if (transactionOpen) {
      try { db.sqlite.exec('ROLLBACK') } catch {}
    }
    throw error
  }

  return {
    counts: {
      ...counts,
      teamObservations: writeCounts.teamObservations,
      gameweekObservations: writeCounts.gameweekObservations,
      fixtureObservations: writeCounts.fixtureObservations,
      playerObservations: writeCounts.playerObservations,
      resultsInserted: writeCounts.resultsInserted,
      resultsUpdated: writeCounts.resultsUpdated,
      resultsSkipped: writeCounts.resultsSkipped,
      unmatchedCount: writeCounts.unmatchedCount,
      unmatched: writeCounts.unmatchedCount,
    },
    insertedCount: writeCounts.insertedCount + writeCounts.teamObservations + writeCounts.gameweekObservations + writeCounts.fixtureObservations + writeCounts.playerObservations + writeCounts.resultsInserted,
    updatedCount: writeCounts.updatedCount + writeCounts.resultsUpdated,
    unmatchedCount: writeCounts.unmatchedCount,
  }
}

async function runPayloadIngestion({
  dbPath,
  bootstrap,
  fixtures,
  elementSummaries,
  season,
  source = 'OFFICIAL_FPL',
  startedAt,
  observedAt,
  sourceUpdatedAt,
  finishedAt,
  requestCount,
  metadata = {},
  partialErrors = [],
  usedCache = false,
  cacheCapturedAt = null,
  failureAfterStage,
  failAfterStage,
  onStage,
}) {
  const normalizedSummaries = normalizeElementSummaries(elementSummaries)
  const times = defaultTimes({ startedAt, observedAt, sourceUpdatedAt, finishedAt })
  const resolvedSeason = resolveSeason({ season, bootstrap })
  const payloadHash = hashPayload(payloadBundle({ bootstrap, fixtures, elementSummaries: normalizedSummaries }))
  const db = await openDatabase(dbPath)
  let feedRunId = null
  try {
    feedRunId = await startFeedRun(db, {
      source,
      startedAt: times.startedAt,
      sourceUpdatedAt: times.sourceUpdatedAt,
      payloadHash: null,
      requestCount: requestCount ?? 2 + Object.keys(normalizedSummaries).length,
      metadata: { ...metadata, season: resolvedSeason },
    })
    const written = await writeOfficialFacts(db, {
      bootstrap,
      fixtures,
      elementSummaries: normalizedSummaries,
      feedRunId,
      season: resolvedSeason,
      observedAt: times.observedAt,
      createdAt: times.startedAt,
      options: { failureAfterStage, failAfterStage, onStage },
    })
    const status = partialErrors.length ? 'PARTIAL' : 'SUCCEEDED'
    const errorSummary = partialErrors.length ? partialErrors.map(sanitizeError).join('; ').slice(0, 500) : null
    await finishFeedRun(db, feedRunId, status, {
      finishedAt: times.finishedAt,
      sourceUpdatedAt: times.sourceUpdatedAt,
      payloadHash,
      requestCount: requestCount ?? 2 + Object.keys(normalizedSummaries).length,
      insertedCount: written.insertedCount,
      updatedCount: written.updatedCount,
      unmatchedCount: written.unmatchedCount,
      usedCache,
      cacheCapturedAt,
      errorSummary,
    })
    // Facts have committed before this independent ledger operation. A
    // projection failure is represented by its own failed ForecastRun and
    // must never roll back a successful official refresh.
    // `observedAt` is the effective information timestamp. `finishedAt` is
    // merely when this import completed and can be later (or, in replayed
    // data, earlier) than the facts it persisted.
    const forecast = await createForecastRun(db, { asOf: times.observedAt, createdAt: times.finishedAt })
    return {
      feedRunId,
      status,
      season: resolvedSeason,
      freshnessAt: times.sourceUpdatedAt,
      payloadHash,
      counts: written.counts,
      forecast,
    }
  } catch (error) {
    if (feedRunId) {
      try {
        await failFeedRun(db, feedRunId, error, {
          finishedAt: times.finishedAt,
          sourceUpdatedAt: times.sourceUpdatedAt,
          payloadHash,
          requestCount: requestCount ?? 2 + Object.keys(normalizedSummaries).length,
          usedCache,
          cacheCapturedAt,
        })
      } catch (feedRunError) {
        error.feedRunError = sanitizeError(feedRunError)
      }
    }
    throw error
  } finally {
    await closeDb()
  }
}

async function openDatabase(dbPath) {
  await migrateDatabase(dbPath)
  return getDb(dbPath)
}

export async function ingestOfficialFpl(options = {}) {
  if (!options.bootstrap || !Array.isArray(options.bootstrap.teams) || !Array.isArray(options.bootstrap.events) || !Array.isArray(options.bootstrap.elements)) {
    throw new Error('bootstrap payload with teams, events and elements is required')
  }
  if (!Array.isArray(options.fixtures)) throw new Error('fixtures payload must be an array')
  return runPayloadIngestion(options)
}

async function requestOfficialJson(endpoint, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`https://fantasy.premierleague.com/api/${endpoint}`, { signal: controller.signal })
    if (!response.ok) throw new Error(`FPL API ${endpoint} returned HTTP ${response.status}`)
    return response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchOfficialPayloads(fetchJson, { includeHistory = true } = {}) {
  let requestCount = 0
  const partialErrors = []
  const request = endpoint => {
    requestCount += 1
    return fetchJson(endpoint)
  }
  let bootstrap
  let fixtures
  try {
    const fetched = await Promise.all([request('bootstrap-static/'), request('fixtures/')])
    bootstrap = fetched[0]
    fixtures = fetched[1]
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    failure.requestCount = requestCount
    throw failure
  }
  const elementSummaries = {}

  if (includeHistory && bootstrap.events?.some(event => booleanValue(event.finished))) {
    for (let offset = 0; offset < bootstrap.elements.length; offset += 20) {
      const batch = bootstrap.elements.slice(offset, offset + 20)
      await Promise.all(batch.map(async player => {
        try {
          elementSummaries[String(player.id)] = await request(`element-summary/${player.id}/`)
        } catch (error) {
          partialErrors.push(`element-summary/${player.id}: ${sanitizeError(error)}`)
          elementSummaries[String(player.id)] = { history: [] }
        }
      }))
    }
  }

  return { bootstrap, fixtures, elementSummaries, requestCount, partialErrors }
}

function cacheAgeLimit(options) {
  if (options.cacheMaxAgeMs !== undefined) return Number(options.cacheMaxAgeMs)
  const configured = Number(process.env.FPL_CACHE_MAX_AGE_MS)
  return Number.isFinite(configured) && configured >= 0 ? configured : 24 * 60 * 60 * 1000
}

function readOfficialCache(cachePath, maxAgeMs) {
  if (!cachePath || !fs.existsSync(cachePath)) return null
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    const capturedAt = cached.capturedAt
    const capturedMillis = Date.parse(capturedAt)
    if (!capturedAt || !Number.isFinite(capturedMillis)) return null
    if (maxAgeMs >= 0 && Date.now() - capturedMillis > maxAgeMs) return null
    if (!cached.bootstrap || !Array.isArray(cached.fixtures)) return null
    return {
      bootstrap: cached.bootstrap,
      fixtures: cached.fixtures,
      elementSummaries: cached.elementSummaries || {},
      sourceUpdatedAt: cached.sourceUpdatedAt || capturedAt,
      capturedAt,
    }
  } catch {
    return null
  }
}

function writeOfficialCache(cachePath, payloads, capturedAt, sourceUpdatedAt) {
  if (!cachePath) return
  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  fs.writeFileSync(cachePath, `${canonicalJson({ ...payloads, capturedAt, sourceUpdatedAt })}\n`)
}

export function resolveOfficialCachePath({ cachePath, env = process.env, cwd = process.cwd() } = {}) {
  if (cachePath !== undefined) return cachePath
  const configured = env.FPL_INGEST_CACHE_PATH || env.FPL_DATA_CACHE_FILE
  if (configured) return path.resolve(cwd, configured)
  if (env.APP_DATA_DIR) return path.resolve(cwd, env.APP_DATA_DIR, 'cache', 'fpl-official.json')
  return path.resolve(cwd, '.cache', 'fpl-official.json')
}

export async function refreshOfficialFpl({
  dbPath,
  fetchJson = endpoint => requestOfficialJson(endpoint),
  cachePath,
  cacheMaxAgeMs,
  includeHistory = process.env.FPL_INGEST_MATCH_HISTORY !== '0',
  ...options
} = {}) {
  const resolvedCachePath = resolveOfficialCachePath({ cachePath })
  const times = defaultTimes(options)
  const db = await openDatabase(dbPath)
  let feedRunId = null
  let requestCount = 0
  try {
    feedRunId = await startFeedRun(db, {
      source: 'OFFICIAL_FPL',
      startedAt: times.startedAt,
      requestCount: 0,
      metadata: { mode: 'network_refresh' },
    })

    let payloads
    let usedCache = false
    let cacheCapturedAt = null
    let partialErrors = []
    try {
      const fetched = await fetchOfficialPayloads(fetchJson, { includeHistory })
      payloads = fetched
      requestCount = fetched.requestCount
      partialErrors = fetched.partialErrors
    } catch (error) {
      requestCount = Number(error.requestCount || requestCount)
      const cached = readOfficialCache(resolvedCachePath, cacheAgeLimit({ cacheMaxAgeMs }))
      if (!cached) throw error
      payloads = cached
      usedCache = true
      cacheCapturedAt = cached.capturedAt
      partialErrors = [`source refresh failed; using eligible cache: ${sanitizeError(error)}`]
    }

    const resolvedSeason = resolveSeason({ season: options.season, bootstrap: payloads.bootstrap })
    const sourceUpdatedAt = options.sourceUpdatedAt || payloads.sourceUpdatedAt || times.observedAt
    const normalizedSummaries = normalizeElementSummaries(payloads.elementSummaries)
    const payloadHash = hashPayload(payloadBundle({
      bootstrap: payloads.bootstrap,
      fixtures: payloads.fixtures,
      elementSummaries: normalizedSummaries,
    }))
    const written = await writeOfficialFacts(db, {
      bootstrap: payloads.bootstrap,
      fixtures: payloads.fixtures,
      elementSummaries: normalizedSummaries,
      feedRunId,
      season: resolvedSeason,
      observedAt: sourceUpdatedAt,
      createdAt: times.startedAt,
      options,
    })
    const status = partialErrors.length ? 'PARTIAL' : 'SUCCEEDED'
    await finishFeedRun(db, feedRunId, status, {
      finishedAt: times.finishedAt,
      sourceUpdatedAt,
      payloadHash,
      requestCount,
      insertedCount: written.insertedCount,
      updatedCount: written.updatedCount,
      unmatchedCount: written.unmatchedCount,
      usedCache,
      cacheCapturedAt,
      errorSummary: partialErrors.length ? partialErrors.map(sanitizeError).join('; ').slice(0, 500) : null,
      metadata: { season: resolvedSeason, mode: usedCache ? 'cache_fallback' : 'network_refresh' },
    })
    const forecast = await createForecastRun(db, { asOf: times.observedAt, createdAt: times.finishedAt })
    if (!usedCache && !partialErrors.length) {
      writeOfficialCache(resolvedCachePath, {
        bootstrap: payloads.bootstrap,
        fixtures: payloads.fixtures,
        elementSummaries: normalizedSummaries,
      }, new Date().toISOString(), sourceUpdatedAt)
    }
    return {
      feedRunId,
      status,
      season: resolvedSeason,
      freshnessAt: sourceUpdatedAt,
      payloadHash,
      counts: written.counts,
      forecast,
    }
  } catch (error) {
    if (feedRunId) {
      try {
        await failFeedRun(db, feedRunId, error, {
          finishedAt: times.finishedAt,
          requestCount,
        })
      } catch (feedRunError) {
        error.feedRunError = sanitizeError(feedRunError)
      }
    }
    throw error
  } finally {
    await closeDb()
  }
}

function cryptoRandomId() {
  return randomUUID()
}

if (process.argv[1] && process.argv[1].endsWith('ingest-fpl.mjs')) {
  try {
    const result = await refreshOfficialFpl()
    console.log(`official ingestion ${result.status.toLowerCase()}: feed_run=${result.feedRunId}, season=${result.season}, freshness=${result.freshnessAt}`)
  } catch (error) {
    console.error(`official ingestion failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
