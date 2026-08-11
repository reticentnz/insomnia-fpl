import { createHash, randomUUID } from 'node:crypto'

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED'])

function canonicalValue(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalValue(item)).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(',')}}`
}

export function canonicalJson(value) {
  return canonicalValue(value)
}

export function hashPayload(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function sanitizeError(error) {
  const source = error instanceof Error ? error.message : String(error)
  return source
    .replace(/((?:authorization|api[-_ ]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[URL_REDACTED]')
    .slice(0, 500)
}

function terminalStatus(status) {
  if (!TERMINAL_STATUSES.has(status)) throw new Error(`Invalid terminal feed-run status: ${status}`)
  return status
}

export async function startFeedRun(db, {
  source = 'OFFICIAL_FPL',
  startedAt = new Date().toISOString(),
  sourceUpdatedAt = null,
  payloadHash = null,
  requestCount = 0,
  metadata = {},
} = {}) {
  const id = randomUUID()
  await db.query(
    `INSERT INTO "FeedRun" (
      "id", "source", "status", "started_at", "source_updated_at", "payload_hash",
      "request_count", "metadata_json"
    ) VALUES ($1, $2, 'RUNNING', $3, $4, $5, $6, $7)`,
    [id, source, startedAt, sourceUpdatedAt, payloadHash, requestCount, canonicalJson(metadata)],
  )
  return id
}

export async function finishFeedRun(db, id, status, {
  finishedAt = new Date().toISOString(),
  sourceUpdatedAt,
  payloadHash: payloadHashValue,
  requestCount,
  insertedCount,
  updatedCount,
  unmatchedCount,
  usedCache,
  cacheCapturedAt,
  errorSummary,
  metadata,
} = {}) {
  terminalStatus(status)
  const current = await db.query('SELECT * FROM "FeedRun" WHERE "id"=$1', [id])
  if (!current.rows.length) throw new Error(`Feed run ${id} does not exist`)
  if (current.rows[0].status !== 'RUNNING') throw new Error(`Feed run ${id} is already ${current.rows[0].status}`)

  const existingMetadata = JSON.parse(current.rows[0].metadata_json || '{}')
  const mergedMetadata = metadata === undefined ? existingMetadata : { ...existingMetadata, ...metadata }
  await db.query(
    `UPDATE "FeedRun"
     SET "status"=$2,
         "finished_at"=$3,
         "source_updated_at"=COALESCE($4, "source_updated_at"),
         "payload_hash"=COALESCE($5, "payload_hash"),
         "request_count"=COALESCE($6, "request_count"),
         "inserted_count"=COALESCE($7, "inserted_count"),
         "updated_count"=COALESCE($8, "updated_count"),
         "unmatched_count"=COALESCE($9, "unmatched_count"),
         "used_cache"=COALESCE($10, "used_cache"),
         "cache_captured_at"=COALESCE($11, "cache_captured_at"),
         "error_summary"=$12,
         "metadata_json"=$13
     WHERE "id"=$1`,
    [
      id,
      status,
      finishedAt,
      sourceUpdatedAt ?? null,
      payloadHashValue ?? null,
      requestCount ?? null,
      insertedCount ?? null,
      updatedCount ?? null,
      unmatchedCount ?? null,
      usedCache === undefined ? null : Boolean(usedCache),
      cacheCapturedAt ?? null,
      errorSummary ?? null,
      canonicalJson(mergedMetadata),
    ],
  )
}

export async function succeedFeedRun(db, id, details = {}) {
  return finishFeedRun(db, id, 'SUCCEEDED', details)
}

export async function partialFeedRun(db, id, details = {}) {
  return finishFeedRun(db, id, 'PARTIAL', details)
}

export async function failFeedRun(db, id, error, details = {}) {
  return finishFeedRun(db, id, 'FAILED', {
    ...details,
    errorSummary: sanitizeError(error),
  })
}

export async function latestSuccessfulFeedRun(db, source = 'OFFICIAL_FPL') {
  const result = await db.query(
    `SELECT "id", "source", "status", "started_at", "finished_at", "source_updated_at",
            COALESCE("source_updated_at", "started_at") AS "freshness_at",
            "payload_hash", "used_cache", "cache_captured_at"
     FROM "FeedRun"
     WHERE "source"=$1 AND "status" IN ('SUCCEEDED', 'PARTIAL')
     ORDER BY "started_at" DESC, "id" DESC
     LIMIT 1`,
    [source],
  )
  return result.rows[0] || null
}
