import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, sanitizeError } from '../../scripts/feed-run.mjs'
import { projectionBreakdown, MODEL_VERSION } from '../model.ts'
import { resolvePlayerRole, type PlayerRoleProfile } from '../player-signals.ts'
import { fixtureExpectedMinutes, fixtureRateModel, fixtureRoleStates, MARKET_CLEAN_SHEET_WEIGHT, projectFixture, projectionSampleCalibration } from '../core/projection.ts'
import { combineSampleStreams, SIMULATION_COUNT, SIMULATION_ENGINE_VERSION, SIMULATION_SEED_VERSION, simulateFixtureOutcomes, simulateFromStoredForecast, summarizeSampleDistribution, type FixtureSimulationInput } from '../core/uncertainty.ts'
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
  projectFixture?: (player: ProjectionCatalogPlayer, fixture: ProjectionCatalogFixture, catalog: ProjectionInputCatalog, context: { forecastRunId: string; modelVersion: string; completedGameweeks: number }) => ForecastRow
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

export function baseRole(player: ProjectionCatalogPlayer, completedGameweeks = 0): PlayerRoleProfile {
  const official = player.official
  const position = String(official.position || 'MID')
  const minutes = Math.max(0, number(official.minutes))
  // FPL leaves chance_of_playing null for healthy players. Number(null) is 0,
  // so passing the value through the generic numeric helper incorrectly made
  // every unflagged player a certain no-show (especially visible in GW1).
  const reportedChance = nullableNumber(official.chance_of_playing)
  const defaultChance = ['i', 'u'].includes(String(official.status)) ? 0 : 100
  const chance = clamp(reportedChance ?? defaultChance, 0, 100) / 100
  // Normalize current-season evidence by matches actually completed. A one-match
  // prior prevents GW1 from making either a starter or an unused squad player a
  // certainty, while avoiding the old full-season denominator that suppressed
  // every early-season starter.
  const completed = Math.max(0, Math.floor(completedGameweeks))
  const starts = Math.max(0, number(official.starts))
  const observedMinutesShare = completed ? clamp(minutes / (completed * 90), 0, 1) : .55
  const observedStartsShare = completed ? clamp(starts / completed, 0, 1) : .55
  const observedRoleShare = .65 * observedStartsShare + .35 * observedMinutesShare
  const currentRoleShare = completed ? (.55 + completed * observedRoleShare) / (completed + 1) : .55
  const historical = player.historicalPrior
  // A matched, established prior prevents one missing or incomplete GW1
  // snapshot from reducing a proven starter to bench-player minutes. Its
  // influence decays through the opening four completed gameweeks.
  const historicalEligible = historical && historical.confidence >= .8 && historical.minutes >= 900 && historical.starts >= 10
  const historicalRoleShare = historicalEligible
    ? clamp(.62 + .011 * historical.starts + .000025 * historical.minutes, .70, .95)
    : null
  const currentWeight = Math.min(1, Math.max(.1, completed / 8))
  const roleShare = historicalRoleShare == null ? currentRoleShare : historicalRoleShare * (1 - currentWeight) + observedRoleShare * currentWeight
  const blend = chance * roleShare
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

type DerivedTeamRating = { attack: number; defenceWeakness: number; sampleGameweeks: number }
const derivedRatingCache = new WeakMap<ProjectionInputCatalog, Map<number, Map<string, DerivedTeamRating>>>()

/** Early-season team xG/xGC ratings, strongly shrunk to the league scoring prior. */
export function deriveTeamRatings(catalog: ProjectionInputCatalog, completedGameweeks: number) {
  const completed = Math.max(0, Math.floor(completedGameweeks))
  const cached = derivedRatingCache.get(catalog)?.get(completed)
  if (cached) return cached
  const ratings = new Map<string, DerivedTeamRating>()
  if (!completed) return ratings
  const leagueGoals = 1.4
  const priorMatches = 3
  const teams = new Map<string, ProjectionCatalogPlayer[]>()
  for (const player of catalog.players) teams.set(player.team.id, [...(teams.get(player.team.id) || []), player])
  for (const [teamId, players] of teams) {
    const teamXg = players.reduce((sum, player) => sum + Math.max(0, number(player.official.expected_goals)), 0)
    const fullMatchXgc = players
      .filter(player => number(player.official.minutes) >= completed * 60)
      .map(player => Math.max(0, number(player.official.expected_goals_conceded)))
      .sort((left, right) => left - right)
    const middle = Math.floor(fullMatchXgc.length / 2)
    const teamXgc = fullMatchXgc.length
      ? (fullMatchXgc.length % 2 ? fullMatchXgc[middle] : (fullMatchXgc[middle - 1] + fullMatchXgc[middle]) / 2)
      : leagueGoals * completed
    const attackRate = (teamXg + leagueGoals * priorMatches) / (completed + priorMatches)
    const defenceRate = (teamXgc + leagueGoals * priorMatches) / (completed + priorMatches)
    ratings.set(teamId, { attack: clamp(attackRate / leagueGoals, .7, 1.3), defenceWeakness: clamp(defenceRate / leagueGoals, .7, 1.3), sampleGameweeks: completed })
  }
  const byGameweek = derivedRatingCache.get(catalog) || new Map<number, Map<string, DerivedTeamRating>>()
  byGameweek.set(completed, ratings)
  derivedRatingCache.set(catalog, byGameweek)
  return ratings
}

export function catalogFixtureStrength(player: ProjectionCatalogPlayer, fixture: ProjectionCatalogFixture, catalog?: ProjectionInputCatalog, completedGameweeks = 0) {
  const ownAttack = Number(player.teamStrength[fixture.isHome ? 'strengthAttackHome' : 'strengthAttackAway'])
  const ownDefence = Number(player.teamStrength[fixture.isHome ? 'strengthDefenceHome' : 'strengthDefenceAway'])
  const opponentAttack = Number(fixture.opponent.teamStrength[fixture.isHome ? 'strengthAttackAway' : 'strengthAttackHome'])
  const opponentDefence = Number(fixture.opponent.teamStrength[fixture.isHome ? 'strengthDefenceAway' : 'strengthDefenceHome'])
  const marketAttack = fixture.market ? (fixture.isHome ? fixture.market.homeExpectedGoals : fixture.market.awayExpectedGoals) / 1.4 : null
  const marketDefence = fixture.market ? (fixture.isHome ? fixture.market.awayExpectedGoals : fixture.market.homeExpectedGoals) / 1.4 : null
  const officialComplete = [ownAttack, ownDefence, opponentAttack, opponentDefence].every(value => Number.isFinite(value) && value > 0)
  if (marketAttack != null && marketDefence != null) return {
    method: 'MARKET_XG' as const,
    attackMultiplier: marketAttack,
    defenceMultiplier: marketDefence,
    marketTeamExpectedGoals: fixture.isHome ? fixture.market!.homeExpectedGoals : fixture.market!.awayExpectedGoals,
  }
  if (officialComplete) return { method: 'OFFICIAL_STRENGTH' as const, attackMultiplier: ownAttack / 1000 * (2 - opponentDefence / 1000), defenceMultiplier: opponentAttack / 1000 * (2 - ownDefence / 1000) }
  if (catalog && completedGameweeks > 0) {
    const ratings = deriveTeamRatings(catalog, completedGameweeks)
    const own = ratings.get(player.team.id)
    const opponent = ratings.get(fixture.opponent.id)
    if (own && opponent) return { method: 'DERIVED_TEAM_RATING' as const, attackMultiplier: own.attack * opponent.defenceWeakness, defenceMultiplier: opponent.attack * own.defenceWeakness }
  }
  return undefined
}

const ATTACKING_RATE_PRIORS: Record<string, { goal: number; assist: number }> = {
  GK: { goal: .002, assist: .008 }, DEF: { goal: .055, assist: .095 }, MID: { goal: .205, assist: .185 }, FWD: { goal: .37, assist: .15 },
}
const MARKET_ASSISTS_PER_GOAL = .70

function observedAttackingRate(player: ProjectionCatalogPlayer, kind: 'goal' | 'assist') {
  const official = player.official
  const position = String(official.position || 'MID')
  const minutes = Math.max(0, number(official.minutes))
  const underlying = kind === 'goal' ? nullableNumber(player.underlying?.xg_per_90) : nullableNumber(player.underlying?.xa_per_90)
  const officialPer90 = kind === 'goal' ? number(official.expected_goals_per_90) : number(official.expected_assists_per_90)
  const total = kind === 'goal' ? number(official.expected_goals) : number(official.expected_assists)
  const observed = underlying ?? (officialPer90 > 0 ? officialPer90 : minutes > 0 ? total * 90 / minutes : 0)
  // This is only an allocation weight. A small position prior prevents a
  // zero-GW1 sample from being assigned none of the team's market output.
  const prior = ATTACKING_RATE_PRIORS[position] || ATTACKING_RATE_PRIORS.MID
  return Math.max(.001, minutes > 0 ? (observed * minutes + (kind === 'goal' ? prior.goal : prior.assist) * 540) / (minutes + 540) : (kind === 'goal' ? prior.goal : prior.assist))
}

function resolvedRole(player: ProjectionCatalogPlayer, fixture: ProjectionCatalogFixture, completedGameweeks?: number) {
  return resolvePlayerRole(baseRole(player, completedGameweeks), player.roleSignals.map(signal => toSignal(signal, fixture)), {
    now: new Date(String(player.official.observed_at)), gameweek: fixture.gameweekFplId || undefined, completedGameweeks,
  })
}

/** Allocate a matched market team-goal expectation across expected player minutes. */
export function marketAttackingRateOverride(player: ProjectionCatalogPlayer, fixture: ProjectionCatalogFixture, catalog: ProjectionInputCatalog | undefined, completedGameweeks?: number) {
  const teamGoals = fixture.market ? Number(fixture.isHome ? fixture.market.homeExpectedGoals : fixture.market.awayExpectedGoals) : 0
  if (!catalog || !(teamGoals > 0)) return undefined
  const teammates = catalog.players.flatMap(candidate => {
    if (candidate.team.id !== player.team.id) return []
    const candidateFixture = candidate.fixtures.find(item => item.id === fixture.id)
    if (!candidateFixture) return []
    // Resolve every teammate through the same path. Reusing the caller's role
    // for only one player makes the denominator depend on which player happens
    // to be forecast first, breaking market-total conservation.
    const candidateRole = resolvedRole(candidate, candidateFixture, completedGameweeks)
    const minutes = fixtureExpectedMinutes(candidateRole)
    return [{ candidate, minutes, goalWeight: observedAttackingRate(candidate, 'goal') * minutes / 90, assistWeight: observedAttackingRate(candidate, 'assist') * minutes / 90 }]
  })
  const current = teammates.find(item => item.candidate.id === player.id)
  if (!current || !(current.minutes > 0)) return undefined
  const goalTotal = teammates.reduce((sum, item) => sum + item.goalWeight, 0)
  const assistTotal = teammates.reduce((sum, item) => sum + item.assistWeight, 0)
  if (!(goalTotal > 0) || !(assistTotal > 0)) return undefined
  const goalShare = current.goalWeight / goalTotal
  const assistShare = current.assistWeight / assistTotal
  return {
    goalRate: teamGoals * goalShare * 90 / current.minutes,
    assistRate: teamGoals * MARKET_ASSISTS_PER_GOAL * assistShare * 90 / current.minutes,
    goalShare,
    assistShare,
  }
}

function toSignal(signal: Record<string, unknown>, fixture: ProjectionCatalogFixture) {
  return {
    id: String(signal.id), playerId: 0, gameweek: signal.gameweekId === fixture.gameweekId ? fixture.gameweekFplId : null,
    kind: signal.kind, value: signal.value, sourceType: signal.manualOverride ? 'MANUAL_OVERRIDE' : signal.sourceType,
    sourceUrl: signal.sourceUrl, sourceDate: signal.sourceDate || null, evidenceSummary: signal.evidenceSummary || '', evidenceText: signal.evidenceText || signal.evidenceSummary || '', confidence: Number(signal.confidence ?? 1), observedAt: signal.observedAt, validUntil: signal.validUntil, status: 'VERIFIED',
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
export function projectCatalogFixture(player: ProjectionCatalogPlayer, fixture: ProjectionCatalogFixture, catalog?: ProjectionInputCatalog, context?: { forecastRunId: string; modelVersion: string; completedGameweeks: number }): ForecastRow {
  const official = player.official
  const role = resolvedRole(player, fixture, context?.completedGameweeks)
  const position = String(official.position || 'MID') as 'GK' | 'DEF' | 'MID' | 'FWD'
  const stats = {
    minutes: number(official.minutes), starts: number(official.starts), totalPoints: number(official.total_points), goals: number(official.goals), assists: number(official.assists), cleanSheets: number(official.clean_sheets), goalsConceded: number(official.goals_conceded), saves: number(official.saves), bonus: number(official.bonus), bps: number(official.bps), yellowCards: number(official.yellow_cards), redCards: number(official.red_cards), ownGoals: number(official.own_goals), penaltiesMissed: number(official.penalties_missed), penaltiesSaved: number(official.penalties_saved), expectedGoals: number(official.expected_goals), expectedAssists: number(official.expected_assists), expectedGoalsConceded: number(official.expected_goals_conceded), expectedGoalsPer90: nullableNumber(player.underlying?.xg_per_90) ?? number(official.expected_goals_per_90), expectedAssistsPer90: nullableNumber(player.underlying?.xa_per_90) ?? number(official.expected_assists_per_90), expectedGoalsConcededPer90: number(official.expected_goals_conceded_per_90), savesPer90: number(official.saves) * 90 / Math.max(1, number(official.minutes)), clearancesBlocksInterceptions: number(official.clearances_blocks_interceptions), tackles: number(official.tackles), recoveries: number(official.recoveries), defensiveContribution: number(official.defensive_contribution), defensiveContributionPer90: number(official.defensive_contribution_per_90),
  }
  const modelPlayer: Player = {
    id: player.fplId, name: player.name, club: player.team.shortName, position, price: number(official.price_tenths) / 10,
    form: number(official.form), ownership: number(official.ownership_percent), minutes: number(official.minutes), fixture: `${fixture.opponent.shortName} (${fixture.isHome ? 'H' : 'A'})`, difficulty: fixture.difficulty || 3, projection: number(official.ep_next), colour: getTeamColor(player.team.shortName), status: String(official.status || 'a'), chanceOfPlaying: nullableNumber(official.chance_of_playing) ?? 100, active: Boolean(official.active), roleProfile: role, stats,
    upcomingFixtures: [{ gameweek: fixture.gameweekFplId || 0, opponent: fixture.opponent.shortName, venue: fixture.isHome ? 'H' : 'A', difficulty: fixture.difficulty || 3 }], dataConfidence: role.confidence,
    setPieceRole: setPieceRole(player.roleSignals), historicalPrior: player.historicalPrior || undefined,
  }
  const strength = catalogFixtureStrength(player, fixture, catalog, context?.completedGameweeks)
  const marketCleanSheetProbability = fixture.market
    ? (fixture.isHome ? fixture.market.homeCleanSheetProbability : fixture.market.awayCleanSheetProbability) ?? undefined
    : undefined
  const attackingRateOverride = marketAttackingRateOverride(player, fixture, catalog, context?.completedGameweeks)
  const fixtureInput = { gameweek: fixture.gameweekFplId || 0, opponent: fixture.opponent.shortName, venue: fixture.isHome ? 'H' as const : 'A' as const, difficulty: fixture.difficulty || 3, marketCleanSheetProbability, strength, attackingRateOverride }
  const breakdown = projectionBreakdown({ ...modelPlayer, upcomingFixtures: [fixtureInput] }, 1)
  const components = projectFixture(modelPlayer, fixtureInput)
  const states = fixtureRoleStates(role)
  const rates = fixtureRateModel(modelPlayer, fixtureInput)
  const simulationInput: FixtureSimulationInput = {
    engineVersion: SIMULATION_ENGINE_VERSION,
    seed: `${context?.forecastRunId || 'preview'}:${player.id}:${fixture.id}:${context?.modelVersion || MODEL_VERSION}:${SIMULATION_SEED_VERSION}`,
    position, role: {
      ...states,
      minutesIfStarting: role.minutesIfStarting,
      minutesIfSubstitute: role.minutesIfSubstitute,
      startingMinutesSpread: position === 'GK' ? 0 : 8,
      substituteMinutesSpread: position === 'GK' ? 0 : 6,
    },
    goalRate: rates.goalRate, assistRate: rates.assistRate, teamGoalsConcededRate: rates.xgcRate, saveRate: rates.saveRate,
    yellowCardRate: rates.cardRate, redCardRate: number(official.red_cards) * 90 / Math.max(1, number(official.minutes)),
    penaltySaveRate: rates.penaltySaveRate, penaltyMissRate: rates.penaltyMissRate, ownGoalRate: rates.ownGoalRate,
    defensiveActionRate: rates.defensiveRate, bonusRate: rates.bonusRate,
    samples: SIMULATION_COUNT,
  }
  const outcome = simulateFixtureOutcomes(simulationInput)
  const mean = outcome.mean
  return {
    playerId: player.id, fixtureId: fixture.id, expectedMinutes: outcome.minuteSamples?.reduce((sum, value) => sum + value, 0)! / outcome.samples.length,
    appearancePoints: components.appearance, goalPoints: components.goals, assistPoints: components.assists,
    cleanSheetPoints: components.cleanSheet, goalsConcededPoints: components.goalsConceded,
    savePoints: components.saves, penaltyPoints: components.penalties, defensiveContributionPoints: components.defensiveContribution,
    bonusPoints: components.bonus, cardPoints: components.cards, meanPoints: mean,
    standardDeviation: outcome.standardDeviation, p10Points: outcome.p10, p50Points: outcome.p50, p90Points: outcome.p90,
    ...states, minutesConfidence: breakdown.minutesConfidence, strengthMethod: components.strengthMethod,
    roleSource: {
      derivedSignalIds: role.derivedFromSignalIds,
      roleCalibration: role.calibration,
      marketAllocation: attackingRateOverride && { teamExpectedGoals: strength?.marketTeamExpectedGoals, assistsPerGoal: MARKET_ASSISTS_PER_GOAL, ...attackingRateOverride },
      sampleCalibration: projectionSampleCalibration(modelPlayer, context?.completedGameweeks),
      simulationInput,
    }, inputProvenance: player.provenance,
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
  return { gameweekId: first.gameweekId, gameweekFplId: first.gameweekFplId || 1, deadlineAt, allowed }
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
    const completedGameweeks = Math.max(0, target.gameweekFplId - 1)
    const rows = catalog.players.flatMap(player => player.fixtures.filter(fixture => target.allowed.has(fixture.gameweekId || '') && fixture.kickoffAt && Date.parse(fixture.kickoffAt) >= Date.parse(asOf)).map(fixture => project(player, fixture, catalog, { forecastRunId: id, modelVersion, completedGameweeks })))
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
  const rows = (await db.query(`SELECT forecast.*, player."fpl_id", gameweek."fpl_id" AS "gameweek_fpl_id", player_obs."position", player_obs."active"
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
    const current = players.get(id) || { playerId: id, fixtureCount: 0, meanPoints: 0, variance: 0, streams: [], minuteStreams: [], samplesAvailable: true, expectedGoals: 0, expectedAssists: 0, noGoalProbability: 1, noAssistProbability: 1, noCleanSheetProbability: 1, noBonusProbability: 1, noDefensiveContributionProbability: 1 }
    const sim = simulateFromStoredForecast(row)
    current.fixtureCount += 1
    current.meanPoints += Number(row.mean_points)
    current.variance += Number(row.standard_deviation) ** 2
    if (sim) {
      current.streams.push(sim.samples)
      if (sim.minuteSamples) current.minuteStreams.push(sim.minuteSamples)
      current.expectedGoals += sim.expectedGoals
      current.expectedAssists += sim.expectedAssists
      current.noGoalProbability *= 1 - sim.goalProbability
      current.noAssistProbability *= 1 - sim.assistProbability
      current.noCleanSheetProbability *= 1 - sim.cleanSheetProbability
      current.noBonusProbability *= 1 - sim.bonusProbability
      current.noDefensiveContributionProbability *= 1 - sim.defensiveContributionProbability
    } else {
      current.samplesAvailable = false
    }
    players.set(id, current)
  }
  // Coverage should describe decision-relevant players, not hundreds of
  // inactive or sub-30-minute catalogue entries that cannot realistically be
  // selected by the optimizer.
  const qualityRows = selected.filter(row => Boolean(row.active) && Number(row.expected_minutes) >= 30)
  const fixtureCount = qualityRows.length
  const firstGameweek = gameweeks[0]
  const nearTermRows = qualityRows.filter(row => Number(row.gameweek_fpl_id) === firstGameweek)
  const nearTermFixtureCount = nearTermRows.length
  const playerIds = new Set(qualityRows.map(row => Number(row.fpl_id)))
  const underlyingPlayerIds = new Set(qualityRows.filter(row => {
    try { return Boolean(JSON.parse(String(row.input_provenance_json || '{}')).underlyingObservationId) } catch { return false }
  }).map(row => Number(row.fpl_id)))
  const quality = {
    fallbackFixtureRatio: fixtureCount ? qualityRows.filter(row => row.strength_method === 'FDR_FALLBACK').length / fixtureCount : 1,
    lowMinutesFixtureRatio: fixtureCount ? qualityRows.filter(row => row.minutes_confidence === 'LOW').length / fixtureCount : 1,
    underlyingPlayerRatio: playerIds.size ? underlyingPlayerIds.size / playerIds.size : 0,
    marketFixtureRatio: fixtureCount ? qualityRows.filter(row => row.strength_method === 'MARKET_XG').length / fixtureCount : 0,
    nearTermFallbackFixtureRatio: nearTermFixtureCount ? nearTermRows.filter(row => row.strength_method === 'FDR_FALLBACK').length / nearTermFixtureCount : 1,
    nearTermMarketFixtureRatio: nearTermFixtureCount ? nearTermRows.filter(row => row.strength_method === 'MARKET_XG').length / nearTermFixtureCount : 0,
    derivedStrengthFixtureRatio: fixtureCount ? qualityRows.filter(row => row.strength_method === 'DERIVED_TEAM_RATING').length / fixtureCount : 0,
  }
  let recompute: unknown = null
  try { recompute = JSON.parse(String(run.config_json || '{}')).recompute || null } catch {}
  return { id: run.id, modelVersion: run.model_version, asOf: run.as_of, createdAt: run.created_at, inputHash: run.input_hash, recompute, horizon: Number(horizon), gameweeks, quality, players: [...players.values()].map(player => {
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
      expectedGoals: player.expectedGoals,
      expectedAssists: player.expectedAssists,
      goalProbability: 1 - player.noGoalProbability,
      assistProbability: 1 - player.noAssistProbability,
      cleanSheetProbability: 1 - player.noCleanSheetProbability,
      bonusProbability: 1 - player.noBonusProbability,
      defensiveContributionProbability: 1 - player.noDefensiveContributionProbability,
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
