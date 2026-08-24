import { createHash } from 'node:crypto'
import { canonicalJson } from '../../scripts/feed-run.mjs'
import type { ProjectionCatalogFixture, ProjectionCatalogPlayer, ProjectionInputCatalog, SourceFreshness } from '../core/types.ts'
import { MODEL_VERSION } from '../core/projection.ts'

type Database = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

const terminalFeedStatuses = "('SUCCEEDED', 'PARTIAL')"
const iso = (value: unknown) => value == null ? null : String(value)
const number = (value: unknown) => value == null ? null : Number(value)
const json = (value: unknown) => { try { return JSON.parse(String(value || '{}')) } catch { return {} } }
const unique = (values: string[]) => [...new Set(values)].sort()
const roleValueKeys = ['startProbability', 'minutesIfStarting', 'substituteProbabilityWhenBenched', 'minutesIfSubstitute', 'depthRole']
const contextOnlyClaimClasses = new Set(['FPL_SELECTION', 'CREATOR_RATING', 'VALUE_OPINION', 'STATISTICAL_CONTEXT', 'PERFORMANCE_FORECAST', 'UNKNOWN'])
const hasRoleValue = (value: unknown) => {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return roleValueKeys.some(key => record[key] !== null && record[key] !== undefined)
}
const stripRoleValue = (value: unknown, keepSetPieceRole: boolean) => {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}
  for (const key of roleValueKeys) delete record[key]
  if (!keepSetPieceRole) delete record.setPieceRole
  return record
}

function effectiveSignalProjectionValue(signal: any) {
  const hasInterpretation = signal.interpretation_id != null
  const rawValue = json(signal.value_json)
  if (!hasInterpretation) {
    // Every migrated signal should have an interpretation. Treat an orphaned
    // raw value as context-only rather than allowing it to alter projections.
    return { value: stripRoleValue(rawValue, false), modelImpact: 'NONE', interpretationStatus: null, interpretationConfidence: null, claimClass: signal.claim_class || 'UNKNOWN' }
  }
  const value = json(signal.interpretation_value_json)
  const claimClass = signal.interpretation_claim_class || signal.claim_class || 'UNKNOWN'
  const modelImpact = signal.interpretation_model_impact || (hasRoleValue(value) ? 'ROLE' : 'NONE')
  const approved = signal.interpretation_status === 'APPROVED'
  const roleApproved = approved && modelImpact === 'ROLE' && !contextOnlyClaimClasses.has(claimClass)
  const keepSetPieceRole = approved && modelImpact === 'NONE' && ['SET_PIECES', 'PENALTIES'].includes(claimClass)
  return {
    value: roleApproved ? value : stripRoleValue(value, keepSetPieceRole),
    modelImpact: roleApproved ? modelImpact : 'NONE',
    interpretationStatus: signal.interpretation_status || null,
    interpretationConfidence: signal.interpretation_confidence == null ? null : Number(signal.interpretation_confidence),
    claimClass,
  }
}

function parseAsOf(asOf: string | Date | undefined) {
  const value = asOf instanceof Date ? asOf.toISOString() : asOf || new Date().toISOString()
  if (Number.isNaN(Date.parse(value))) throw new Error('asOf must be an ISO-8601 timestamp')
  return new Date(value).toISOString()
}

function sourceFreshness(source: SourceFreshness['source'], observedAt: string | null, feedRunIds: string[], asOf: string, maxAgeMs: number): SourceFreshness {
  const age = observedAt == null ? Infinity : Date.parse(asOf) - Date.parse(observedAt)
  return { source, observedAt, feedRunIds: unique(feedRunIds), status: !observedAt ? 'MISSING' : age > maxAgeMs ? 'STALE' : 'FRESH' }
}

async function latestRows(db: Database, table: string, parentColumn: string, ids: string[], asOf: string, predicate = '') {
  if (!ids.length) return []
  const marks = ids.map((_, index) => `$${index + 1}`).join(',')
  const params: unknown[] = [...ids, asOf]
  const rows = (await db.query(
    `SELECT value.* FROM "${table}" value
     JOIN "FeedRun" run ON run."id"=value."feed_run_id"
     WHERE value."${parentColumn}" IN (${marks}) AND datetime(value."observed_at") <= datetime($${ids.length + 1})
       AND run."status" IN ${terminalFeedStatuses} ${predicate}
       AND value."observed_at"=(SELECT MAX(candidate."observed_at") FROM "${table}" candidate
          JOIN "FeedRun" candidate_run ON candidate_run."id"=candidate."feed_run_id"
          WHERE candidate."${parentColumn}"=value."${parentColumn}" AND datetime(candidate."observed_at") <= datetime($${ids.length + 1})
            AND candidate_run."status" IN ${terminalFeedStatuses})
     ORDER BY value."${parentColumn}", value."id" DESC`, params,
  )).rows
  const seen = new Set<string>()
  return rows.filter(row => {
    const key = String(row[parentColumn])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Assemble immutable, source-labelled model inputs as they were known at asOf. */
export async function assembleProjectionInputCatalog(db: Database, options: {
  asOf?: string | Date
  season?: string
  officialMaxAgeMs?: number
  underlyingMaxAgeMs?: number
  marketMaxAgeMs?: number
  signalsMaxAgeMs?: number
} = {}): Promise<ProjectionInputCatalog> {
  const asOf = parseAsOf(options.asOf)
  const seasonResult = options.season
    ? { rows: [{ season: options.season }] }
    : await db.query(
      `SELECT player."season"
       FROM "Player" player
       JOIN "PlayerObservation" observation ON observation."player_id"=player."id"
       JOIN "FeedRun" run ON run."id"=observation."feed_run_id"
       WHERE datetime(observation."observed_at") <= datetime($1) AND run."status" IN ${terminalFeedStatuses}
       GROUP BY player."season"
       ORDER BY MAX(datetime(observation."observed_at")) DESC, player."season" DESC
       LIMIT 1`,
      [asOf],
    )
  const season = seasonResult.rows[0]?.season
  if (!season) throw new Error(`No player catalogue exists at ${asOf}`)
  const players = (await db.query('SELECT * FROM "Player" WHERE "season"=$1 ORDER BY "fpl_id" ASC', [season])).rows
  const playerIds = players.map(row => String(row.id))
  const officialRows = await latestRows(db, 'PlayerObservation', 'player_id', playerIds, asOf)
  const officialByPlayer = new Map(officialRows.map(row => [row.player_id, row]))
  const includedPlayers = players.filter(player => officialByPlayer.has(player.id))
  const teams = (await db.query('SELECT * FROM "Team" WHERE "season"=$1 ORDER BY "fpl_id" ASC', [season])).rows
  const teamById = new Map(teams.map(row => [row.id, row]))
  const teamRows = await latestRows(db, 'TeamObservation', 'team_id', teams.map(row => row.id), asOf)
  const strengthByTeam = new Map(teamRows.map(row => [row.team_id, row]))

  const fixtureRows = (await db.query(
    `SELECT fixture.*, observation.*, gameweek."fpl_id" AS gameweek_fpl_id
     FROM "Fixture" fixture
     JOIN "FixtureObservation" observation ON observation."fixture_id"=fixture."id"
     JOIN "FeedRun" run ON run."id"=observation."feed_run_id"
     LEFT JOIN "Gameweek" gameweek ON gameweek."id"=observation."gameweek_id"
     WHERE fixture."season"=$1 AND datetime(observation."observed_at") <= datetime($2) AND run."status" IN ${terminalFeedStatuses}
       AND observation."observed_at"=(SELECT MAX(candidate."observed_at") FROM "FixtureObservation" candidate
         JOIN "FeedRun" candidate_run ON candidate_run."id"=candidate."feed_run_id"
         WHERE candidate."fixture_id"=fixture."id" AND datetime(candidate."observed_at") <= datetime($2) AND candidate_run."status" IN ${terminalFeedStatuses})
     ORDER BY fixture."fpl_id", observation."id" DESC`, [season, asOf],
  )).rows
  const fixtureByTeam = new Map<string, any[]>()
  for (const row of fixtureRows) for (const teamId of [row.home_team_id, row.away_team_id]) fixtureByTeam.set(teamId, [...(fixtureByTeam.get(teamId) || []), row])

  const underlyingMaxAgeMs = options.underlyingMaxAgeMs ?? Number(process.env.FPL_UNDERLYING_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000)
  const underlyingRows = (await db.query(
    `SELECT observation.* FROM "UnderlyingObservation" observation JOIN "FeedRun" run ON run."id"=observation."feed_run_id"
     WHERE observation."season"=$1 AND observation."match_status"='MATCHED' AND observation."player_id" IS NOT NULL
       AND datetime(observation."observed_at") <= datetime($2) AND run."status" IN ${terminalFeedStatuses}
       AND datetime(observation."observed_at") >= datetime($3)
     ORDER BY observation."player_id", observation."observed_at" DESC, observation."id" DESC`,
    [season, asOf, new Date(Date.parse(asOf) - underlyingMaxAgeMs).toISOString()],
  )).rows
  const underlyingByPlayer = new Map<string, any>()
  for (const row of underlyingRows) if (!underlyingByPlayer.has(row.player_id)) underlyingByPlayer.set(row.player_id, row)

  const marketMaxAgeMs = options.marketMaxAgeMs ?? Number(process.env.FPL_MARKET_MAX_AGE_MS || 48 * 60 * 60 * 1000)
  const markets = (await db.query(
    `SELECT observation.* FROM "MarketFixtureObservation" observation JOIN "FeedRun" run ON run."id"=observation."feed_run_id"
     WHERE observation."fixture_id" IS NOT NULL AND datetime(observation."captured_at") <= datetime($1) AND datetime(observation."captured_at") >= datetime($2)
       AND observation."home_expected_goals" IS NOT NULL AND observation."away_expected_goals" IS NOT NULL AND observation."derivation_method" IS NOT NULL
       AND run."status" IN ${terminalFeedStatuses}
     ORDER BY observation."fixture_id", observation."captured_at" DESC, observation."id" DESC`,
    [asOf, new Date(Date.parse(asOf) - marketMaxAgeMs).toISOString()],
  )).rows
  const marketByFixture = new Map<string, any>()
  for (const row of markets) if (!marketByFixture.has(row.fixture_id)) marketByFixture.set(row.fixture_id, row)

  const signals = (await db.query(
    `SELECT signal.*, interpretation."id" AS "interpretation_id", interpretation."origin" AS "interpretation_origin",
        interpretation."claim_class" AS "interpretation_claim_class", interpretation."model_impact" AS "interpretation_model_impact",
        interpretation."value_json" AS "interpretation_value_json", interpretation."confidence" AS "interpretation_confidence",
        interpretation."status" AS "interpretation_status"
       FROM "PlayerSignal" signal
       LEFT JOIN "PlayerSignalInterpretation" interpretation ON interpretation."id"=(
         SELECT candidate."id" FROM "PlayerSignalInterpretation" candidate
         WHERE candidate."signal_id"=signal."id" ORDER BY candidate.rowid DESC LIMIT 1
       )
       WHERE datetime(signal."observed_at") <= datetime($1) AND datetime(signal."valid_until") > datetime($1) AND signal."status"='VERIFIED'
         AND (signal."gameweek_id" IS NULL OR signal."gameweek_id" IN (SELECT "id" FROM "Gameweek" WHERE "season"=$2))
       ORDER BY signal."player_id", signal."kind", CASE WHEN signal."source_type" IN ('MANUAL_OVERRIDE', 'MANUAL', 'USER') THEN 0 ELSE 1 END, signal."observed_at" DESC, signal."id" DESC`, [asOf, season],
  )).rows
  const signalsByPlayer = new Map<string, any[]>()
  for (const signal of signals) signalsByPlayer.set(signal.player_id, [...(signalsByPlayer.get(signal.player_id) || []), signal])

  const playersOut: ProjectionCatalogPlayer[] = includedPlayers.map(player => {
    const official = officialByPlayer.get(player.id)
    const officialPayload = json(official.raw_payload_json)
    const team = teamById.get(official.team_id)
    const strength = strengthByTeam.get(official.team_id)
    const playerSignals = signalsByPlayer.get(player.id) || []
    const manualSignals = playerSignals.filter(signal => ['MANUAL_OVERRIDE', 'MANUAL', 'USER'].includes(signal.source_type))
    const roleSignals = playerSignals.filter(signal => !manualSignals.some(manual => manual.kind === signal.kind) || ['MANUAL_OVERRIDE', 'MANUAL', 'USER'].includes(signal.source_type))
    const fixtures: ProjectionCatalogFixture[] = (fixtureByTeam.get(official.team_id) || []).map(fixture => {
      const home = fixture.home_team_id === official.team_id
      const opponent = teamById.get(home ? fixture.away_team_id : fixture.home_team_id)
      const opponentStrength = strengthByTeam.get(opponent.id)
      const market = marketByFixture.get(fixture.fixture_id)
      return {
        id: fixture.fixture_id, fplId: Number(fixture.fpl_id), gameweekId: fixture.gameweek_id, gameweekFplId: number(fixture.gameweek_fpl_id), kickoffAt: iso(fixture.kickoff_at), isHome: home,
        difficulty: number(home ? fixture.difficulty_home : fixture.difficulty_away),
        opponent: { id: opponent.id, fplId: Number(opponent.fpl_id), name: opponent.name, shortName: opponent.short_name, teamStrength: opponentStrength ? { strengthAttackHome: number(opponentStrength.strength_attack_home), strengthAttackAway: number(opponentStrength.strength_attack_away), strengthDefenceHome: number(opponentStrength.strength_defence_home), strengthDefenceAway: number(opponentStrength.strength_defence_away) } : { strengthAttackHome: null, strengthAttackAway: null, strengthDefenceHome: null, strengthDefenceAway: null } },
        market: market ? {
          id: market.id,
          homeExpectedGoals: Number(market.home_expected_goals),
          awayExpectedGoals: Number(market.away_expected_goals),
          homeCleanSheetProbability: market.home_clean_sheet_probability == null ? null : Number(market.home_clean_sheet_probability),
          awayCleanSheetProbability: market.away_clean_sheet_probability == null ? null : Number(market.away_clean_sheet_probability),
          derivationMethod: String(market.derivation_method),
          capturedAt: String(market.captured_at),
          ageMs: Math.max(0, Date.parse(asOf) - Date.parse(String(market.captured_at))),
        } : null,
      }
    })
    const underlying = underlyingByPlayer.get(player.id) || null
    return {
      id: player.id, fplId: Number(player.fpl_id), name: player.web_name,
      identityNames: [...new Set([player.web_name, player.first_name, player.second_name, `${player.first_name || ''} ${player.second_name || ''}`].map(value => String(value || '').trim()).filter(Boolean))],
      team: { id: team.id, fplId: Number(team.fpl_id), name: team.name, shortName: team.short_name },
      // Event transfer activity affects recommendation timing even though it
      // does not alter expected points. Keep it in the immutable decision
      // input snapshot so a newly affordable/urgent route cannot reuse a
      // recommendation cached against stale activity counts.
      official: {
        ...official,
        transfers_in_event: number(officialPayload.transfers_in_event),
        transfers_out_event: number(officialPayload.transfers_out_event),
        raw_payload_json: undefined,
      },
      teamStrength: strength ? { strengthAttackHome: number(strength.strength_attack_home), strengthAttackAway: number(strength.strength_attack_away), strengthDefenceHome: number(strength.strength_defence_home), strengthDefenceAway: number(strength.strength_defence_away) } : { strengthAttackHome: null, strengthAttackAway: null, strengthDefenceHome: null, strengthDefenceAway: null },
      fixtures, underlying: underlying && { ...underlying, raw_payload_json: undefined },
      roleSignals: roleSignals.map(signal => {
        const interpretation = effectiveSignalProjectionValue(signal)
        const sourceConfidence = Number(signal.confidence)
        const interpretationConfidence = Number(interpretation.interpretationConfidence)
        const confidence = interpretation.modelImpact === 'ROLE' && Number.isFinite(interpretationConfidence) ? Math.min(sourceConfidence, interpretationConfidence) : sourceConfidence
        return {
          id: signal.id, kind: signal.kind, value: interpretation.value, sourceType: signal.source_type, sourceUrl: signal.source_url,
          sourceDate: signal.source_date || null, evidenceSummary: signal.evidence_summary, evidenceText: signal.evidence_text || signal.evidence_summary, confidence, gameweekId: signal.gameweek_id,
          observedAt: signal.observed_at, validUntil: signal.valid_until, modelImpact: interpretation.modelImpact,
          interpretationStatus: interpretation.interpretationStatus, interpretationConfidence: interpretation.interpretationConfidence,
          claimClass: interpretation.claimClass, manualOverride: ['MANUAL_OVERRIDE', 'MANUAL', 'USER'].includes(signal.source_type),
        }
      }),
      provenance: { officialObservationId: official.id, underlyingObservationId: underlying?.id || null, eligibleSignalIds: playerSignals.map(signal => signal.id), manualOverrideSignalIds: manualSignals.map(signal => signal.id), excluded: { underlying: [], signals: [] } },
    }
  })
  const gameweekRows = (await db.query(
    `SELECT gameweek."id" AS gameweek_id, gameweek."fpl_id" AS gameweek_fpl_id, observation."deadline_at", observation."is_current", observation."is_next", observation."finished"
     FROM "Gameweek" gameweek
     JOIN "GameweekObservation" observation ON observation."gameweek_id"=gameweek."id"
     JOIN "FeedRun" run ON run."id"=observation."feed_run_id"
     WHERE gameweek."season"=$1 AND datetime(observation."observed_at") <= datetime($2) AND run."status" IN ${terminalFeedStatuses}
       AND observation."observed_at"=(
         SELECT MAX(candidate."observed_at")
         FROM "GameweekObservation" candidate
         JOIN "FeedRun" candidate_run ON candidate_run."id"=candidate."feed_run_id"
         WHERE candidate."gameweek_id"=gameweek."id"
           AND datetime(candidate."observed_at") <= datetime($2)
           AND candidate_run."status" IN ${terminalFeedStatuses}
       )
     ORDER BY gameweek."fpl_id" ASC`,
    [season, asOf],
  )).rows
  const gameweeks = gameweekRows.map(row => ({
    id: String(row.gameweek_id),
    gameweek: Number(row.gameweek_fpl_id),
    deadline: row.deadline_at ? String(row.deadline_at) : null,
    isCurrent: Boolean(row.is_current),
    isNext: Boolean(row.is_next),
    finished: Boolean(row.finished),
  }))

  const sourceRunIds = {
    official: unique([...officialRows, ...teamRows, ...fixtureRows].map(row => row.feed_run_id)),
    underlying: unique([...underlyingByPlayer.values()].map(row => row.feed_run_id)),
    market: unique([...marketByFixture.values()].map(row => row.feed_run_id)),
  }
  const latest = (values: Array<string | null | undefined>) => values.filter(Boolean).sort().at(-1) || null
  const freshness = {
    official: sourceFreshness('OFFICIAL_FPL', latest([...officialRows, ...teamRows, ...fixtureRows].map(row => row.observed_at)), sourceRunIds.official, asOf, options.officialMaxAgeMs ?? Number(process.env.FPL_OFFICIAL_MAX_AGE_MS || 24 * 60 * 60 * 1000)),
    underlying: sourceFreshness('UNDERLYING', latest([...underlyingByPlayer.values()].map(row => row.observed_at)), sourceRunIds.underlying, asOf, underlyingMaxAgeMs),
    market: sourceFreshness('MARKET', latest([...marketByFixture.values()].map(row => row.captured_at)), sourceRunIds.market, asOf, marketMaxAgeMs),
    signals: sourceFreshness('SIGNALS', latest(signals.map(row => row.observed_at)), [], asOf, options.signalsMaxAgeMs ?? Number(process.env.FPL_SIGNALS_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000)),
  }
  const canonical = { asOf, season, gameweeks, players: playersOut, sourceRunIds, freshness }
  // `asOf`, feed-run identifiers, observation identifiers and market ages are
  // audit data, not model inputs. Including them made a no-op refresh look
  // different merely because the clock had moved or an upstream feed had been
  // polled again. Keep the public catalogue fully auditable, but hash only the
  // values which can affect a projection or its transfer-timing decision.
  const inputState = {
    season,
    players: playersOut.map(player => ({
      fplId: player.fplId,
      team: player.team,
      official: projectionValue(player.official),
      teamStrength: player.teamStrength,
      fixtures: player.fixtures.map(fixture => ({
        fplId: fixture.fplId,
        gameweekFplId: fixture.gameweekFplId,
        kickoffAt: fixture.kickoffAt,
        isHome: fixture.isHome,
        difficulty: fixture.difficulty,
        opponent: fixture.opponent,
        market: fixture.market && {
          homeExpectedGoals: fixture.market.homeExpectedGoals,
          awayExpectedGoals: fixture.market.awayExpectedGoals,
          homeCleanSheetProbability: fixture.market.homeCleanSheetProbability,
          awayCleanSheetProbability: fixture.market.awayCleanSheetProbability,
          derivationMethod: fixture.market.derivationMethod,
        },
      })),
      underlying: player.underlying ? projectionValue(player.underlying) : null,
      roleSignals: player.roleSignals.map(signal => ({
        kind: signal.kind,
        value: signal.value,
        sourceType: signal.sourceType,
        sourceDate: signal.sourceDate,
        evidenceSummary: signal.evidenceSummary,
        evidenceText: signal.evidenceText,
        confidence: signal.confidence,
        gameweekId: signal.gameweekId,
        validUntil: signal.validUntil,
        modelImpact: signal.modelImpact,
        interpretationStatus: signal.interpretationStatus,
        interpretationConfidence: signal.interpretationConfidence,
        claimClass: signal.claimClass,
        manualOverride: signal.manualOverride,
      })),
    })),
  }
  return { ...canonical, inputHash: createHash('sha256').update(canonicalJson(inputState)).digest('hex') }
}

/** Remove persistence/audit-only fields from an observation before hashing it. */
function projectionValue(value: Record<string, unknown>) {
  const excluded = new Set(['id', 'feed_run_id', 'observed_at', 'captured_at', 'created_at', 'updated_at', 'raw_payload_json'])
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)))
}

/**
 * The revision inputs used by the server cache key. These deliberately track
 * data identity rather than response time, so a fresh feed/signal/calibration
 * invalidates cached catalogue output without changing source timestamps.
 */
export async function projectionCatalogInputVersions(db: Database, season?: string) {
  const [feedRuns, signals, calibration] = await Promise.all([
    db.query(`SELECT "source", "id" FROM "FeedRun" WHERE "status" IN ${terminalFeedStatuses} ORDER BY "source", "id"`),
    db.query(`SELECT "id", "updated_at" FROM "PlayerSignal" ORDER BY "id"`),
    db.query(`SELECT "id", "model_version", "trained_at" FROM "CalibrationSet" ORDER BY "id"`).catch(() => ({ rows: [] })),
  ])
  return {
    season: season || null,
    feedRuns: feedRuns.rows.map(row => [row.source, row.id]),
    signals: signals.rows.map(row => [row.id, row.updated_at]),
    modelVersion: MODEL_VERSION,
    calibration: calibration.rows.map(row => [row.id, row.model_version, row.trained_at]),
  }
}
