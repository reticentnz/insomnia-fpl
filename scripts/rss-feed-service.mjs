import { createHash } from 'node:crypto'

const MAX_FEED_BYTES = 2 * 1024 * 1024
const MAX_ITEM_TEXT = 45_000
const clean = value => decodeXml(String(value || '').replace(/<!\[CDATA\[|\]\]>/g, '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const decodeXml = value => String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
const digest = value => createHash('sha256').update(String(value)).digest('hex')

function tag(xml, name) {
  const match = String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return clean(match?.[1] || '')
}

function link(xml) {
  const atom = String(xml).match(/<link\\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || String(xml).match(/<link\\b[^>]*href=["']([^"']+)["']/i)
  return decodeXml(atom?.[1] || tag(xml, 'link'))
}

export function normalizeRssSource(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { throw new Error('A valid RSS or Atom feed URL is required') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('RSS feeds must use an http or https URL')
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || /^127\.|^0\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1' || host === '[::1]' || host.startsWith('[fe80:') || host.startsWith('[fc') || host.startsWith('[fd')) throw new Error('RSS feeds must use a public hostname')
  url.hash = ''
  return url.toString()
}

export function parseRssFeed(xml) {
  const sourceName = tag(xml, 'channel>title') || tag(xml, 'feed>title') || tag(xml, 'title') || 'RSS feed'
  const blocks = [...String(xml).matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map(match => match[2])
  const entries = blocks.map(body => {
    const title = tag(body, 'title') || 'Untitled item'
    const url = link(body) || null
    const publishedAt = tag(body, 'pubDate') || tag(body, 'published') || tag(body, 'updated') || null
    const externalId = tag(body, 'guid') || tag(body, 'id') || url || digest(`${title}|${publishedAt}|${body.slice(0, 500)}`)
    const contentText = (tag(body, 'content:encoded') || tag(body, 'content') || tag(body, 'description') || tag(body, 'summary')).slice(0, MAX_ITEM_TEXT)
    return { externalId: externalId.slice(0, 500), title: title.slice(0, 500), url: url?.slice(0, 2000) || null, publishedAt, contentText }
  }).filter(entry => entry.contentText)
  return { sourceName: sourceName.slice(0, 160), entries }
}

async function fetchFeed(url, fetchImpl, validators = {}, redirects = 0) {
  const headers = { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9', 'user-agent': 'insomnia-fpl/0.1' }
  if (validators.etag) headers['if-none-match'] = validators.etag
  if (validators.lastModified) headers['if-modified-since'] = validators.lastModified
  const response = await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  if (response.status >= 300 && response.status < 400) {
    if (redirects >= 3) throw new Error('RSS feed redirected too many times')
    const location = response.headers.get('location')
    if (!location) throw new Error(`RSS feed returned HTTP ${response.status} without a redirect location`)
    let redirected
    try { redirected = normalizeRssSource(new URL(location, url).toString()) } catch { throw new Error('RSS feed redirected to an invalid or non-public URL') }
    return fetchFeed(redirected, fetchImpl, validators, redirects + 1)
  }
  if (response.status === 304) return { unchanged: true, etag: validators.etag || null, lastModified: validators.lastModified || null, payloadHash: validators.payloadHash || null }
  if (!response.ok) throw new Error(`RSS feed returned HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length') || 0)
  if (length > MAX_FEED_BYTES) throw new Error('RSS feed exceeds the 2 MB limit')
  const body = await response.text()
  if (Buffer.byteLength(body) > MAX_FEED_BYTES) throw new Error('RSS feed exceeds the 2 MB limit')
  return { unchanged: digest(body) === validators.payloadHash, body, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), payloadHash: digest(body) }
}

export async function listRssSources(db) {
  const [sources, items] = await Promise.all([
    db.query(`SELECT * FROM "RssSource" ORDER BY lower("name"),"created_at"`),
    db.query(`SELECT item.*,source."name" AS source_name FROM "RssItem" item JOIN "RssSource" source ON source."id"=item."source_id" ORDER BY datetime(item."published_at") DESC,datetime(item."created_at") DESC LIMIT 40`),
  ])
  return {
    sources: sources.rows.map(row => ({ id: row.id, name: row.name, feedUrl: row.feed_url, enabled: Boolean(row.enabled), lastPolledAt: row.last_polled_at, lastError: row.last_error })),
    items: items.rows.map(row => ({ id: row.id, sourceId: row.source_id, sourceName: row.source_name, title: row.title, url: row.url, publishedAt: row.published_at, status: row.status, attempts: Number(row.attempt_count), claimCount: Number(row.claim_count), error: row.last_error, processedAt: row.processed_at })),
  }
}

export async function addRssSource(db, input, fetchImpl = fetch) {
  const feedUrl = normalizeRssSource(input.url)
  const fetched = await fetchFeed(feedUrl, fetchImpl), feed = parseRssFeed(fetched.body)
  const now = new Date().toISOString(), id = `rss:${digest(feedUrl).slice(0, 24)}`
  await db.query(`INSERT INTO "RssSource" ("id","name","feed_url","enabled","feed_etag","feed_last_modified","payload_hash","created_at","updated_at") VALUES ($1,$2,$3,1,$4,$5,$6,$7,$7)
    ON CONFLICT ("feed_url") DO UPDATE SET "name"=excluded."name","enabled"=1,"feed_etag"=excluded."feed_etag","feed_last_modified"=excluded."feed_last_modified","payload_hash"=excluded."payload_hash","updated_at"=excluded."updated_at"`, [id, String(input.name || feed.sourceName).trim().slice(0, 160), feedUrl, fetched.etag, fetched.lastModified, fetched.payloadHash, now])
  return id
}

async function discoverItems(db, source, feed) {
  const baseline = Date.parse(source.created_at || '')
  const now = new Date().toISOString()
  let discovered = 0
  for (const entry of feed.entries.filter(item => Number.isFinite(baseline) && Number.isFinite(Date.parse(item.publishedAt || '')) && Date.parse(item.publishedAt) > baseline).slice(0, 20)) {
    const id = `rss-item:${digest(`${source.id}:${entry.externalId}`).slice(0, 40)}`
    const result = await db.query(`INSERT INTO "RssItem" ("id","source_id","external_id","title","url","published_at","content_text","status","created_at","updated_at") VALUES ($1,$2,$3,$4,$5,$6,$7,'DISCOVERED',$8,$8) ON CONFLICT ("source_id","external_id") DO NOTHING`, [id, source.id, entry.externalId, entry.title, entry.url, entry.publishedAt, entry.contentText, now])
    discovered += Number(result.changes || 0)
  }
  return discovered
}

export async function pollRssSources(db, fetchImpl = fetch) {
  const result = await db.query(`SELECT * FROM "RssSource" WHERE "enabled"=1 ORDER BY "created_at"`)
  let discovered = 0
  for (const source of result.rows) {
    const now = new Date().toISOString()
    try {
      const fetched = await fetchFeed(source.feed_url, fetchImpl, { etag: source.feed_etag, lastModified: source.feed_last_modified, payloadHash: source.payload_hash })
      if (fetched.unchanged) {
        await db.query(`UPDATE "RssSource" SET "last_polled_at"=$2,"last_error"=NULL,"updated_at"=$2 WHERE "id"=$1`, [source.id, now])
        continue
      }
      const feed = parseRssFeed(fetched.body)
      discovered += await discoverItems(db, source, feed)
      await db.query(`UPDATE "RssSource" SET "name"=$2,"feed_etag"=$3,"feed_last_modified"=$4,"payload_hash"=$5,"last_polled_at"=$6,"last_error"=NULL,"updated_at"=$6 WHERE "id"=$1`, [source.id, feed.sourceName || source.name, fetched.etag, fetched.lastModified, fetched.payloadHash, now])
    } catch (error) {
      await db.query(`UPDATE "RssSource" SET "last_polled_at"=$2,"last_error"=$3,"updated_at"=$2 WHERE "id"=$1`, [source.id, now, String(error?.message || error).slice(0, 500)])
    }
  }
  return { sources: result.rows.length, discovered }
}

export async function processRssQueue(db, { extractClaims, limit = 3 } = {}) {
  if (typeof extractClaims !== 'function') throw new Error('extractClaims callback is required')
  const queued = await db.query(`SELECT item.*,source."name" AS source_name FROM "RssItem" item JOIN "RssSource" source ON source."id"=item."source_id" WHERE source."enabled"=1 AND item."status" IN ('DISCOVERED','RETRY') AND (item."next_attempt_at" IS NULL OR datetime(item."next_attempt_at")<=datetime('now')) ORDER BY datetime(item."published_at") ASC,datetime(item."created_at") ASC LIMIT $1`, [Math.max(1, Math.min(10, Number(limit) || 3))])
  const summary = { processed: 0, completed: 0, insufficient: 0, retrying: 0, failed: 0, claims: 0 }
  for (const item of queued.rows) {
    const now = new Date().toISOString(), attempts = Number(item.attempt_count || 0) + 1
    await db.query(`UPDATE "RssItem" SET "status"='PROCESSING',"attempt_count"=$2,"updated_at"=$3 WHERE "id"=$1`, [item.id, attempts, now])
    summary.processed += 1
    try {
      if (String(item.content_text || '').length < 80) {
        await db.query(`UPDATE "RssItem" SET "status"='INSUFFICIENT_EVIDENCE',"last_error"='Feed item did not contain enough supplied text for extraction',"updated_at"=$2,"processed_at"=$2 WHERE "id"=$1`, [item.id, now]); summary.insufficient += 1; continue
      }
      const extraction = await extractClaims({ item })
      const claims = Array.isArray(extraction?.payload?.claims) ? extraction.payload.claims : []
      const ingest = claims.length ? await extraction.ingest(extraction.payload) : { created: 0 }
      await db.query(`UPDATE "RssItem" SET "status"='COMPLETE',"extraction_provider"=$2,"extraction_json"=$3,"claim_count"=$4,"last_error"=NULL,"updated_at"=$5,"processed_at"=$5 WHERE "id"=$1`, [item.id, extraction.provider || null, JSON.stringify(extraction.payload), claims.length, now])
      summary.completed += 1; summary.claims += Number(ingest.created || claims.length)
    } catch (error) {
      const retryable = attempts < 5, delayMinutes = Math.min(24 * 60, 15 * (2 ** (attempts - 1))), next = new Date(Date.now() + delayMinutes * 60_000).toISOString()
      await db.query(`UPDATE "RssItem" SET "status"=$2,"next_attempt_at"=$3,"last_error"=$4,"updated_at"=$5 WHERE "id"=$1`, [item.id, retryable ? 'RETRY' : 'FAILED', retryable ? next : null, String(error?.message || error).slice(0, 500), now])
      if (retryable) summary.retrying += 1; else summary.failed += 1
    }
  }
  return summary
}

export async function setRssSourceEnabled(db, id, enabled) {
  const result = await db.query(`UPDATE "RssSource" SET "enabled"=$2,"updated_at"=$3 WHERE "id"=$1`, [id, enabled ? 1 : 0, new Date().toISOString()])
  if (!result.changes) throw new Error('RSS source not found')
}

export async function deleteRssSource(db, id) {
  const result = await db.query(`DELETE FROM "RssSource" WHERE "id"=$1`, [id])
  if (!result.changes) throw new Error('RSS source not found')
}
