import { execFile } from 'node:child_process'
import path from 'node:path'

const YOUTUBE_FEED_BASE = 'https://www.youtube.com/feeds/videos.xml?channel_id='
const decodeXml = value => String(value || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')

function tag(xml, name) {
  const match = String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return decodeXml(match?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || '')
}

export function normalizeYoutubeSource(value) {
  const input = String(value || '').trim()
  if (!input) throw new Error('YouTube channel ID or RSS feed URL is required')
  let channelId = input.match(/^UC[A-Za-z0-9_-]{20,}$/)?.[0] || ''
  if (!channelId) {
    try {
      const url = new URL(input)
      channelId = url.searchParams.get('channel_id') || url.pathname.match(/\/channel\/(UC[A-Za-z0-9_-]+)/)?.[1] || ''
    } catch {}
  }
  if (!/^UC[A-Za-z0-9_-]{20,}$/.test(channelId)) {
    throw new Error('Use a YouTube channel ID, /channel/UC… URL, or videos.xml?channel_id=… feed URL')
  }
  return { channelId, feedUrl: `${YOUTUBE_FEED_BASE}${encodeURIComponent(channelId)}` }
}

export function parseYoutubeFeed(xml) {
  const sourceName = tag(xml, 'title') || 'YouTube channel'
  const entries = Array.from(String(xml || '').matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)).map(match => {
    const body = match[1]
    const videoId = tag(body, 'yt:videoId') || tag(body, 'videoId')
    const link = body.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1]
      || body.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1]
    return {
      videoId,
      title: tag(body, 'title') || 'Untitled video',
      url: decodeXml(link || `https://www.youtube.com/watch?v=${videoId}`),
      publishedAt: tag(body, 'published') || null,
    }
  }).filter(entry => /^[A-Za-z0-9_-]{6,}$/.test(entry.videoId))
  return { sourceName, entries }
}

export async function listCreatorSources(db) {
  const [sources, videos] = await Promise.all([
    db.query(`SELECT * FROM "CreatorSource" ORDER BY lower("name"),"created_at"`),
    db.query(`SELECT video.*,source."name" AS source_name FROM "CreatorVideo" video JOIN "CreatorSource" source ON source."id"=video."source_id" ORDER BY datetime(video."published_at") DESC,datetime(video."created_at") DESC LIMIT 40`),
  ])
  return {
    sources: sources.rows.map(row => ({ id: row.id, channelId: row.channel_id, name: row.name, feedUrl: row.feed_url, enabled: Boolean(row.enabled), lastPolledAt: row.last_polled_at, lastError: row.last_error })),
    videos: videos.rows.map(row => ({ id: row.id, sourceId: row.source_id, sourceName: row.source_name, title: row.title, url: row.url, publishedAt: row.published_at, status: row.status, attempts: Number(row.attempt_count), claimCount: Number(row.claim_count), error: row.last_error, processedAt: row.processed_at })),
  }
}

function parseStoredJson(value, fallback) {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

export async function getCreatorVideoDetail(db, id) {
  const result = await db.query(`SELECT video.*,source."name" AS source_name FROM "CreatorVideo" video JOIN "CreatorSource" source ON source."id"=video."source_id" WHERE video."id"=$1`, [id])
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id, sourceName: row.source_name, title: row.title, url: row.url,
    status: row.status, attempts: Number(row.attempt_count), claimCount: Number(row.claim_count),
    error: row.last_error, processedAt: row.processed_at,
    transcriptLanguage: row.transcript_language,
    transcriptGenerated: row.transcript_generated == null ? null : Boolean(row.transcript_generated),
    transcript: parseStoredJson(row.transcript_json, []),
    extractionProvider: row.extraction_provider,
    extraction: parseStoredJson(row.extraction_json, null),
  }
}

export async function retryCreatorVideo(db, id) {
  const result = await db.query(`UPDATE "CreatorVideo" SET "status"='DISCOVERED',"next_attempt_at"=NULL,"last_error"=NULL,"updated_at"=$2 WHERE "id"=$1 AND "status" IN ('RETRY','FAILED')`, [id, new Date().toISOString()])
  if (!result.changes) {
    const existing = await db.query(`SELECT "status" FROM "CreatorVideo" WHERE "id"=$1`, [id])
    if (!existing.rows.length) throw new Error('Creator video not found')
    throw new Error(`Creator video cannot be retried while its status is ${existing.rows[0].status}`)
  }
}

export async function addCreatorSource(db, input, fetchImpl = fetch) {
  const normalized = normalizeYoutubeSource(input.url || input.channelId)
  const response = await fetchImpl(normalized.feedUrl, { headers: { 'user-agent': 'insomnia-fpl/0.1' }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`YouTube feed returned HTTP ${response.status}`)
  const feed = parseYoutubeFeed(await response.text())
  const now = new Date().toISOString()
  const id = `youtube:${normalized.channelId}`
  await db.query(`INSERT INTO "CreatorSource" ("id","channel_id","name","feed_url","enabled","created_at","updated_at") VALUES ($1,$2,$3,$4,1,$5,$5)
    ON CONFLICT ("channel_id") DO UPDATE SET "name"=excluded."name","feed_url"=excluded."feed_url","enabled"=1,"updated_at"=excluded."updated_at"`, [id, normalized.channelId, String(input.name || feed.sourceName).trim().slice(0, 160), normalized.feedUrl, now])
  return id
}

async function discoverCreatorVideos(db, sourceId, feed, { publishedAfter } = {}) {
  const baseline = Date.parse(publishedAfter || '')
  const entries = feed.entries
    .filter(entry => Number.isFinite(baseline) && Number.isFinite(Date.parse(entry.publishedAt || '')) && Date.parse(entry.publishedAt) > baseline)
    .slice(0, 15)
  const now = new Date().toISOString()
  for (const entry of entries) {
    await db.query(`INSERT INTO "CreatorVideo" ("id","source_id","title","url","published_at","status","created_at","updated_at") VALUES ($1,$2,$3,$4,$5,'DISCOVERED',$6,$6)
      ON CONFLICT ("id") DO UPDATE SET "title"=excluded."title","url"=excluded."url","published_at"=excluded."published_at","updated_at"=excluded."updated_at"`, [entry.videoId, sourceId, entry.title.slice(0, 500), entry.url.slice(0, 2000), entry.publishedAt, now])
  }
  return entries.length
}

export async function pollCreatorSources(db, fetchImpl = fetch) {
  const result = await db.query(`SELECT * FROM "CreatorSource" WHERE "enabled"=1 ORDER BY "created_at"`)
  let discovered = 0
  for (const source of result.rows) {
    const now = new Date().toISOString()
    try {
      const response = await fetchImpl(source.feed_url, { headers: { 'user-agent': 'insomnia-fpl/0.1' }, signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const feed = parseYoutubeFeed(await response.text())
      discovered += await discoverCreatorVideos(db, source.id, feed, { publishedAfter: source.created_at })
      await db.query(`UPDATE "CreatorSource" SET "name"=$2,"last_polled_at"=$3,"last_error"=NULL,"updated_at"=$3 WHERE "id"=$1`, [source.id, feed.sourceName || source.name, now])
    } catch (error) {
      await db.query(`UPDATE "CreatorSource" SET "last_polled_at"=$2,"last_error"=$3,"updated_at"=$2 WHERE "id"=$1`, [source.id, now, String(error?.message || error).slice(0, 500)])
    }
  }
  return { sources: result.rows.length, discovered }
}

export function fetchYoutubeTranscript(videoId, { python = process.env.PYTHON_BIN || 'python3' } = {}) {
  return new Promise((resolve, reject) => {
    execFile(python, [path.resolve('scripts/fetch-youtube-transcript.py'), videoId], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || stdout || error.message).trim()))
      try { resolve(JSON.parse(String(stdout))) } catch { reject(new Error('Transcript helper returned invalid JSON')) }
    })
  })
}

export function transcriptForPrompt(segments, maxCharacters = 45_000) {
  let output = ''
  for (const segment of segments || []) {
    const line = `[${Math.max(0, Math.round(Number(segment.start) || 0))}s] ${String(segment.text || '').replace(/\s+/g, ' ').trim()}\n`
    if (output.length + line.length > maxCharacters) break
    output += line
  }
  return output.trim()
}

export async function processCreatorQueue(db, { extractClaims, transcriptFetcher = fetchYoutubeTranscript, limit = 2 } = {}) {
  if (typeof extractClaims !== 'function') throw new Error('extractClaims callback is required')
  await db.query(`UPDATE "CreatorVideo" SET "status"='RETRY',"next_attempt_at"=NULL,"last_error"='Recovered after an interrupted processing attempt',"updated_at"=$1 WHERE "status"='PROCESSING' AND datetime("updated_at")<datetime('now','-30 minutes')`, [new Date().toISOString()])
  const queued = await db.query(`SELECT video.*,source."name" AS source_name FROM "CreatorVideo" video JOIN "CreatorSource" source ON source."id"=video."source_id"
    WHERE source."enabled"=1 AND video."status" IN ('DISCOVERED','RETRY') AND (video."next_attempt_at" IS NULL OR datetime(video."next_attempt_at")<=datetime('now'))
    ORDER BY datetime(video."published_at") ASC,datetime(video."created_at") ASC LIMIT $1`, [Math.max(1, Math.min(10, Number(limit) || 2))])
  const summary = { processed: 0, completed: 0, unavailable: 0, retrying: 0, failed: 0, claims: 0 }
  for (const video of queued.rows) {
    const now = new Date().toISOString(), attempts = Number(video.attempt_count || 0) + 1
    await db.query(`UPDATE "CreatorVideo" SET "status"='PROCESSING',"attempt_count"=$2,"updated_at"=$3 WHERE "id"=$1`, [video.id, attempts, now])
    summary.processed += 1
    try {
      const transcript = await transcriptFetcher(video.id)
      if (transcript.status === 'unavailable') {
        const publishedMs = Date.parse(video.published_at || '')
        const recentlyPublished = Number.isFinite(publishedMs) && Date.now() - publishedMs < 48 * 60 * 60 * 1000
        if (recentlyPublished && attempts < 3 && transcript.reason !== 'VideoUnavailable') {
          throw new Error(`Captions may still be processing: ${transcript.error || 'not available yet'}`)
        }
        await db.query(`UPDATE "CreatorVideo" SET "status"='NO_TRANSCRIPT',"last_error"=$2,"updated_at"=$3,"processed_at"=$3 WHERE "id"=$1`, [video.id, String(transcript.error || 'No English transcript available').slice(0, 500), now])
        summary.unavailable += 1
        continue
      }
      if (transcript.status !== 'ok') throw new Error(transcript.error || 'Transcript fetch failed')
      const extraction = await extractClaims({ video, transcript })
      const claims = Array.isArray(extraction?.payload?.claims) ? extraction.payload.claims : []
      const ingest = claims.length ? await extraction.ingest(extraction.payload) : { created: 0 }
      await db.query(`UPDATE "CreatorVideo" SET "status"='COMPLETE',"transcript_json"=$2,"transcript_language"=$3,"transcript_generated"=$4,"extraction_provider"=$5,"extraction_json"=$6,"claim_count"=$7,"last_error"=NULL,"updated_at"=$8,"processed_at"=$8 WHERE "id"=$1`, [video.id, JSON.stringify(transcript.segments), transcript.languageCode || transcript.language || null, transcript.isGenerated == null ? null : transcript.isGenerated ? 1 : 0, extraction.provider || null, JSON.stringify(extraction.payload), claims.length, now])
      summary.completed += 1; summary.claims += Number(ingest.created || claims.length)
    } catch (error) {
      const retryable = attempts < 5
      const delayMinutes = Math.min(24 * 60, 15 * (2 ** (attempts - 1)))
      const next = new Date(Date.now() + delayMinutes * 60_000).toISOString()
      await db.query(`UPDATE "CreatorVideo" SET "status"=$2,"next_attempt_at"=$3,"last_error"=$4,"updated_at"=$5 WHERE "id"=$1`, [video.id, retryable ? 'RETRY' : 'FAILED', retryable ? next : null, String(error?.message || error).slice(0, 500), now])
      if (retryable) summary.retrying += 1; else summary.failed += 1
    }
  }
  return summary
}

export async function setCreatorSourceEnabled(db, id, enabled) {
  const result = await db.query(`UPDATE "CreatorSource" SET "enabled"=$2,"updated_at"=$3 WHERE "id"=$1`, [id, enabled ? 1 : 0, new Date().toISOString()])
  if (!result.changes) throw new Error('Creator source not found')
}

export async function deleteCreatorSource(db, id) {
  const result = await db.query(`DELETE FROM "CreatorSource" WHERE "id"=$1`, [id])
  if (!result.changes) throw new Error('Creator source not found')
}
