import { randomUUID } from 'node:crypto'

const DECISIONS = new Set(['ACCEPTED', 'REJECTED', 'IGNORED', 'CUSTOM'])
const parse = value => { try { return JSON.parse(value || '{}') } catch { return {} } }
const number = value => value == null ? null : Number(value)

async function recommendation(db, id) {
  const result = await db.query('SELECT * FROM "RecommendationSet" WHERE "id"=$1', [id])
  if (!result.rows[0]) throw new Error(`Recommendation set ${id} does not exist`)
  return result.rows[0]
}

async function candidate(db, recommendationSetId, id) {
  if (!id) return null
  const result = await db.query('SELECT * FROM "RecommendationCandidate" WHERE "id"=$1 AND "recommendation_set_id"=$2', [id, recommendationSetId])
  if (!result.rows[0]) throw new Error(`Candidate ${id} does not belong to recommendation set ${recommendationSetId}`)
  return result.rows[0]
}

async function plan(db, id, managerAccountId) {
  if (!id) return null
  const result = await db.query('SELECT * FROM "Plan" WHERE "id"=$1 AND "manager_account_id"=$2', [id, managerAccountId])
  if (!result.rows[0]) throw new Error(`Plan ${id} does not belong to this recommendation's manager`)
  return result.rows[0]
}

/** Record the user's action without ever changing the recommendation or either plan. */
export async function recordDecision(db, { recommendationSetId, candidateId = null, decision, selectedPlanId = null, reason = null, createdAt = new Date().toISOString() }) {
  if (!DECISIONS.has(decision)) throw new Error('decision must be ACCEPTED, REJECTED, IGNORED, or CUSTOM')
  const set = await recommendation(db, recommendationSetId)
  const baselineResult = await db.query('SELECT * FROM "Plan" WHERE "id"=$1', [set.plan_id])
  const baseline = baselineResult.rows[0]
  if (!baseline) throw new Error(`Baseline plan ${set.plan_id} does not exist`)
  const selected = await plan(db, selectedPlanId, baseline.manager_account_id)
  await candidate(db, set.id, candidateId)
  if ((decision === 'ACCEPTED' || decision === 'CUSTOM') && !selected) throw new Error(`${decision} decisions require selectedPlanId`)
  if (decision === 'ACCEPTED' && !candidateId) throw new Error('ACCEPTED decisions require candidateId')
  const id = randomUUID()
  await db.query(
    `INSERT INTO "DecisionRecord" ("id","recommendation_set_id","candidate_id","decision","selected_plan_id","reason","created_at","evaluated_at","realized_points_delta","outcome_json")
     VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL)`,
    [id, set.id, candidateId, decision, selected?.id ?? null, reason == null ? null : String(reason).slice(0, 2000), createdAt],
  )
  return getDecision(db, id)
}

async function planActual(db, { planId, forecastRunId }) {
  const fixtures = await db.query(
    `SELECT forecast."player_id", forecast."fixture_id", forecast."mean_points"
     FROM "PlayerFixtureForecast" forecast
     JOIN "PlanPlayer" player ON player."plan_id"=$1 AND player."player_id"=forecast."player_id"
     WHERE forecast."forecast_run_id"=$2`, [planId, forecastRunId])
  if (!fixtures.rows.length) return { pending: true, expectedPoints: 0, realizedPoints: null, missingResults: 0 }
  let expectedPoints = 0, realizedPoints = 0, missingResults = 0
  for (const fixture of fixtures.rows) {
    const slot = await db.query('SELECT "squad_slot", "is_captain" FROM "PlanPlayer" WHERE "plan_id"=$1 AND "player_id"=$2', [planId, fixture.player_id])
    const selection = slot.rows[0]
    // The saved XI/captain is the counterfactual. Bench players are intentionally excluded.
    if (!selection || Number(selection.squad_slot) > 11) continue
    const multiplier = Boolean(selection.is_captain) ? 2 : 1
    expectedPoints += Number(fixture.mean_points) * multiplier
    const result = await db.query('SELECT "total_points" FROM "PlayerFixtureResult" WHERE "player_id"=$1 AND "fixture_id"=$2', [fixture.player_id, fixture.fixture_id])
    if (!result.rows[0]) { missingResults += 1; continue }
    realizedPoints += Number(result.rows[0].total_points) * multiplier
  }
  return { pending: missingResults > 0, expectedPoints, realizedPoints: missingResults ? null : realizedPoints, missingResults }
}

export async function evaluateDecision(db, decisionId, evaluatedAt = new Date().toISOString()) {
  const decision = await getDecision(db, decisionId)
  if (!decision) throw new Error(`Decision ${decisionId} does not exist`)
  const baseline = await planActual(db, { planId: decision.baselinePlanId, forecastRunId: decision.forecastRunId })
  const chosen = decision.selectedPlanId
    ? await planActual(db, { planId: decision.selectedPlanId, forecastRunId: decision.forecastRunId })
    : baseline
  const pending = baseline.pending || chosen.pending
  const outcome = {
    status: pending ? 'PENDING' : 'REALIZED',
    baselinePlanId: decision.baselinePlanId,
    chosenPlanId: decision.selectedPlanId,
    baselineExpectedPoints: baseline.expectedPoints,
    chosenExpectedPoints: chosen.expectedPoints,
    baselineRealizedPoints: baseline.realizedPoints,
    chosenRealizedPoints: chosen.realizedPoints,
    // Forecast error and the saved-plan difference are separate measurements.
    modelForecastError: baseline.realizedPoints == null ? null : baseline.realizedPoints - baseline.expectedPoints,
    managerDecisionResult: pending ? null : chosen.realizedPoints - baseline.realizedPoints,
    missingResults: baseline.missingResults + chosen.missingResults,
    wording: 'Recorded counterfactual comparison; it does not prove that the decision caused the outcome.',
  }
  await db.query(
    `UPDATE "DecisionRecord" SET "evaluated_at"=$2, "realized_points_delta"=$3, "outcome_json"=$4 WHERE "id"=$1`,
    [decisionId, pending ? null : evaluatedAt, outcome.managerDecisionResult, JSON.stringify(outcome)],
  )
  return getDecision(db, decisionId)
}

export async function getDecision(db, id) {
  const result = await db.query(
    `SELECT decision.*, recommendation."plan_id" AS "baseline_plan_id", recommendation."forecast_run_id", recommendation."horizon", recommendation."created_at" AS "recommendation_created_at",
            candidate."expected_team_points" AS "candidate_expected_points", candidate."net_expected_gain" AS "candidate_expected_gain"
     FROM "DecisionRecord" decision
     JOIN "RecommendationSet" recommendation ON recommendation."id"=decision."recommendation_set_id"
     LEFT JOIN "RecommendationCandidate" candidate ON candidate."id"=decision."candidate_id"
     WHERE decision."id"=$1`, [id])
  const row = result.rows[0]; if (!row) return null
  return { id: row.id, recommendationSetId: row.recommendation_set_id, candidateId: row.candidate_id, decision: row.decision, baselinePlanId: row.baseline_plan_id, selectedPlanId: row.selected_plan_id, forecastRunId: row.forecast_run_id, horizon: Number(row.horizon), reason: row.reason, createdAt: row.created_at, evaluatedAt: row.evaluated_at, realizedPointsDelta: number(row.realized_points_delta), expectedCandidatePoints: number(row.candidate_expected_points), expectedCandidateGain: number(row.candidate_expected_gain), outcome: row.outcome_json ? parse(row.outcome_json) : { status: 'PENDING', wording: 'Outcome is pending completed results; this is not a causal claim.' } }
}

export async function listDecisions(db, { limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer between 1 and 200')
  const rows = await db.query('SELECT "id" FROM "DecisionRecord" ORDER BY "created_at" DESC, "id" DESC LIMIT $1', [limit])
  return Promise.all(rows.rows.map(row => getDecision(db, row.id)))
}
