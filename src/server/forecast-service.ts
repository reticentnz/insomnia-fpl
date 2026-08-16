import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, sanitizeError } from '../../scripts/feed-run.mjs'
import { projectionBreakdown, MODEL_VERSION } from '../model.ts'
import { resolvePlayerRole, type PlayerRoleProfile } from '../player-signals.ts'
import { fixtureRateModel, fixtureRoleStates, MARKET_CLEAN_SHEET_WEIGHT, projectFixture } from '../core/projection.ts'
import { combineSampleStreams, SIMULATION_COUNT, SIMULATION_ENGINE_VERSION, SIMULATION_SEED_VERSION, simulateFixtureOutcomes, simulateFromStoredForecast, summarizeSampleDistribution } from '../core/uncertainty.ts'
import type { ProjectionCatalogFixture, ProjectionCatalogPlayer, ProjectionInputCatalog } from '../core/types.ts'
import { assembleProjectionInputCatalog } from './catalog-service.ts'
import { getTeamColor, type Player } from '../domain.ts'

type Database = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

export const DEFAULT_MAX_GAMEWEEKS = 5

export type CreateForecastRunOptions = {
  asOf?: string | Date
  createdAt?: string | Date
  modelVersion?: string
  maxGameweeks?: number
  config?: Record<string, unknown>
  /** Test-only hook used to prove an interrupted projection leaves no child set. */
  projectFixture?: (player: ProjectionCatalogPlayer, fixture: ProjectionCatalogFixture, catalog: ProjectionInputCatalog, context: { forecastRunId: string; modelVersion: string }) => ForecastRow
}

export type ForecastRow = {
  playerId: string; fixtureId: string; expectedMinutes: number
  appearancePoints: number; goalPoints: number; assistPoints: number; cleanSheetPoints: number
  goalsConcededPoints: number; savePoints: number; penaltyPoints: number; defensiveContributionPoints: number
  bonusPoints: number; cardPoints: number; meanPoints: number; standardDeviation: number
  p10Points: number; p50Points: number; p90Points: number
  startProbability: number; substituteProbability: number; noShowProbability: number
  minutesConfidence: string; strengthMethod: string; roleSource: unknown; inputProvenance: unknown
}

const iso = (value: string | Date | undefined) => {
  const result = value instanceof Date ? value.toISOString() : value || new Date().toISOString()
  if (Number.isNaN(Date.parse(result))) throw new Error('Forecast time must be an ISO-8601 timestamp')
  return new Date(result).toISOString()
}
const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
const nullableNumber = (value: unknown) => value == null ? undefined : number(value)
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function baseRole(player: ProjectionCatalogPlayer): PlayerRoleProfile {
  const official = player.official
  const position = String(official.position || 'MID')
  const minutes = Math.max(0, number(official.minutes))
  // FPL leaves chance_of_playing null for healthy players. Number(null) is 0,
  // so passing the value through the generic numeric helper incorrectly made
  // every unflagged player a certain no-show (especially visible in GW1).
  const reportedChance = nullableNumber(official.chance_of_playing)
  const defaultChance = ['i', 'u'].includes(String(official.status)) ? 0 : 100
  const chance = clamp(reportedChance ?? defaultChance, 0, 100) / 100
  // Blend FPL availability (health) with season-minute coverage so a healthy
  // player with limited minutes is not an automatic no-show, while a full
  // season starter is clearly favoured. Signals override the final role.
  const seasonCoverage = clamp(minutes / 2850, 0, 1)
  const blend = chance * (0.55 + 0.45 * seasonCoverage)
  const target = clamp(blend * 90, 0, 90)
  const isGoalkeeper = position === 'GK'
  const minutesIfStarting = isGoalkeeper ? 90 : 86
  const substituteProbabilityWhenBenched = isGoalkeeper ? .005 : .2
  const minutesIfSubstitute = isGoalkeeper ? 5 : 18
  const cameo = substituteProbabilityWhenBenched * minutesIfSubstitute
  return {
    startProbability: clamp((target - cameo) / (minutesIfStarting - cameo), 0, 1),
    minutesIfStarting, substituteProbabilityWhenBenched, minutesIfSubstitute,
    confidence: minutes >= 900 ? 'HIGH' : minutes > 0 ? 'MEDIUM' : 'LOW', derivedFromSignalIds: [],
  }
}

function toSignal(signal: Record<string, unknown>, fixture: ProjectionCatalogFixture) {
  return {
    id: String(signal.id), playerId: 0, gameweek: signal.gameweekId === fixture.gameweekId ? fixture.gameweekFplId : null,
    kind: signal.kind, value: signal.value, sourceType: signal.manualOverride ? 'MANUAL_OVERRIDE' : signal.sourceType,
    sourceUrl: signal.sourceUrl, sourceDate: signal.sourceDate || null, evidenceSummary: signal.evidenceSummary || '', confidence: Number(signal.confidence ?? 1), observedAt: signal.observedAt, validUntil: signal.validUntil, status: 'VERIFIED',
    interpretation: {
      id: null, origin: 'AUTO', claimClass: signal.claimClass || 'UNKNOWN', modelImpact: signal.modelImpact || 'NONE', value: signal.value || {},
      rationale: '', confidence: Number(signal.interpretationConfidence ?? signal.confidence ?? 1), status: signal.interpretationStatus || 'APPROVED',
    },
  } as any
}

function setPieceRole(signals: Array<Record<string, unknown>>) {
  const roles = signals.map(signal => (signal.value as Record<string, unknown> | undefined)?.setPieceRole)
  if (roles.includes('PENALTIES_AND_SET_PIECES')) return 'PENALTIES_AND_SET_PIECES' as const
  if (roles.includes('PENALTIES') && roles.includes('SET_PIECES')) return 'PENALTIES_AND_SET_PIECES' as const
  if (roles.includes('PENALTIES')) return 'PENALTIES' as const
  if (roles.includes('SET_PIECES')) return 'SET_PIECES' as const
  return undefined
}

/**
 * Adapts the canonical catalogue at the calculation boundary only. The actual
 * component calculation remains the shared projection model used by live code.
 */
export function projectCatalogFixture(player: ProjectionCatalogPlayer, fixture: ProjectionCatalogFixture, _catalog?: ProjectionInputCatalog, context?: { forecastRunId: string; modelVersion: string }): ForecastRow {
  const official = player.official
  const role = resolvePlayerRole(baseRole(player), player.roleSignals.map(signal => toSignal(signal, fixture)), {
    now: new Date(String(official.observed_at)), gameweek: fixture.gameweekFplId || undefined,
  })
  const position = String(official.position || 'MID') as 'GK' | 'DEF' | 'MID' | 'FWD'
  const stats = {
    minutes: number(official.minutes), starts: number(official.starts), totalPoints: number(official.total_points), goals: number(official.goals), assists: number(official.assists), cleanSheets: number(official.clean_sheets), goalsConceded: number(official.goals_conceded), saves: number(official.saves), bonus: number(official.bonus), bps: number(official.bps), yellowCards: number(official.yellow_cards), redCards: number(official.red_cards), ownGoals: number(official.own_goals), penaltiesMissed: number(official.penalties_missed), penaltiesSaved: number(official.penalties_saved), expectedGoals: number(official.expected_goals), expectedAssists: number(official.expected_assists), expectedGoalsConceded: number(official.expected_goals_conceded), expectedGoalsPer90: nullableNumber(player.underlying?.xg_per_90) ?? number(official.expected_goals_per_90), expectedAssistsPer90: nullableNumber(player.underlying?.xa_per_90) ?? number(official.expected_assists_per_90), expectedGoalsConcededPer90: number(official.expected_goals_conceded_per_90), savesPer90: number(official.saves) * 90 / Math.max(1, number(official.minutes)), clearancesBlocksInterceptions: number(official.clearances_blocks_interceptions), tackles: number(official.tackles), recoveries: number(official.recoveries), defensiveContribution: number(official.defensive_contribution), defensiveContributionPer90: number(official.defensive_contribution_per_90),
  }
  const modelPlayer: Player = {
    id: player.fplId, name: player.name, club: player.team.shortName, position, price: number(official.price_tenths) / 10,
    form: number(official.form), ownership: number(official.ownership_percent), minutes: number(official.minutes), fixture: `${fixture.opponent.shortName} (${fixture.isHome ? 'H' : 'A'})`, difficulty: fixture.difficulty || 3, projection: number(official.ep_next), colour: getTeamColor(player.team.shortName), status: String(official.status || 'a'), chanceOfPlaying: nullableNumber(official.chance_of_playing) ?? 100, active: Boolean(official.active), roleProfile: role, stats,
    upcomingFixtures: [{ gameweek: fixture.gameweekFplId || 0, opponent: fixture.opponent.shortName, venue: fixture.isHome ? 'H' : 'A', difficulty: fixture.difficulty || 3 }], dataConfidence: role.confidence,
    setPieceRole: setPieceRole(player.roleSignals),
  }
  const ownAttack = Number(player.teamStrength[fixture.isHome ? 'strengthAttackHome' : 'strengthAttackAway'])
  const ownDefence = Number(player.teamStrength[fixture.isHome ? 'strengthDefenceHome' : 'strengthDefenceAway'])
  const opponentAttack = Number(fixture.opponent.teamStrength[fixture.isHome ? 'strengthAttackAway' : 'strengthAttackHome'])
  const opponentDefence = Number(fixture.opponent.teamStrength[fixture.isHome ? 'strengthDefenceAway' : 'strengthDefenceHome'])
  const marketAttack = fixture.market ? (fixture.isHome ? fixture.market.homeExpectedGoals : fixture.market.awayExpectedGoals) / 1.4 : null
  const marketDefence = fixture.market ? (fixture.isHome ? fixture.market.awayExpectedGoals : fixture.market.homeExpectedGoals) / 1.4 : null
  const officialComplete = [ownAttack, ownDefence, opponentAttack, opponentDefence].every(value => Number.isFinite(value) && value > 0)
  const strength = marketAttack != null && marketDefence != null
    ? { method: 'MARKET_XG' as const, attackMultiplier: marketAttack, defenceMultiplier: marketDefence }
    : officialComplete
      ? { method: 'OFFICIAL_STRENGTH' as const, attackMultiplier: ownAttack / 1000 * (2 - opponentDefence / 1000), defenceMultiplier: opponentAttack / 1000 * (2 - ownDefence / 1000) }
      : undefined
  const marketCleanSheetProbability = fixture.market
    ? (fixture.isHome ? fixture.market.homeCleanSheetProbability : fixture.market.awayCleanSheetProbability) ?? undefined
    : undefined
  const fixtureInput = { gameweek: fixture.gameweekFplId || 0, opponent: fixture.opponent.shortName, venue: fixture.isHome ? 'H' as const : 'A' as const, difficulty: fixture.difficulty || 3, marketCleanSheetProbability, strength }
  const breakdown = projectionBreakdown(modelPlayer, 1)
  const components = projectFixture(modelPlayer, fixtureInput)
  const states = fixtureRoleStates(role)
  const rates = fixtureRateModel(modelPlayer, fixtureInput)
  const simulationInput = {
    engineVersion: SIMULATION_ENGINE_VERSION,
    seed: `${context?.forecastRunId || 'preview'}:${player.id}:${fixture.id}:${context?.modelVersion || MODEL_VERSION}:${SIMULATION_SEED_VERSION}`,
    position, role: { ...states, minutesIfStarting: role.minutesIfStarting, minutesIfSubstitute: role.minutesIfSubstitute },
    goalRate: rates.goalRate, assistRate: rates.assistRate, teamGoalsConcededRate: rates.xgcRate, saveRate: rates.saveRate,
    yellowCardRate: rates.cardRate, redCardRate: number(official.red_cards) * 90 / Math.max(1, number(official.minutes)),
    penaltySaveRate: rates.penaltySaveRate, penaltyMissRate: rates.penaltyMissRate, ownGoalRate: rates.ownGoalRate,
    defensiveActionRate: rates.defensiveRate, bonusRate: rates.bonusRate,
    samples: SIMULATION_COUNT,
  }
  const outcome = simulateFixtureOutcomes(simulationInput)
  const mean = outcome.mean
  return {
    playerId: player.id, fixtureId: fixture.id, expectedMinutes: components.expectedMinutes,
    appearancePoints: components.appearance, goalPoints: components.goals, assistPoints: components.assists,
    cleanSheetPoints: components.cleanSheet, goalsConcededPoints: components.goalsConceded,
    savePoints: components.saves, penaltyPoints: components.penalties, defensiveContributionPoints: components.defensiveContribution,
    bonusPoints: components.bonus, cardPoints: components.cards, meanPoints: mean,
    standardDeviation: outcome.standardDeviation, p10Points: outcome.p10, p50Points: outcome.p50, p90Points: outcome.p90,
    ...states, minutesConfidence: breakdown.minutesConfidence, strengthMethod: components.strengthMethod,
    roleSource: { derivedSignalIds: role.derivedFromSignalIds, simulationInput }, inputProvenance: player.provenance,
  }
}

async function targetGameweek(db: Database, catalog: ProjectionInputCatalog, asOf: string, maxGameweeks: number) {
  const candidates = [...new Map(catalog.players.flatMap(player => player.fixtures).filter(fixture => fixture.gameweekId && fixture.kickoffAt && Date.parse(fixture.kickoffAt) >= Date.parse(asOf)).map(fixture => [fixture.gameweekId!, fixture])).values()]
    .sort((left, right) => (left.gameweekFplId || Infinity) - (right.gameweekFplId || Infinity))
  if (!candidates.length) throw new Error(`No future scheduled gameweek exists at ${asOf}`)
  let first: ProjectionCatalogFixture | undefined
  let deadlineAt: string | null = null
  for (const candidate of candidates) {
    const deadline = await db.query(`SELECT observation."deadline_at" FROM "GameweekObservation" observation JOIN "FeedRun" run ON run."id"=observation."feed_run_id" WHERE observation."gameweek_id"=$1 AND datetime(observation."observed_at")<=datetime($2) AND run."status" IN ('SUCCEEDED','PARTIAL') ORDER BY datetime(observation."observed_at") DESC, observation."id" DESC LIMIT 1`, [candidate.gameweekId, asOf])
    const value = deadline.rows[0]?.deadline_at || null
    // A fixture can still have a future kickoff after its gameweek deadline;
    // it is not a forecast target once that deadline has passed.
    if (!value || Date.parse(value) >= Date.parse(asOf)) { first = candidate; deadlineAt = value; break }
  }
  if (!first?.gameweekId) throw new Error(`No pre-deadline scheduled gameweek exists at ${asOf}`)
  const allowed = new Set(candidates.filter(item => (item.gameweekFplId || Infinity) >= (first!.gameweekFplId || -Infinity)).slice(0, maxGameweeks).map(item => item.gameweekId!))
  return { gameweekId: first.gameweekId, deadlineAt, allowed }
}

async function selectedFeedId(db: Database, source: string, ids: string[], _asOf: string) {
  if (!ids.length) return null
  const marks = ids.map((_, index) => `$${index + 2}`).join(',')
  // The catalogue has already selected observations that existed at `asOf`.
  // A replay/import may persist those observations after their source time, so
  // filtering the owning run by local `started_at` would lose the exact input.
  const result = await db.query(`SELECT "id" FROM "FeedRun" WHERE "source"=$1 AND "id" IN (${marks}) ORDER BY datetime("started_at") DESC, "id" DESC LIMIT 1`, [source, ...ids])
  return result.rows[0]?.id || null
}

async function recordSetupFailure(db: Database, options: { asOf: string; createdAt: string; modelVersion: string; maxGameweeks: number; config: Record<string, unknown> }, error: unknown) {
  const gameweek = await db.query(`SELECT gameweek."id", observation."deadline_at" FROM "Gameweek" gameweek LEFT JOIN "GameweekObservation" observation ON observation."gameweek_id"=gameweek."id" WHERE datetime(observation."observed_at")<=datetime($1) ORDER BY CASE WHEN datetime(observation."deadline_at")>=datetime($1) THEN 0 ELSE 1 END, datetime(observation."deadline_at") ASC, gameweek."fpl_id" ASC LIMIT 1`, [options.asOf])
  const official = await db.query(`SELECT "id" FROM "FeedRun" WHERE "source"='OFFICIAL_FPL' AND "status" IN ('SUCCEEDED','PARTIAL') ORDER BY datetime("finished_at") DESC, "id" DESC LIMIT 1`)
  if (!gameweek.rows[0]?.id || !official.rows[0]?.id) throw error
  const id = randomUUID()
  await db.query(`INSERT INTO "ForecastRun" ("id","model_version","gameweek_id","max_gameweeks","as_of","created_at","deadline_at","status","eligible_for_backtest","official_feed_run_id","signal_version","input_hash","config_json","error_summary") VALUES ($1,$2,$3,$4,$5,$6,$7,'FAILED',0,$8,$9,$10,$11,$12)`, [id, options.modelVersion, gameweek.rows[0].id, options.maxGameweeks, options.asOf, options.createdAt, gameweek.rows[0].deadline_at || null, official.rows[0].id, createHash('sha256').update('[]').digest('hex'), createHash('sha256').update('{}').digest('hex'), canonicalJson(options.config), sanitizeError(error)])
  return { id, status: 'FAILED' as const, error: sanitizeError(error) }
}

export async function createForecastRun(db: Database, options: CreateForecastRunOptions = {}) {
  const asOf = iso(options.asOf)
  const createdAt = iso(options.createdAt)
  const maxGameweeks = options.maxGameweeks ?? DEFAULT_MAX_GAMEWEEKS
  if (!Number.isInteger(maxGameweeks) || maxGameweeks <= 0) throw new Error('maxGameweeks must be a positive integer')
  const config = { priorVersion: MODEL_VERSION, priorMinutes: 540, bonusPrior: 'bps-2026-27-v1', marketCleanSheetWeight: MARKET_CLEAN_SHEET_WEIGHT, simulationCount: SIMULATION_COUNT, seedVersion: SIMULATION_SEED_VERSION, ...options.config }
  let catalog: ProjectionInputCatalog
  let target: Awaited<ReturnType<typeof targetGameweek>>
  let officialFeedRunId: string | null
  let underlyingFeedRunId: string | null
  let marketFeedRunId: string | null
  let signalVersion: string
  try {
    catalog = await assembleProjectionInputCatalog(db, { asOf })
    target = await targetGameweek(db, catalog, asOf, maxGameweeks)
    officialFeedRunId = await selectedFeedId(db, 'OFFICIAL_FPL', catalog.sourceRunIds.official, asOf)
    if (!officialFeedRunId) throw new Error('No exact official feed run is available for forecast inputs')
    underlyingFeedRunId = await selectedFeedId(db, 'UNDERLYING', catalog.sourceRunIds.underlying, asOf)
    marketFeedRunId = await selectedFeedId(db, 'MARKET', catalog.sourceRunIds.market, asOf)
    signalVersion = createHash('sha256').update(canonicalJson(catalog.players.flatMap(player => player.provenance.eligibleSignalIds).sort())).digest('hex')
  } catch (error) {
    return recordSetupFailure(db, { asOf, createdAt, modelVersion: options.modelVersion || MODEL_VERSION, maxGameweeks, config }, error)
  }
  const id = randomUUID()
  await db.query(`INSERT INTO "ForecastRun" ("id","model_version","gameweek_id","max_gameweeks","as_of","created_at","deadline_at","status","eligible_for_backtest","official_feed_run_id","underlying_feed_run_id","market_feed_run_id","signal_version","calibration_version","input_hash","config_json") VALUES ($1,$2,$3,$4,$5,$6,$7,'RUNNING',0,$8,$9,$10,$11,NULL,$12,$13)`, [id, options.modelVersion || MODEL_VERSION, target.gameweekId, maxGameweeks, asOf, createdAt, target.deadlineAt, officialFeedRunId, underlyingFeedRunId, marketFeedRunId, signalVersion, catalog.inputHash, canonicalJson(config)])
  try {
    const project = options.projectFixture || projectCatalogFixture
    const modelVersion = options.modelVersion || MODEL_VERSION
    const rows = catalog.players.flatMap(player => player.fixtures.filter(fixture => target.allowed.has(fixture.gameweekId || '') && fixture.kickoffAt && Date.parse(fixture.kickoffAt) >= Date.parse(asOf)).map(fixture => project(player, fixture, catalog, { forecastRunId: id, modelVersion })))
    await db.query('BEGIN IMMEDIATE')
    for (const row of rows) await db.query(`INSERT INTO "PlayerFixtureForecast" ("forecast_run_id","player_id","fixture_id","expected_minutes","appearance_points","goal_points","assist_points","clean_sheet_points","goals_conceded_points","save_points","penalty_points","defensive_contribution_points","bonus_points","card_points","mean_points","standard_deviation","p10_points","p50_points","p90_points","start_probability","substitute_probability","no_show_probability","minutes_confidence","strength_method","role_source_json","input_provenance_json") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`, [id, row.playerId, row.fixtureId, row.expectedMinutes, row.appearancePoints, row.goalPoints, row.assistPoints, row.cleanSheetPoints, row.goalsConcededPoints, row.savePoints, row.penaltyPoints, row.defensiveContributionPoints, row.bonusPoints, row.cardPoints, row.meanPoints, row.standardDeviation, row.p10Points, row.p50Points, row.p90Points, row.startProbability, row.substituteProbability, row.noShowProbability, row.minutesConfidence, row.strengthMethod, canonicalJson(row.roleSource), canonicalJson(row.inputProvenance)])
    const eligible = target.deadlineAt && Date.parse(createdAt) <= Date.parse(target.deadlineAt) ? 1 : 0
    await db.query(`UPDATE "ForecastRun" SET "status"='SUCCEEDED', "eligible_for_backtest"=$2 WHERE "id"=$1 AND "status"='RUNNING'`, [id, eligible])
    await db.query('COMMIT')
    return { id, status: 'SUCCEEDED' as const, inputHash: catalog.inputHash, forecastCount: rows.length, eligibleForBacktest: Boolean(eligible), deadlineAt: target.deadlineAt }
  } catch (error) {
    try { await db.query('ROLLBACK') } catch {}
    await db.query(`UPDATE "ForecastRun" SET "status"='FAILED', "eligible_for_backtest"=0, "error_summary"=$2 WHERE "id"=$1 AND "status"='RUNNING'`, [id, sanitizeError(error)])
    return { id, status: 'FAILED' as const, error: sanitizeError(error) }
  }
}

export async function latestEligibleForecastRun(db: Database, gameweekId: string) {
  const result = await db.query(`SELECT * FROM "ForecastRun" WHERE "gameweek_id"=$1 AND "status"='SUCCEEDED' AND "eligible_for_backtest"=1 ORDER BY datetime("created_at") DESC, "id" DESC LIMIT 1`, [gameweekId])
  return result.rows[0] || null
}

export async function latestForecastSummary(db: Database, { horizon = 1 }: { horizon?: number } = {}) {
  if (![1, 3, 5].includes(Number(horizon))) throw new Error('horizon must be 1, 3, or 5')
  const run = (await db.query(`SELECT * FROM "ForecastRun" WHERE "status"='SUCCEEDED' ORDER BY datetime("created_at") DESC, "id" DESC LIMIT 1`)).rows[0]
  if (!run) return null
  const rows = (await db.query(`SELECT forecast.*, player."fpl_id", gameweek."fpl_id" AS "gameweek_fpl_id", player_obs."position"
    FROM "PlayerFixtureForecast" forecast
    JOIN "Player" player ON player."id"=forecast."player_id"
    JOIN "FixtureObservation" fixture ON fixture."fixture_id"=forecast."fixture_id"
    JOIN "Gameweek" gameweek ON gameweek."id"=fixture."gameweek_id"
    JOIN "PlayerObservation" player_obs ON player_obs."player_id"=forecast."player_id"
    WHERE forecast."forecast_run_id"=$1 AND datetime(fixture."observed_at")<=datetime($2)
      AND NOT EXISTS (SELECT 1 FROM "FixtureObservation" newer WHERE newer."fixture_id"=fixture."fixture_id" AND datetime(newer."observed_at")<=datetime($2) AND (datetime(newer."observed_at")>datetime(fixture."observed_at") OR (newer."observed_at"=fixture."observed_at" AND newer."id">fixture."id")))
      AND datetime(player_obs."observed_at")<=datetime($2)
      AND NOT EXISTS (SELECT 1 FROM "PlayerObservation" newer_obs WHERE newer_obs."player_id"=player_obs."player_id" AND datetime(newer_obs."observed_at")<=datetime($2) AND (datetime(newer_obs."observed_at")>datetime(player_obs."observed_at") OR (newer_obs."observed_at"=player_obs."observed_at" AND newer_obs."id">player_obs."id")))
    ORDER BY gameweek."fpl_id", player."fpl_id"`, [run.id, run.as_of])).rows
  const gameweeks = [...new Set(rows.map(row => Number(row.gameweek_fpl_id)))].sort((left, right) => left - right).slice(0, Number(horizon))
  const selected = rows.filter(row => gameweeks.includes(Number(row.gameweek_fpl_id)))
  const players = new Map<number, any>()
  for (const row of selected) {
    const id = Number(row.fpl_id)
    const current = players.get(id) || { playerId: id, fixtureCount: 0, meanPoints: 0, variance: 0, streams: [], minuteStreams: [], samplesAvailable: true }
    const sim = simulateFromStoredForecast(row)
    current.fixtureCount += 1
    current.meanPoints += Number(row.mean_points)
    current.variance += Number(row.standard_deviation) ** 2
    if (sim) {
      current.streams.push(sim.samples)
      if (sim.minuteSamples) current.minuteStreams.push(sim.minuteSamples)
    } else {
      current.samplesAvailable = false
    }
    players.set(id, current)
  }
  const fixtureCount = selected.length
  const playerIds = new Set(selected.map(row => Number(row.fpl_id)))
  const underlyingPlayerIds = new Set(selected.filter(row => {
    try { return Boolean(JSON.parse(String(row.input_provenance_json || '{}')).underlyingObservationId) } catch { return false }
  }).map(row => Number(row.fpl_id)))
  const quality = {
    fallbackFixtureRatio: fixtureCount ? selected.filter(row => row.strength_method === 'FDR_FALLBACK').length / fixtureCount : 1,
    lowMinutesFixtureRatio: fixtureCount ? selected.filter(row => row.minutes_confidence === 'LOW').length / fixtureCount : 1,
    underlyingPlayerRatio: playerIds.size ? underlyingPlayerIds.size / playerIds.size : 0,
    marketFixtureRatio: fixtureCount ? selected.filter(row => row.strength_method === 'MARKET_XG').length / fixtureCount : 0,
  }
  return { id: run.id, modelVersion: run.model_version, asOf: run.as_of, createdAt: run.created_at, horizon: Number(horizon), gameweeks, quality, players: [...players.values()].map(player => {
    if (!player.samplesAvailable) {
      const standardDeviation = Math.sqrt(player.variance)
      const percentileDistance = 1.2815515655446004 * standardDeviation
      return { playerId: player.playerId, fixtureCount: player.fixtureCount, meanPoints: player.meanPoints, standardDeviation, p10Points: player.meanPoints - percentileDistance, p50Points: player.meanPoints, p90Points: player.meanPoints + percentileDistance }
    }
    const combined = combineSampleStreams(player.streams)
    const combinedMinutes = player.minuteStreams.length ? combineSampleStreams(player.minuteStreams) : undefined
    const summary = summarizeSampleDistribution(combined, combinedMinutes)
    return {
      playerId: player.playerId,
      fixtureCount: player.fixtureCount,
      meanPoints: summary.mean,
      standardDeviation: summary.standardDeviation,
      p10Points: summary.p10,
      p50Points: summary.p50,
      p90Points: summary.p90,
    }
  }) }
}

export async function assertForecastRunMutable(db: Database, id: string) {
  const result = await db.query('SELECT "status" FROM "ForecastRun" WHERE "id"=$1', [id])
  if (!result.rows.length) throw new Error(`Forecast run ${id} does not exist`)
  if (result.rows[0].status === 'SUCCEEDED') throw new Error(`Forecast run ${id} is immutable after success`)
}

export async function updateForecastRun() { throw new Error('Succeeded forecast runs cannot be updated through application services') }
export async function deleteForecastRun() { throw new Error('Succeeded forecast runs cannot be deleted through application services') }
