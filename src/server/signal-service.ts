import { randomUUID } from 'node:crypto'

type Database = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; changes?: number }> }
type SignalStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED'
type ClaimClass = 'REAL_WORLD_ROLE' | 'ROTATION' | 'AVAILABILITY' | 'INJURY' | 'SET_PIECES' | 'PENALTIES' | 'FPL_SELECTION' | 'CREATOR_RATING' | 'VALUE_OPINION' | 'STATISTICAL_CONTEXT' | 'UNKNOWN'
type ModelImpact = 'ROLE' | 'NONE'

const json = (value: unknown) => { try { return JSON.parse(String(value || '{}')) } catch { return {} } }
const nowIso = (value?: string) => new Date(value || Date.now()).toISOString()
const roleValueKeys = ['startProbability', 'minutesIfStarting', 'substituteProbabilityWhenBenched', 'minutesIfSubstitute', 'depthRole']
const hasRoleValue = (value: unknown) => {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return roleValueKeys.some(key => record[key] !== null && record[key] !== undefined)
}
const defaultClaimClass = (kind: string): ClaimClass => {
  if (['START_PROBABILITY', 'DEPTH_CHART', 'EXPECTED_ROLE'].includes(kind)) return 'REAL_WORLD_ROLE'
  if (kind === 'INJURY') return 'INJURY'
  if (kind === 'SET_PIECES') return 'SET_PIECES'
  if (kind === 'PENALTIES') return 'PENALTIES'
  if (kind === 'VALUE_OPINION') return 'VALUE_OPINION'
  if (kind === 'STATISTICAL_CLAIM') return 'STATISTICAL_CONTEXT'
  return 'UNKNOWN'
}

async function resolvePlayer(db: Database, playerId: string | number) {
  const result = await db.query(`SELECT "id", "fpl_id" FROM "Player" WHERE "id"=$1 OR "fpl_id"=$2 ORDER BY "season" DESC LIMIT 1`, [String(playerId), Number(playerId)])
  if (!result.rows[0]) throw new Error(`Player ${playerId} does not exist`)
  return result.rows[0]
}

async function resolveGameweek(db: Database, gameweek: string | number | null | undefined) {
  if (gameweek == null) return null
  const result = await db.query(`SELECT "id" FROM "Gameweek" WHERE "id"=$1 OR "fpl_id"=$2 ORDER BY "season" DESC LIMIT 1`, [String(gameweek), Number(gameweek)])
  if (!result.rows[0]) throw new Error(`Gameweek ${gameweek} does not exist`)
  return result.rows[0].id
}

export function signalApiRow(row: any) {
  const value = json(row.value_json)
  const interpretationValue = row.interpretation_value_json == null ? value : json(row.interpretation_value_json)
  const claimClass = row.interpretation_claim_class || row.claim_class || defaultClaimClass(row.kind)
  const modelImpact: ModelImpact = row.interpretation_model_impact || (hasRoleValue(interpretationValue) ? 'ROLE' : 'NONE')
  return {
    id: String(row.id), playerId: Number(row.fpl_id), gameweek: row.gameweek_fpl_id == null ? null : Number(row.gameweek_fpl_id),
    kind: row.kind, value: interpretationValue, sourceType: row.source_type, sourceUrl: row.source_url,
    evidenceSummary: row.evidence_summary, confidence: Number(row.confidence), observedAt: row.observed_at,
    evidenceText: row.evidence_text || row.evidence_summary, claimClass, validUntil: row.valid_until, status: row.status,
    sourceDate: row.source_date || null,
    interpretation: {
      id: row.interpretation_id || null,
      origin: row.interpretation_origin || (row.source_type === 'MANUAL_OVERRIDE' ? 'USER' : 'AUTO'),
      claimClass,
      modelImpact,
      value: interpretationValue,
      rationale: row.interpretation_rationale || (modelImpact === 'ROLE' ? 'Structured role adjustment supplied with this evidence.' : 'Context only; no projection adjustment proposed.'),
      confidence: Number(row.interpretation_confidence ?? row.confidence),
      status: row.interpretation_status || (row.status === 'VERIFIED' ? 'APPROVED' : row.status === 'REJECTED' ? 'REJECTED' : row.status === 'EXPIRED' ? 'SUPERSEDED' : 'PROPOSED'),
    },
  }
}

const selectSignals = `SELECT signal.*, player."fpl_id", gameweek."fpl_id" AS "gameweek_fpl_id",
    interpretation."id" AS "interpretation_id", interpretation."origin" AS "interpretation_origin",
    interpretation."claim_class" AS "interpretation_claim_class", interpretation."model_impact" AS "interpretation_model_impact",
    interpretation."value_json" AS "interpretation_value_json", interpretation."rationale" AS "interpretation_rationale",
    interpretation."confidence" AS "interpretation_confidence", interpretation."status" AS "interpretation_status"
  FROM "PlayerSignal" signal JOIN "Player" player ON player."id"=signal."player_id"
  LEFT JOIN "Gameweek" gameweek ON gameweek."id"=signal."gameweek_id"
  LEFT JOIN "PlayerSignalInterpretation" interpretation ON interpretation."id"=(
    SELECT candidate."id" FROM "PlayerSignalInterpretation" candidate
    WHERE candidate."signal_id"=signal."id" ORDER BY candidate.rowid DESC LIMIT 1
  )`

export async function listPlayerSignals(db: Database, { playerId, status, sourceType, limit = 200 }: { playerId?: string | number | null; status?: string | null; sourceType?: string | null; limit?: number } = {}) {
  const result = await db.query(`${selectSignals}
    WHERE ($1 IS NULL OR player."fpl_id"=$1 OR signal."player_id"=$2) AND ($3 IS NULL OR signal."status"=$3) AND ($4 IS NULL OR signal."source_type"=$4)
    ORDER BY datetime(signal."observed_at") DESC, signal."id" DESC LIMIT $5`, [playerId == null ? null : Number(playerId), playerId == null ? null : String(playerId), status || null, sourceType || null, Math.min(500, Math.max(1, Number(limit) || 200))])
  return result.rows.map(signalApiRow)
}

async function audit(db: Database, signalId: string, fromStatus: SignalStatus | null, toStatus: SignalStatus, reason: string, actorType: string, createdAt: string) {
  await db.query(`INSERT INTO "PlayerSignalAudit" ("id","signal_id","from_status","to_status","reason","actor_type","created_at") VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), signalId, fromStatus, toStatus, reason, actorType, createdAt])
}

export async function createPlayerSignal(db: Database, input: { id?: string; playerId: string | number; gameweek?: string | number | null; kind: string; value?: unknown; sourceType: string; sourceUrl?: string | null; evidenceSummary: string; evidenceText?: string | null; claimClass?: ClaimClass; interpretationRationale?: string; interpretationConfidence?: number; modelImpact?: ModelImpact; confidence: number; observedAt?: string; validUntil: string; status?: SignalStatus; actorType?: string; sourceDate?: string | null }) {
  if (!input.kind || !input.evidenceSummary) throw new Error('kind and evidenceSummary are required')
  const confidence = Number(input.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('confidence must be between 0 and 1')
  const player = await resolvePlayer(db, input.playerId)
  const gameweekId = await resolveGameweek(db, input.gameweek)
  const observedAt = nowIso(input.observedAt)
  const validUntil = nowIso(input.validUntil)
  if (Date.parse(validUntil) < Date.parse(observedAt)) throw new Error('validUntil must not precede observedAt')
  const status = input.status || 'PENDING'
  const id = input.id || randomUUID()
  const existing = await db.query(`${selectSignals} WHERE signal."id"=$1`, [id])
  if (existing.rows[0]) return signalApiRow(existing.rows[0])
  const value = input.value || {}
  const claimClass = input.claimClass || defaultClaimClass(input.kind)
  const modelImpact: ModelImpact = input.modelImpact || (hasRoleValue(value) ? 'ROLE' : 'NONE')
  const interpretationConfidence = Number.isFinite(Number(input.interpretationConfidence)) ? Number(input.interpretationConfidence) : confidence
  await db.query(`INSERT INTO "PlayerSignal" ("id","player_id","gameweek_id","kind","value_json","source_type","source_url","evidence_summary","evidence_text","claim_class","confidence","observed_at","valid_until","status","created_at","updated_at","source_date") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$12,$12,$15) ON CONFLICT ("id") DO NOTHING`, [id, player.id, gameweekId, input.kind, JSON.stringify(value), input.sourceType, input.sourceUrl || null, input.evidenceSummary, input.evidenceText || input.evidenceSummary, claimClass, confidence, observedAt, validUntil, status, input.sourceDate || null])
  await db.query(`INSERT INTO "PlayerSignalInterpretation" ("id","signal_id","origin","claim_class","model_impact","value_json","rationale","confidence","status","created_at","updated_at") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT ("id") DO NOTHING`, [`interpretation:${id}`, id, input.sourceType === 'MANUAL_OVERRIDE' ? 'USER' : 'AUTO', claimClass, modelImpact, JSON.stringify(value), input.interpretationRationale || (modelImpact === 'ROLE' ? 'Structured model adjustment inferred from the evidence.' : 'Context only; no projection adjustment proposed.'), interpretationConfidence, status === 'VERIFIED' ? 'APPROVED' : status === 'REJECTED' ? 'REJECTED' : status === 'EXPIRED' ? 'SUPERSEDED' : 'PROPOSED', observedAt])
  const selected = await db.query(`${selectSignals} WHERE signal."id"=$1`, [id])
  if (!selected.rows[0]) throw new Error(`Signal ${id} conflicts with an existing record`)
  await audit(db, id, null, status, 'Signal created', input.actorType || 'USER', observedAt)
  return signalApiRow(selected.rows[0])
}

export async function updatePlayerSignalStatuses(db: Database, updates: Array<{ id: string | number; status: SignalStatus }>, { reason = 'Manager evidence review', actorType = 'USER', updatedAt = new Date().toISOString() } = {}) {
  const allowed = new Set<SignalStatus>(['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'])
  if (!updates.length || updates.some(update => !update.id || !allowed.has(update.status))) throw new Error('Each update requires a signal id and valid status')
  const results = []
  await db.query('BEGIN IMMEDIATE')
  try {
    for (const update of updates) {
      const current = await db.query(`SELECT "status" FROM "PlayerSignal" WHERE "id"=$1`, [String(update.id)])
      if (!current.rows[0]) throw new Error(`Signal ${update.id} not found`)
      await db.query(`UPDATE "PlayerSignal" SET "status"=$2, "updated_at"=$3 WHERE "id"=$1`, [String(update.id), update.status, updatedAt])
      const interpretationStatus = update.status === 'VERIFIED' ? 'APPROVED' : update.status === 'REJECTED' ? 'REJECTED' : update.status === 'EXPIRED' ? 'SUPERSEDED' : 'PROPOSED'
      await db.query(`UPDATE "PlayerSignalInterpretation" SET "status"=$2, "updated_at"=$3 WHERE "id"=(SELECT "id" FROM "PlayerSignalInterpretation" WHERE "signal_id"=$1 ORDER BY rowid DESC LIMIT 1)`, [String(update.id), interpretationStatus, updatedAt])
      if (current.rows[0].status !== update.status) await audit(db, String(update.id), current.rows[0].status, update.status, reason, actorType, updatedAt)
      const selected = await db.query(`${selectSignals} WHERE signal."id"=$1`, [String(update.id)])
      results.push(signalApiRow(selected.rows[0]))
    }
    await db.query('COMMIT')
    return results
  } catch (error) {
    try { await db.query('ROLLBACK') } catch {}
    throw error
  }
}

export async function deletePlayerSignal(db: Database, signalId: string | number) {
  const id = String(signalId)
  const current = await db.query(`${selectSignals} WHERE signal."id"=$1`, [id])
  if (!current.rows[0]) throw new Error(`Signal ${id} not found`)
  const signal = signalApiRow(current.rows[0])
  await db.query('BEGIN IMMEDIATE')
  try {
    // The schema deliberately restricts deletion of evidence with provenance.
    // Remove those dependent records in one transaction before the signal.
    await db.query(`UPDATE "PlayerSignalInterpretation" SET "supersedes_id"=NULL WHERE "signal_id"=$1`, [id])
    await db.query(`DELETE FROM "PlayerSignalAudit" WHERE "signal_id"=$1`, [id])
    await db.query(`DELETE FROM "PlayerSignalInterpretation" WHERE "signal_id"=$1`, [id])
    await db.query(`DELETE FROM "PlayerSignal" WHERE "id"=$1`, [id])
    await db.query('COMMIT')
    return signal
  } catch (error) {
    try { await db.query('ROLLBACK') } catch {}
    throw error
  }
}

export async function revisePlayerSignalInterpretation(db: Database, signalId: string, input: { claimClass?: ClaimClass; modelImpact?: ModelImpact; value?: unknown; rationale?: string; confidence?: number; finalizeContext?: boolean }, updatedAt = new Date().toISOString()) {
  const current = await db.query(`${selectSignals} WHERE signal."id"=$1`, [signalId])
  if (!current.rows[0]) throw new Error(`Signal ${signalId} not found`)
  const signal = signalApiRow(current.rows[0])
  const previousId = signal.interpretation.id as string | null
  const value = input.value == null ? signal.interpretation.value : input.value
  const modelImpact: ModelImpact = input.modelImpact || (hasRoleValue(value) ? 'ROLE' : 'NONE')
  if (modelImpact === 'NONE' && hasRoleValue(value)) throw new Error('Context-only interpretations cannot contain role adjustments')
  if (modelImpact === 'ROLE' && !hasRoleValue(value)) throw new Error('A model-impacting interpretation requires a structured role adjustment')
  const claimClass = input.claimClass || signal.interpretation.claimClass
  const confidence = Math.max(0, Math.min(1, Number(input.confidence ?? signal.interpretation.confidence)))
  const id = randomUUID()
  await db.query('BEGIN IMMEDIATE')
  try {
    if (previousId) await db.query(`UPDATE "PlayerSignalInterpretation" SET "status"='SUPERSEDED', "updated_at"=$2 WHERE "id"=$1`, [previousId, updatedAt])
    const status = input.finalizeContext && modelImpact === 'NONE' ? 'APPROVED' : 'PROPOSED'
    await db.query(`INSERT INTO "PlayerSignalInterpretation" ("id","signal_id","origin","claim_class","model_impact","value_json","rationale","confidence","status","supersedes_id","created_at","updated_at") VALUES ($1,$2,'USER',$3,$4,$5,$6,$7,$8,$9,$10,$10)`, [id, signalId, claimClass, modelImpact, JSON.stringify(value || {}), input.rationale || 'User-adjusted interpretation.', confidence, status, previousId, updatedAt])
    await db.query(`UPDATE "PlayerSignal" SET "value_json"=$2, "claim_class"=$3, "status"=$4, "updated_at"=$5 WHERE "id"=$1`, [signalId, JSON.stringify(value || {}), claimClass, status === 'APPROVED' ? 'VERIFIED' : 'PENDING', updatedAt])
    await audit(db, signalId, signal.status, status === 'APPROVED' ? 'VERIFIED' : 'PENDING', status === 'APPROVED' ? 'Marked as context only' : 'Interpretation revised by manager', 'USER', updatedAt)
    await db.query('COMMIT')
  } catch (error) {
    try { await db.query('ROLLBACK') } catch {}
    throw error
  }
  const selected = await db.query(`${selectSignals} WHERE signal."id"=$1`, [signalId])
  return signalApiRow(selected.rows[0])
}
