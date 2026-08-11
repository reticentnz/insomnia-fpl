import { randomUUID } from 'node:crypto'

type Database = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; changes?: number }> }
type SignalStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED'

const roleKinds = new Set(['DEPTH_CHART', 'EXPECTED_ROLE', 'START_PROBABILITY'])
const json = (value: unknown) => { try { return JSON.parse(String(value || '{}')) } catch { return {} } }
const nowIso = (value?: string) => new Date(value || Date.now()).toISOString()

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
  return {
    id: String(row.id), playerId: Number(row.fpl_id), gameweek: row.gameweek_fpl_id == null ? null : Number(row.gameweek_fpl_id),
    kind: row.kind, value: json(row.value_json), sourceType: row.source_type, sourceUrl: row.source_url,
    evidenceSummary: row.evidence_summary, confidence: Number(row.confidence), observedAt: row.observed_at,
    validUntil: row.valid_until, status: row.status,
  }
}

const selectSignals = `SELECT signal.*, player."fpl_id", gameweek."fpl_id" AS "gameweek_fpl_id"
  FROM "PlayerSignal" signal JOIN "Player" player ON player."id"=signal."player_id"
  LEFT JOIN "Gameweek" gameweek ON gameweek."id"=signal."gameweek_id"`

export async function listPlayerSignals(db: Database, { playerId, status, sourceType, limit = 200 }: { playerId?: string | number | null; status?: string | null; sourceType?: string | null; limit?: number } = {}) {
  const result = await db.query(`${selectSignals}
    WHERE ($1 IS NULL OR player."fpl_id"=$1 OR signal."player_id"=$2) AND ($3 IS NULL OR signal."status"=$3) AND ($4 IS NULL OR signal."source_type"=$4)
    ORDER BY datetime(signal."observed_at") DESC, signal."id" DESC LIMIT $5`, [playerId == null ? null : Number(playerId), playerId == null ? null : String(playerId), status || null, sourceType || null, Math.min(500, Math.max(1, Number(limit) || 200))])
  return result.rows.map(signalApiRow)
}

async function audit(db: Database, signalId: string, fromStatus: SignalStatus | null, toStatus: SignalStatus, reason: string, actorType: string, createdAt: string) {
  await db.query(`INSERT INTO "PlayerSignalAudit" ("id","signal_id","from_status","to_status","reason","actor_type","created_at") VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), signalId, fromStatus, toStatus, reason, actorType, createdAt])
}

export async function createPlayerSignal(db: Database, input: { id?: string; playerId: string | number; gameweek?: string | number | null; kind: string; value?: unknown; sourceType: string; sourceUrl?: string | null; evidenceSummary: string; confidence: number; observedAt?: string; validUntil: string; status?: SignalStatus; actorType?: string }) {
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
  if (roleKinds.has(input.kind)) {
    const previous = await db.query(`SELECT "id", "status" FROM "PlayerSignal" WHERE "player_id"=$1 AND "kind"=$2 AND "status" IN ('VERIFIED','PENDING') AND "source_type"<>'MANUAL_OVERRIDE'`, [player.id, input.kind])
    for (const row of previous.rows) {
      await db.query(`UPDATE "PlayerSignal" SET "status"='EXPIRED', "updated_at"=$2 WHERE "id"=$1`, [row.id, observedAt])
      await audit(db, row.id, row.status, 'EXPIRED', 'Superseded by newer role evidence', input.actorType || 'SYSTEM', observedAt)
    }
  }
  await db.query(`INSERT INTO "PlayerSignal" ("id","player_id","gameweek_id","kind","value_json","source_type","source_url","evidence_summary","confidence","observed_at","valid_until","status","created_at","updated_at") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$10,$10) ON CONFLICT ("id") DO NOTHING`, [id, player.id, gameweekId, input.kind, JSON.stringify(input.value || {}), input.sourceType, input.sourceUrl || null, input.evidenceSummary, confidence, observedAt, validUntil, status])
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
