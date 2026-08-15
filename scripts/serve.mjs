import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { resolvePlayerRole } from '../src/player-signals.ts'
import { MODEL_VERSION } from '../src/core/projection.ts'
import { interpretManualSignalText, matchCreatorClaim, normalizeCreatorPayload, normalizeEntityText, signalDraftFromClaim, shouldAutoApproveCreatorContext } from './creator-signals.mjs'
import { sourceTypeMatchesUrl } from '../src/signal-sources.ts'

const port = Number(process.env.PORT || 4173)
const host = process.env.HOST || '127.0.0.1'
const RESEARCH_AUDIT_LIMIT = 6
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
}

// Load environment variables from .env.local and .env
for (const envFile of ['.env.local', '.env']) {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^"|"$/g, '')
      }
    }
  }
}

const colours = ['#e74c3c', '#3b82f6', '#8b5cf6', '#dc2626', '#22c55e', '#f59e0b', '#60a5fa', '#334155']
const FPL_SEASON = process.env.FPL_SEASON || '2026/27'

import { getDb } from './db.mjs'
import { migrateDatabase } from './db-migrate.mjs'
import { fetchManagerPayload, fetchManagerRankHistory, getCurrentManager, importManagerPayload, linkManagerAccount, unlinkCurrentManager, updateManagerAssumptions } from './manager-service.mjs'
import { createPlan, getActivePlan, selectPlan } from './plan-service.mjs'
import { createRecommendationSet } from './recommendation-service.mjs'
import { evaluateDecision, listDecisions, recordDecision } from './decision-journal-service.mjs'
import { getUserState, updateAiState, updateUserState } from './user-state-service.mjs'
import { assembleProjectionInputCatalog, projectionCatalogInputVersions } from '../src/server/catalog-service.ts'
import { runBacktest } from '../src/server/backtest-service.ts'
import { baseRole, createForecastRun, latestForecastSummary } from '../src/server/forecast-service.ts'
import { CatalogueCache, catalogueCacheKey, catalogueRequestKey } from '../src/server/catalog-cache.ts'
import { ConcurrencyLimiter, TtlCache } from '../src/server/upstream-control.ts'
import { HttpRequestError, MAX_JSON_BODY_BYTES, readJsonBody, sanitizeError } from '../src/server/http-security.mjs'
import { createPlayerSignal, deletePlayerSignal, listPlayerSignals, revisePlayerSignalInterpretation, updatePlayerSignalStatuses } from '../src/server/signal-service.ts'
import { getRemoteSignalFeed } from '../src/server/remote-signal-service.ts'
import { failFeedRun, latestSuccessfulFeedRun, startFeedRun, succeedFeedRun } from './feed-run.mjs'
import { nextIngestSchedule, parseIngestIntervalHours } from '../src/server/ingest-scheduler.ts'
import { addCreatorSource, deleteCreatorSource, getCreatorVideoDetail, listCreatorSources, pollCreatorSources, processCreatorQueue, retryCreatorVideo, setCreatorSourceEnabled, transcriptForPrompt } from './creator-feed-service.mjs'
import { addRssSource, deleteRssSource, listRssSources, pollRssSources, processRssQueue, setRssSourceEnabled } from './rss-feed-service.mjs'
import { callDeepSeekCompletion } from './deepseek-client.mjs'

let systemStatus = {
  status: 'initializing',
  isSeeding: false,
  isIngesting: false,
  isRecalculating: false,
  recomputeMessage: null,
  lastForecastRunId: null,
  message: 'Initializing database schema...',
  playerCount: 0,
  lastIngestedAt: null,
  nextIngestAt: null,
  ingestIntervalHours: 12,
  scheduledRefreshes: {
    official: { enabled: true, available: true, intervalHours: 12, lastRefreshedAt: null, nextRefreshAt: null },
    underlying: { enabled: true, available: true, intervalHours: 24, lastRefreshedAt: null, nextRefreshAt: null },
    market: { enabled: true, available: false, intervalHours: 6, lastRefreshedAt: null, nextRefreshAt: null },
    manager: { enabled: true, available: false, intervalHours: 12, lastRefreshedAt: null, nextRefreshAt: null },
    creator: { enabled: true, available: true, intervalHours: 0.5, lastRefreshedAt: null, nextRefreshAt: null },
    rss: { enabled: true, available: true, intervalHours: 0.5, lastRefreshedAt: null, nextRefreshAt: null },
  },
}

// Debounced in-process forecast recompute triggered after signal approvals.
// It rebuilds an immutable ForecastRun from the current stored catalogue
// (no upstream FPL network fetch) so approved role evidence is reflected in
// stored projections that drive transfer recommendations.
const RECOMPUTE_DEBOUNCE_MS = 3000
let recomputeRunning = false
let recomputeQueued = false
let recomputeLastTriggeredAt = 0

let scheduledIngestTimer = null
const scheduledAuxiliaryTimers = new Map()
const INGEST_RETRY_DELAY_MS = 15 * 60 * 1000
const MAX_TIMER_DELAY_MS = 2_147_483_647

const adminOperations = Object.fromEntries(['fpl-sync', 'signals-sync', 'odds-sync', 'team-refresh', 'creator-sync', 'rss-sync', 'relink-player-teams'].map(id => [id, {
  id, status: 'IDLE', startedAt: null, finishedAt: null, message: null, error: null,
}]))

function adminOperationRunning() {
  return Object.values(adminOperations).some(operation => operation.status === 'RUNNING')
}

function publicAdminOperations() {
  return Object.values(adminOperations).map(operation => ({ ...operation }))
}

function setAdminOperation(id, update) {
  Object.assign(adminOperations[id], update)
}

function runChildScript(script, args = [], environment = {}) {
  return new Promise((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => {
      execFile(process.execPath, ['--experimental-strip-types', path.resolve(script), ...args], { env: { ...process.env, ...environment } }, (error, stdout, stderr) => {
        if (error) {
          const lines = `${stderr || ''}\n${stdout || ''}`.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
          const failure = [...lines].reverse().find(line => /\b(failed|failure|error):/i.test(line))
          const actionable = failure || lines.filter(line => !/ExperimentalWarning|trace-warnings|^\(node:\d+\)/.test(line)).join(' ') || error.message
          reject(new Error(sanitizeError(actionable)))
        }
        else resolve(String(stdout || '').trim())
      })
    }).catch(reject)
  })
}

function startAdminOperation(id, work) {
  if (adminOperationRunning()) return false
  const startedAt = new Date().toISOString()
  let operationSucceeded = false
  setAdminOperation(id, { status: 'RUNNING', startedAt, finishedAt: null, message: 'Operation started', error: null })
  void work().then(result => {
    operationSucceeded = true
    setAdminOperation(id, { status: 'SUCCEEDED', finishedAt: new Date().toISOString(), message: result || 'Operation completed', error: null })
  }).catch(error => {
    setAdminOperation(id, { status: 'FAILED', finishedAt: new Date().toISOString(), message: null, error: sanitizeError(error) })
  }).finally(() => {
    scheduleAuxiliaryRefreshes({ retryOperationId: operationSucceeded ? null : id }).catch(error => console.error('⚠️ Could not update auxiliary refresh schedules:', sanitizeError(error)))
  })
  return true
}


function clearScheduledIngestion() {
  if (scheduledIngestTimer) clearTimeout(scheduledIngestTimer)
  scheduledIngestTimer = null
}

function configureScheduledIngestion() {
  const hours = parseIngestIntervalHours(process.env.FPL_INGEST_INTERVAL_HOURS)
  systemStatus.ingestIntervalHours = hours
  systemStatus.scheduledRefreshes.official.intervalHours = hours
  systemStatus.scheduledRefreshes.official.enabled = hours > 0
  systemStatus.scheduledRefreshes.underlying.intervalHours = parseIngestIntervalHours(process.env.UNDERLYING_INGEST_INTERVAL_HOURS, 24)
  systemStatus.scheduledRefreshes.underlying.enabled = systemStatus.scheduledRefreshes.underlying.intervalHours > 0
  systemStatus.scheduledRefreshes.market.intervalHours = parseIngestIntervalHours(process.env.MARKET_INGEST_INTERVAL_HOURS, 6)
  systemStatus.scheduledRefreshes.market.enabled = systemStatus.scheduledRefreshes.market.intervalHours > 0
  systemStatus.scheduledRefreshes.manager.intervalHours = parseIngestIntervalHours(process.env.MANAGER_REFRESH_INTERVAL_HOURS, 12)
  systemStatus.scheduledRefreshes.manager.enabled = systemStatus.scheduledRefreshes.manager.intervalHours > 0
  systemStatus.scheduledRefreshes.creator.intervalHours = parseIngestIntervalHours(process.env.CREATOR_INGEST_INTERVAL_HOURS, .5)
  systemStatus.scheduledRefreshes.creator.enabled = systemStatus.scheduledRefreshes.creator.intervalHours > 0
  systemStatus.scheduledRefreshes.rss.intervalHours = parseIngestIntervalHours(process.env.RSS_INGEST_INTERVAL_HOURS, .5)
  systemStatus.scheduledRefreshes.rss.enabled = systemStatus.scheduledRefreshes.rss.intervalHours > 0
  if (hours <= 0) {
    console.log('⏱️ Periodic FPL ingestion is disabled (FPL_INGEST_INTERVAL_HOURS=0).')
    systemStatus.nextIngestAt = null
    systemStatus.scheduledRefreshes.official.nextRefreshAt = null
    return
  }
  console.log(`⏱️ Periodic FPL ingestion is enabled every ${hours} hour(s).`)
}

async function scheduleNextIngestion({ notBefore = 0 } = {}) {
  clearScheduledIngestion()
  const hours = systemStatus.ingestIntervalHours
  if (!(hours > 0)) {
    systemStatus.nextIngestAt = null
    systemStatus.scheduledRefreshes.official.nextRefreshAt = null
    return
  }
  const latest = await latestSuccessfulFeedRun(await getDb(), 'OFFICIAL_FPL')
  const completedAt = latest?.finished_at || latest?.started_at || null
  const schedule = nextIngestSchedule(completedAt, hours, Date.now(), notBefore)
  systemStatus.lastIngestedAt = schedule.lastIngestedAt
  systemStatus.nextIngestAt = schedule.nextIngestAt
  Object.assign(systemStatus.scheduledRefreshes.official, { available: true, lastRefreshedAt: schedule.lastIngestedAt, nextRefreshAt: schedule.nextIngestAt })
  console.log(`⏱️ Next FPL ingestion scheduled for ${systemStatus.nextIngestAt}.`)
  scheduledIngestTimer = setTimeout(async () => {
    scheduledIngestTimer = null
    // Node timers have a maximum delay. Re-evaluate instead of firing early
    // when an unusually long configured interval exceeds that limit.
    if (Date.now() + 1_000 < Date.parse(systemStatus.nextIngestAt)) {
      await scheduleNextIngestion()
      return
    }
    if (systemStatus.isSeeding || systemStatus.isIngesting || adminOperationRunning()) {
      console.log('⏱️ Scheduled ingestion deferred (ingestion already in progress).')
      await scheduleNextIngestion({ notBefore: Date.now() + 60_000 })
      return
    }
    console.log('⏱️ Starting scheduled periodic FPL ingestion...')
    const triggered = await triggerBackgroundIngest()
    if (!triggered) await scheduleNextIngestion({ notBefore: Date.now() + 60_000 })
  }, Math.min(schedule.delayMs, MAX_TIMER_DELAY_MS))
}

function clearAuxiliaryTimer(id) {
  const timer = scheduledAuxiliaryTimers.get(id)
  if (timer) clearTimeout(timer)
  scheduledAuxiliaryTimers.delete(id)
}

function auxiliaryRefreshDefinition(id) {
  if (id === 'creator') return {
    operationId: 'creator-sync',
    source: null,
    label: 'YouTube creator feeds',
    lastCompleted: async () => {
      // A successful empty poll creates no CreatorVideo row, so deriving the
      // schedule from videos would immediately re-run the poll forever.
      const latest = await latestSuccessfulFeedRun(await getDb(), 'CREATOR')
      return latest?.finished_at || latest?.started_at || null
    },
    work: refreshNativeCreatorFeeds,
  }
  if (id === 'rss') return {
    operationId: 'rss-sync', source: null, label: 'RSS feeds',
    lastCompleted: async () => (await (await getDb()).query(`SELECT MAX("last_polled_at") AS completed_at FROM "RssSource"`)).rows[0]?.completed_at || null,
    notBefore: async () => (await (await getDb()).query(`SELECT MIN("next_poll_at") AS next_poll_at FROM "RssSource" WHERE "enabled"=1 AND "next_poll_at" IS NOT NULL`)).rows[0]?.next_poll_at || null,
    work: refreshRssFeeds,
  }
  if (id === 'underlying') return {
    operationId: 'signals-sync',
    source: 'UNDERLYING',
    label: 'Understat performance',
    work: async () => {
      const output = await runChildScript('scripts/ingest-signals.mjs', ['--underlying-only'])
      const forecast = await runChildScript('scripts/create-forecast-run.mjs')
      return `${output} ${forecast}`.trim()
    },
  }
  if (id === 'market') return {
    operationId: 'odds-sync',
    source: 'MARKET',
    label: 'betting market',
    work: async () => {
      const output = await runChildScript('scripts/ingest-signals.mjs', ['--market-only'])
      const forecast = await runChildScript('scripts/create-forecast-run.mjs')
      return `${output} ${forecast}`.trim()
    },
  }
  return { operationId: 'team-refresh', source: null, label: 'linked manager', work: refreshLinkedManagerTeam }
}

async function scheduleAuxiliaryRefresh(id, { notBefore = 0 } = {}) {
  clearAuxiliaryTimer(id)
  const state = systemStatus.scheduledRefreshes[id]
  if (!state?.enabled) {
    if (state) Object.assign(state, { available: id !== 'market' || Boolean(String(process.env.ODDS_API_KEY || '').trim()), nextRefreshAt: null })
    return
  }

  const definition = auxiliaryRefreshDefinition(id)
  if (definition.notBefore) {
    const deferredUntil = Date.parse(await definition.notBefore())
    if (Number.isFinite(deferredUntil)) notBefore = Math.max(notBefore, deferredUntil)
  }
  let completedAt = null
  if (id === 'creator' || id === 'rss') {
    const table = id === 'creator' ? 'CreatorSource' : 'RssSource'
    const sources = await (await getDb()).query(`SELECT COUNT(*) AS count FROM "${table}" WHERE "enabled"=1`)
    if (!Number(sources.rows[0]?.count || 0)) {
      Object.assign(state, { available: false, lastRefreshedAt: null, nextRefreshAt: null })
      return
    }
  }
  if (id === 'market' && !String(process.env.ODDS_API_KEY || '').trim()) {
    Object.assign(state, { available: false, lastRefreshedAt: null, nextRefreshAt: null })
    return
  }
  if (definition.lastCompleted) {
    completedAt = await definition.lastCompleted()
  } else if (id === 'manager') {
    const manager = await getCurrentManager(await getDb()).catch(() => null)
    completedAt = manager?.account?.lastSynced || null
    if (!manager?.account?.teamId) {
      Object.assign(state, { available: false, lastRefreshedAt: null, nextRefreshAt: null })
      return
    }
  } else {
    const latest = await latestSuccessfulFeedRun(await getDb(), definition.source)
    completedAt = latest?.finished_at || latest?.started_at || null
  }

  const schedule = nextIngestSchedule(completedAt, state.intervalHours, Date.now(), notBefore)
  Object.assign(state, { available: true, lastRefreshedAt: schedule.lastIngestedAt, nextRefreshAt: schedule.nextIngestAt })
  console.log(`⏱️ Next ${definition.label} refresh scheduled for ${schedule.nextIngestAt}.`)
  const timer = setTimeout(async () => {
    scheduledAuxiliaryTimers.delete(id)
    if (systemStatus.isSeeding || systemStatus.isIngesting || adminOperationRunning()) {
      await scheduleAuxiliaryRefresh(id, { notBefore: Date.now() + 60_000 })
      return
    }
    console.log(`⏱️ Starting scheduled ${definition.label} refresh...`)
    if (!startAdminOperation(definition.operationId, definition.work)) {
      await scheduleAuxiliaryRefresh(id, { notBefore: Date.now() + 60_000 })
    }
  }, Math.min(schedule.delayMs, MAX_TIMER_DELAY_MS))
  scheduledAuxiliaryTimers.set(id, timer)
}

async function scheduleAuxiliaryRefreshes({ retryOperationId = null } = {}) {
  await Promise.all(['underlying', 'market', 'manager', 'creator', 'rss'].map(id => {
    const definition = auxiliaryRefreshDefinition(id)
    const notBefore = definition.operationId === retryOperationId ? Date.now() + INGEST_RETRY_DELAY_MS : 0
    return scheduleAuxiliaryRefresh(id, { notBefore })
  }))
}

async function performColdStartInitialization() {
  try {
    console.log('🚀 Ensuring database schema...')
    await migrateDatabase()
    const db = await getDb()
    const result = await db.query('SELECT COUNT(*) as count FROM "Player"').catch(() => ({ rows: [{ count: 0 }] }))
    const count = Number(result.rows[0]?.count || 0)
    systemStatus.playerCount = count
    configureScheduledIngestion()

    if (count === 0) {
      console.log('📦 Cold start: Database is unseeded. Starting background live FPL ingestion...')
      systemStatus.status = 'seeding'
      systemStatus.isSeeding = true
      systemStatus.message = 'Seeding initial FPL data in background...'
      triggerBackgroundIngest()
    } else {
      systemStatus.status = 'ready'
      systemStatus.isSeeding = false
      systemStatus.message = `System ready with ${count} players.`
      console.log(`✅ Database ready (${count} players loaded).`)
      await scheduleNextIngestion()
      await scheduleAuxiliaryRefreshes()
    }
  } catch (err) {
    console.error('⚠️ Cold-start setup warning:', sanitizeError(err))
    systemStatus.status = 'error'
    systemStatus.message = `Initialization note: ${err.message}`
  }
}

async function triggerBackgroundIngest() {
  if (systemStatus.isIngesting) {
    console.log('⚠️ Background ingestion launch skipped: Ingestion already in progress.')
    return false
  }
  try {
    clearScheduledIngestion()
    systemStatus.nextIngestAt = null
    systemStatus.isIngesting = true
    const { execFile } = await import('node:child_process')
    const scriptPath = path.resolve('scripts/ingest-fpl.mjs')
    execFile(process.execPath, ['--experimental-strip-types', scriptPath], async (error) => {
      systemStatus.isIngesting = false
      if (error) {
        console.error('⚠️ Background FPL ingestion note:', sanitizeError(error))
        systemStatus.status = 'error'
        systemStatus.isSeeding = false
        systemStatus.message = `Ingestion error: ${sanitizeError(error)}`
        await scheduleNextIngestion({ notBefore: Date.now() + INGEST_RETRY_DELAY_MS }).catch(scheduleError => console.error('⚠️ Could not schedule ingestion retry:', sanitizeError(scheduleError)))
      } else {
        console.log('✅ Background FPL ingestion completed.')
        systemStatus.status = 'ready'
        systemStatus.isSeeding = false
        systemStatus.message = 'Live FPL data ingested successfully.'
        try {
          const db = await getDb()
          const result = await db.query('SELECT COUNT(*) as count FROM "Player"').catch(() => ({ rows: [{ count: 0 }] }))
          systemStatus.playerCount = Number(result.rows[0]?.count || 0)
        } catch {}
        await scheduleNextIngestion().catch(scheduleError => console.error('⚠️ Could not schedule next ingestion:', sanitizeError(scheduleError)))
        await scheduleAuxiliaryRefreshes().catch(scheduleError => console.error('⚠️ Could not schedule auxiliary ingestion:', sanitizeError(scheduleError)))
      }
    })
    return true
  } catch (err) {
    systemStatus.isIngesting = false
    console.error('⚠️ Background ingestion launch error:', sanitizeError(err))
    systemStatus.status = 'ready'
    systemStatus.isSeeding = false
    await scheduleNextIngestion({ notBefore: Date.now() + INGEST_RETRY_DELAY_MS }).catch(scheduleError => console.error('⚠️ Could not schedule ingestion retry:', sanitizeError(scheduleError)))
    return false
  }
}

async function triggerForecastRecompute() {
  if (systemStatus.isIngesting || systemStatus.isSeeding) return { status: 'blocked', message: 'FPL ingestion is already in progress; wait for it to finish.' }
  recomputeLastTriggeredAt = Date.now()
  recomputeQueued = true
  // Return quickly; the debounce loop below drains into a single background job.
  if (recomputeRunning) return { status: 'queued', message: 'A forecast recompute is already running; the latest approved signals will be included.' }
  recomputeRunning = true
  systemStatus.isRecalculating = true
  systemStatus.recomputeMessage = 'Rebuilding projections from the latest approved signals...'
  systemStatus.recomputeError = null
  void (async () => {
    while (recomputeQueued) {
      // Debounce bursts of approvals so a batch produces a single forecast run.
      const idleMs = Date.now() - recomputeLastTriggeredAt
      if (idleMs < RECOMPUTE_DEBOUNCE_MS) {
        await new Promise(resolve => setTimeout(resolve, RECOMPUTE_DEBOUNCE_MS - idleMs))
        continue
      }
      recomputeQueued = false
      try {
        const db = await getDb()
        const result = await createForecastRun(db, { asOf: new Date().toISOString() })
        systemStatus.lastForecastRunId = result.id
        systemStatus.recomputeError = null
      } catch (error) {
        systemStatus.recomputeError = sanitizeError(error)
        console.error('⚠️ Signal-triggered forecast recompute failed:', sanitizeError(error))
      }
    }
    recomputeRunning = false
    systemStatus.isRecalculating = false
    systemStatus.recomputeMessage = null
  })()
  return { status: 'started', message: 'Forecast recompute scheduled.' }
}

function readRequestBody(req) { return readJsonBody(req) }

function errorStatus(error, fallback = 500) {
  return error instanceof HttpRequestError ? error.status : fallback
}

function responseEtag(body) {
  return `"${createHash('sha256').update(body).digest('base64url')}"`
}

function sendBody(res, status, body, headers = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body)
  if (status === 200 && headers.etag && res.requestHeaders?.['if-none-match'] === headers.etag) {
    res.writeHead(304, headers).end()
    return
  }
  let output = raw
  if (raw.length >= 1024) {
    headers.vary = headers.vary ? `${headers.vary}, Accept-Encoding` : 'Accept-Encoding'
    if (/\bgzip\b/i.test(String(res.requestHeaders?.['accept-encoding'] || ''))) {
      output = gzipSync(raw, { level: 6 })
      headers['content-encoding'] = 'gzip'
    }
  }
  headers['content-length'] = String(output.length)
  res.writeHead(status, headers).end(output)
}

function sendJson(res,status,payload,options={}){
  let safePayload = payload
  if (status >= 400) {
    const rawError = payload && typeof payload === 'object' ? payload.error : null
    const message = sanitizeError(typeof rawError === 'string' ? rawError : rawError?.message || 'Request failed')
    const code = typeof rawError === 'object' && rawError?.code ? String(rawError.code) : ({ 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 410: 'GONE', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE' })[status] || (status >= 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`)
    const { error: _discardedError, schemaVersion: _discardedVersion, ...context } = payload && typeof payload === 'object' ? payload : {}
    safePayload = { schemaVersion: 1, ...context, error: { code, message, requestId: res.requestId || 'unknown' } }
  }
  const body = Buffer.from(JSON.stringify(safePayload))
  const headers={'content-type':'application/json; charset=utf-8','cache-control':options.cacheControl||'no-store'}
  if(options.etag)headers.etag=responseEtag(body)
  if(res.requestId)headers['x-request-id']=res.requestId
  sendBody(res,status,body,headers)
}

// ── Signal source config (persisted beside the SQLite database) ─────────────
function appDataFile(filename) {
  const rawDatabasePath=process.env.DATABASE_URL||'file:./dev.db'
  const cleanDatabasePath=rawDatabasePath.replace(/^file:\/\//,'').replace(/^file:/,'')
  const resolvedDatabasePath=path.isAbsolute(cleanDatabasePath)?cleanDatabasePath:path.resolve(cleanDatabasePath)
  return path.join(path.dirname(resolvedDatabasePath),filename)
}
const AI_SETTINGS_PATH = process.env.AI_SETTINGS_FILE || appDataFile('ai-settings.json')
const catalogueCache = new CatalogueCache({
  ttlMs: Number(process.env.FPL_CATALOG_CACHE_TTL_MS || 60_000),
  maxStaleMs: Number(process.env.FPL_CATALOG_CACHE_MAX_STALE_MS || 24 * 60 * 60 * 1000),
  filePath: process.env.FPL_CATALOG_CACHE_FILE || appDataFile('cache/projection-catalog.json'),
})
const leagueCache = new TtlCache(5 * 60 * 1000)
const leagueUpstream = new ConcurrencyLimiter(5)

// Fetches a classic league's standings, rival picks/history and effective
// ownership, backed by the short-lived in-process cache shared by the Leagues
// UI and the recommendation engine. By default it samples the first standings
// page (top leaders), so EO is a sampled measure. If youEntry is supplied it
// walks forward through the standings to centre the sample on the manager's own
// rank, so the analytics reflect the people you are actually competing with.
// Fragile fetches degrade to an empty result rather than blocking a
// recommendation.
const STANDINGS_PAGE_SIZE = 50
const STANDINGS_SAMPLE_WINDOW = 35
const STANDINGS_MAX_WALK_PAGES = 20

async function loadLeagueDetailsWithEO(leagueId, requestedGameweek, { youEntry, maxStandingsPages = STANDINGS_MAX_WALK_PAGES } = {}) {
  const gameweek = String(requestedGameweek ?? '')
  const leagueKey = `${leagueId}:${gameweek}`
  const cachedLeague = leagueCache.get(leagueKey)
  if (cachedLeague) return cachedLeague

  const standingsRes = await leagueUpstream.run(() => fetch(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_new_entries=1&page_standings=1`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
  }))
  if (!standingsRes.ok) {
    throw new Error(`FPL league fetch failed: HTTP ${standingsRes.status}`)
  }
  const standingsData = await standingsRes.json()
  let results = standingsData.standings?.results || []
  let isPreSeason = false

  if (results.length === 0 && Array.isArray(standingsData.new_entries?.results) && standingsData.new_entries.results.length > 0) {
    isPreSeason = true
    results = standingsData.new_entries.results.map((item, idx) => ({
      id: item.id || idx + 1,
      event_total: 0,
      player_name: `${item.player_first_name || ''} ${item.player_last_name || ''}`.trim() || item.entry_name || 'Manager',
      rank: idx + 1,
      last_rank: null,
      rank_sort: idx + 1,
      total: 0,
      entry: item.entry,
      entry_name: item.entry_name || `Team #${item.entry}`
    }))
  }

  // If the user's entry isn't on page 1 and the league has more standings pages,
  // walk forward (bounded) until we find them so the sample can centre on the
  // user's rank rather than always the current leaders.
  const numYouEntry = youEntry == null ? null : Number(youEntry)
  let youFoundIndex = numYouEntry == null ? -1 : results.findIndex(r => Number(r.entry) === numYouEntry)
  let sampledAroundYou = numYouEntry != null && youFoundIndex !== -1
  let fetchedPages = 1
  if (numYouEntry != null && youFoundIndex === -1 && !isPreSeason && standingsData.standings?.has_next) {
    for (let page = 2; page <= maxStandingsPages && youFoundIndex === -1; page++) {
      const pageRes = await leagueUpstream.run(() => fetch(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_new_entries=1&page_standings=${page}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
      }))
      fetchedPages += 1
      if (!pageRes.ok) break
      const pageData = await pageRes.json()
      const rows = pageData.standings?.results || []
      if (rows.length === 0) break
      const offsetBefore = results.length
      results = results.concat(rows)
      const hit = rows.findIndex(r => Number(r.entry) === numYouEntry)
      if (hit !== -1) youFoundIndex = offsetBefore + hit
      if (!pageData.standings?.has_next) break
    }
  }

  let topRivals
  if (youFoundIndex !== -1) {
    sampledAroundYou = true
    let start = Math.max(0, youFoundIndex - Math.floor(STANDINGS_SAMPLE_WINDOW / 2))
    start = Math.min(start, Math.max(0, results.length - STANDINGS_SAMPLE_WINDOW))
    topRivals = results.slice(start, start + STANDINGS_SAMPLE_WINDOW)
  } else {
    topRivals = results.slice(0, STANDINGS_SAMPLE_WINDOW)
  }

  const defaultGw = String(requestedGameweek || standingsData.league?.start_event || 1)

  const enrichedRivals = await Promise.all(
    topRivals.map(async (rival) => {
      try {
        const picksRes = await leagueUpstream.run(() => fetch(`https://fantasy.premierleague.com/api/entry/${rival.entry}/event/${defaultGw}/picks/`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
        }))
        const historyRes = await leagueUpstream.run(() => fetch(`https://fantasy.premierleague.com/api/entry/${rival.entry}/history/`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
        }))

        let picksData = null
        let historyData = null
        if (picksRes.ok) picksData = await picksRes.json()
        if (historyRes.ok) historyData = await historyRes.json()

        const entryHistory = picksData?.entry_history || {}
        const seasonHits = Array.isArray(historyData?.current)
          ? historyData.current.reduce((sum, e) => sum + (Number(e.event_transfers_cost) || 0), 0)
          : 0

        return {
          ...rival,
          activeChip: picksData?.active_chip || null,
          eventTransfers: entryHistory.event_transfers || 0,
          eventTransfersCost: entryHistory.event_transfers_cost || 0,
          value: entryHistory.value == null ? null : Number(entryHistory.value) / 10,
          bank: entryHistory.bank == null ? null : Number(entryHistory.bank) / 10,
          seasonHits,
          picks: picksData?.picks || [],
          chipsUsed: historyData?.chips || []
        }
      } catch {
        return {
          ...rival,
          activeChip: null,
          eventTransfers: 0,
          eventTransfersCost: 0,
          value: null,
          bank: null,
          seasonHits: 0,
          picks: [],
          chipsUsed: []
        }
      }
    })
  )

  const playerStatsMap = new Map()
  const totalAnalyzed = enrichedRivals.length || 1

  for (const rival of enrichedRivals) {
    for (const pick of rival.picks) {
      const element = pick.element
      const stat = playerStatsMap.get(element) || { element, ownersCount: 0, captainsCount: 0, tripleCaptainsCount: 0 }
      stat.ownersCount += 1
      if (pick.is_captain) {
        stat.captainsCount += 1
        if (pick.multiplier === 3) {
          stat.tripleCaptainsCount += 1
        }
      }
      playerStatsMap.set(element, stat)
    }
  }

  const effectiveOwnership = Array.from(playerStatsMap.values()).map(stat => {
    const ownershipPercent = (stat.ownersCount / totalAnalyzed) * 100
    const captaincyPercent = (stat.captainsCount / totalAnalyzed) * 100
    const eoPercent = ((stat.ownersCount + stat.captainsCount + stat.tripleCaptainsCount) / totalAnalyzed) * 100
    return {
      ...stat,
      ownershipPercent: Number(ownershipPercent.toFixed(1)),
      captaincyPercent: Number(captaincyPercent.toFixed(1)),
      effectiveOwnership: Number(eoPercent.toFixed(1))
    }
  }).sort((a, b) => b.effectiveOwnership - a.effectiveOwnership)

  // "Template" = the league's most-owned players (top-N by ownership). Each
  // rival's templateCount is how many of their STARTING XI fall inside that
  // consensus set, so you can see who is playing off-template vs the field.
  const TEMPLATE_TOP_N = 15
  const templateElements = new Set(effectiveOwnership.slice(0, TEMPLATE_TOP_N).map(s => s.element))
  for (const rival of enrichedRivals) {
    const starters = (rival.picks || []).filter(p => (p.multiplier || 0) > 0)
    rival.templateCount = starters.filter(p => templateElements.has(p.element)).length
    rival.starterCount = starters.length
  }

  const response = {
      league: standingsData.league,
      standings: enrichedRivals,
      totalAnalyzed,
      sampledManagerCount: enrichedRivals.length,
      totalManagerCount: Number(standingsData.standings?.total_results || results.length),
      pagination: {
        policy: sampledAroundYou ? 'AROUND_RANK' : 'FIRST_PAGE_SAMPLE',
        fetchedPages,
        complete: false
      },
      yourRank: youFoundIndex !== -1 ? youFoundIndex + 1 : null,
      sampledAroundYou: Boolean(sampledAroundYou),
      isPreSeason: Boolean(isPreSeason),
      effectiveOwnership
    }
  leagueCache.set(leagueKey, response)
  return response
}

// Maps a loaded league response to the compact coverage form used by the
// recommendation engine: element(fplId) -> effectiveOwnership fraction.
function leagueCoverageFromResponse(details) {
  const coverageByFplId = new Map()
  for (const stat of details.effectiveOwnership || []) {
    coverageByFplId.set(Number(stat.element), Number((stat.effectiveOwnership / 100).toFixed(4)))
  }
  return { leagueId: Number(details.league?.id), leagueName: details.league?.name || null, coverageByFplId }
}

function loadAiSettings() {
  try {
    if (fs.existsSync(AI_SETTINGS_PATH)) {
      // Existing files are tightened on read to avoid leaving credentials in a
      // world-readable application-data directory after an upgrade.
      fs.chmodSync(AI_SETTINGS_PATH, 0o600)
      return JSON.parse(fs.readFileSync(AI_SETTINGS_PATH, 'utf8'))
    }
  } catch {}
  return { provider: '', apiKey: '' }
}

function saveAiSettings(settings) {
  fs.mkdirSync(path.dirname(AI_SETTINGS_PATH), { recursive: true })
  const temporaryPath = `${AI_SETTINGS_PATH}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(settings, null, 2), { mode: 0o600 })
    fs.chmodSync(temporaryPath, 0o600)
    fs.renameSync(temporaryPath, AI_SETTINGS_PATH)
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }) } catch {}
    throw new Error(`Could not save local AI configuration: ${sanitizeError(error)}`)
  }
}
function bearerToken(req){
  const match=String(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i)
  return match?.[1]||''
}

function tokenMatches(actual,expected){
  if(!actual||!expected)return false
  const left=Buffer.from(actual),right=Buffer.from(expected)
  return left.length===right.length&&timingSafeEqual(left,right)
}

function requireAdminToken(req, res) {
  const expected = process.env.ADMIN_TOKEN || ''
  if (!expected) return true
  if (!tokenMatches(bearerToken(req), expected)) { sendJson(res, 401, { error: 'Invalid admin token' }); return false }
  return true
}

// Remote integrations must fail closed. The local admin UI remains usable
// without a token, but an automation endpoint must never become unauthenticated
// because ADMIN_TOKEN was omitted from the environment.
function requireRemoteToken(req, res) {
  const expected = process.env.ADMIN_TOKEN || ''
  if (!expected) {
    sendJson(res, 503, { error: 'Remote signal API is disabled until ADMIN_TOKEN is configured' })
    return false
  }
  if (!tokenMatches(bearerToken(req), expected)) {
    sendJson(res, 401, { error: 'Invalid admin token' })
    return false
  }
  return true
}

async function refreshLinkedManagerTeam() {
  const db = await getDb()
  const current = await getCurrentManager(db)
  const teamId = current?.account?.teamId
  if (!teamId) throw new Error('No FPL manager team is linked')
  const payload = await fetchManagerPayload({ teamId })
  const imported = await importManagerPayload(db, { ...payload, season: FPL_SEASON })
  return `Refreshed ${imported.account.teamName} with ${imported.squad.length} players`
}

async function refreshSystemPlayerCount(message) {
  const db = await getDb()
  const result = await db.query('SELECT COUNT(*) AS count FROM "Player"')
  systemStatus.playerCount = Number(result.rows[0]?.count || 0)
  systemStatus.status = 'ready'
  systemStatus.message = message
  await scheduleNextIngestion()
  return message
}

async function adminStatusSnapshot() {
  const db = await getDb()
  const [runs, unresolved, manager, aiUsage, aiUsageByFeature, recentAiUsage] = await Promise.all([
    db.query(`SELECT "id","source","status","started_at","finished_at","source_updated_at","payload_hash","request_count","inserted_count","updated_count","unmatched_count","used_cache","cache_captured_at","error_summary","metadata_json"
      FROM "FeedRun" ORDER BY datetime("started_at") DESC, "id" DESC LIMIT 50`),
    db.query(`SELECT
      (SELECT COUNT(*) FROM "UnderlyingObservation" WHERE "match_status" != 'MATCHED' AND "feed_run_id"=(SELECT "id" FROM "FeedRun" WHERE "source"='UNDERLYING' AND "status" IN ('SUCCEEDED','PARTIAL') ORDER BY datetime("started_at") DESC,"id" DESC LIMIT 1)) AS unresolved_players,
      (SELECT COUNT(*) FROM "MarketFixtureObservation" WHERE "fixture_id" IS NULL AND "feed_run_id"=(SELECT "id" FROM "FeedRun" WHERE "source"='MARKET' AND "status" IN ('SUCCEEDED','PARTIAL') ORDER BY datetime("started_at") DESC,"id" DESC LIMIT 1)) AS unresolved_fixtures`),
    getCurrentManager(db).catch(() => null),
    db.query(`SELECT COUNT(*) AS request_count, COALESCE(SUM("input_tokens"), 0) AS input_tokens, COALESCE(SUM("output_tokens"), 0) AS output_tokens, COALESCE(SUM("total_tokens"), 0) AS total_tokens, COALESCE(SUM("web_search_calls"), 0) AS web_search_calls, SUM("estimated_cost_usd") AS estimated_cost_usd FROM "AiUsageEvent"`),
    db.query(`SELECT "feature", COUNT(*) AS request_count, COALESCE(SUM("total_tokens"), 0) AS total_tokens, COALESCE(SUM("estimated_cost_usd"), 0) AS estimated_cost_usd FROM "AiUsageEvent" GROUP BY "feature" ORDER BY total_tokens DESC`),
    db.query(`SELECT "id", "feature", "provider", "model", "total_tokens", "estimated_cost_usd", "created_at" FROM "AiUsageEvent" ORDER BY datetime("created_at") DESC, "id" DESC LIMIT 8`),
  ])
  const usageRow=aiUsage.rows[0]||{}
  return {
    schemaVersion: 1,
    authenticationRequired: Boolean(process.env.ADMIN_TOKEN),
    operations: publicAdminOperations(),
    feedRuns: runs.rows.map(row => ({
      id: row.id,
      source: row.source,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      sourceUpdatedAt: row.source_updated_at,
      payloadHash: row.payload_hash,
      requestCount: Number(row.request_count || 0),
      insertedCount: Number(row.inserted_count),
      updatedCount: Number(row.updated_count),
      unmatchedCount: Number(row.unmatched_count),
      usedCache: Boolean(row.used_cache),
      cacheCapturedAt: row.cache_captured_at,
      error: row.error_summary,
      metadata: parseJson(row.metadata_json, {}),
    })),
    unresolved: { players: Number(unresolved.rows[0]?.unresolved_players || 0), fixtures: Number(unresolved.rows[0]?.unresolved_fixtures || 0) },
    manager: manager?.account ? { teamId: manager.account.teamId, teamName: manager.account.teamName, lastSynced: manager.account.lastSynced, playerCount: manager.squad?.length || 0 } : null,
    oddsConfigured: Boolean(String(process.env.ODDS_API_KEY || '').trim()),
    scheduledRefreshes: systemStatus.scheduledRefreshes,
    aiUsage: {
      requestCount: Number(usageRow.request_count||0), inputTokens: Number(usageRow.input_tokens||0), outputTokens: Number(usageRow.output_tokens||0), totalTokens: Number(usageRow.total_tokens||0), webSearchCalls: Number(usageRow.web_search_calls||0), estimatedCostUsd: usageRow.estimated_cost_usd == null ? null : Number(usageRow.estimated_cost_usd),
      byFeature: aiUsageByFeature.rows.map(row=>({feature:row.feature,requestCount:Number(row.request_count||0),totalTokens:Number(row.total_tokens||0),estimatedCostUsd:Number(row.estimated_cost_usd||0)})),
      recent: recentAiUsage.rows.map(row=>({id:row.id,feature:row.feature,provider:row.provider,model:row.model,totalTokens:Number(row.total_tokens||0),estimatedCostUsd:row.estimated_cost_usd == null ? null : Number(row.estimated_cost_usd),createdAt:row.created_at})),
    },
    season: FPL_SEASON,
  }
}

const parseJson=(value,fallback)=>{
  if(value==null)return fallback
  if(typeof value!=='string')return value
  try{return JSON.parse(value)}catch{return fallback}
}

function compactCandidates(candidates){
  return candidates.map(({player,confidence,reasons})=>({
    playerId:Number(player.id),name:player.name,club:player.club,position:player.position,
    price:Number(player.price),confidence:Number(confidence),reasons,
  }))
}

async function resolveCreatorAmbiguityWithLlm(claim,match){
  if(match.status!=='AMBIGUOUS'||!Array.isArray(match.candidates)||!match.candidates.length)return match
  const candidates=compactCandidates(match.candidates).slice(0,5)
  const prompt=`Resolve one noisy YouTube transcript player name against the supplied current FPL catalog candidates only.
Return JSON: {"playerId": number|null, "confidence": number, "reason": string}.
Choose a player only when the name, club hint, position, price, and evidence make one supplied candidate clearly correct. If the club conflicts, the person is outside FPL, or there is genuine uncertainty, return playerId null. Never invent a player ID.

Transcript name: ${claim.rawPlayerName}
Club hint: ${claim.clubHint||'none'}
Position hint: ${claim.positionHint||'none'}
Price hint: ${claim.priceHint??'none'}
Evidence: ${claim.evidenceText||claim.summary}
Candidates: ${JSON.stringify(candidates)}`
  try{
    const llm=await callLLMProvider(prompt,{rawJson:true,maxOutputTokens:180})
    await recordAiUsage({feature:'YOUTUBE_EXTRACTION',result:llm})
    const parsed=JSON.parse(String(llm?.answer||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''))
    const confidence=Number(parsed?.confidence)
    const candidate=candidates.find(item=>Number(item.playerId)===Number(parsed?.playerId))
    if(candidate&&Number.isFinite(confidence)&&confidence>=.92){
      const player=match.candidates.find(item=>Number(item.player?.id)===Number(candidate.playerId))?.player
      if(player)return {status:'MATCHED',player,confidence:Math.min(1,confidence),candidates:match.candidates,reason:`LLM re-ranker: ${String(parsed.reason||'catalog-constrained high-confidence match').slice(0,300)}`}
    }
  }catch{}
  return match
}

function validityDeadline(timeHorizon){
  const normalized=String(timeHorizon||'').toUpperCase().replace(/\s+/g,'')
  const gw=normalized.match(/^GW(\d+)$/)
  const days=gw?Math.max(7,Number(gw[1])*7):({SHORT_TERM:14,MEDIUM_TERM:42,SEASON:120,UNKNOWN:14}[normalized]||14)
  return new Date(Date.now()+days*24*60*60*1000).toISOString()
}

async function createSignalForCreatorClaim(db,claimRow,source,gameweek){
  const signalValue=parseJson(claimRow.signalValue,{})
  const rawDraft=signalDraftFromClaim({...claimRow,...signalValue,numericClaims:parseJson(claimRow.numericClaims,[]),relatedMentions:parseJson(claimRow.relatedMentions,[])},Number(claimRow.resolvedPlayerId),source)
  const recencyDays={INJURY:10,ROLE:14,ROTATION:14,TACTICS:14,PRESEASON:14}
  const publishedAt=rawDraft.sourceDate?Date.parse(rawDraft.sourceDate):NaN
  const ageDays=Number.isFinite(publishedAt)?(Date.now()-publishedAt)/86400000:Infinity
  const roleIsFresh=rawDraft.modelImpact!=='ROLE'||(Number.isFinite(publishedAt)&&ageDays>=-1&&ageDays<=(recencyDays[claimRow.category]||14))
  const draft=roleIsFresh?rawDraft:{...rawDraft,modelImpact:'NONE',value:{note:rawDraft.value.note},interpretationRationale:'The source date is missing or stale for a role-changing claim; retained as context only.'}
  const confidence=Math.max(0,Math.min(1,Number(draft.confidence)||.65))
  const status=shouldAutoApproveCreatorContext(draft)?'VERIFIED':'PENDING'
  const observedAt=new Date().toISOString()
  const id=`creator:${String(claimRow.externalClaimId||claimRow.id).slice(0,220)}`
  const existing=await listPlayerSignals(db,{playerId:draft.playerId,limit:500})
  if(existing.some(signal=>signal.id===id))return {signal:existing.find(signal=>signal.id===id),created:false}
  const horizonMatch=String(claimRow.timeHorizon||'').toUpperCase().match(/^GW\s*(\d+)$/)
  const applicableGameweek=horizonMatch?Number(horizonMatch[1]):null
  const signal=await createPlayerSignal(db,{id,playerId:draft.playerId,gameweek:applicableGameweek,kind:draft.kind,value:draft.value,sourceType:draft.sourceType,sourceUrl:draft.sourceUrl,evidenceSummary:draft.evidenceSummary,evidenceText:draft.evidenceText,claimClass:draft.claimClass,modelImpact:draft.modelImpact,interpretationRationale:draft.interpretationRationale,interpretationConfidence:draft.interpretationConfidence,confidence,observedAt,validUntil:validityDeadline(claimRow.timeHorizon),status,actorType:'INGESTION',sourceDate:draft.sourceDate})
  if(draft.claimClass==='PERFORMANCE_FORECAST'&&draft.value.forecastMetric&&draft.value.forecastDirection&&draft.value.forecastProbability!=null){
    await db.query(`INSERT INTO "CreatorForecastOutcome" ("signal_id","creator","external_source_id","target_metric","direction","probability","horizon","observed_at") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("signal_id") DO NOTHING`,[
      String(signal.id),source.creator||'Unknown creator',source.externalId||'',draft.value.forecastMetric,draft.value.forecastDirection,Number(draft.value.forecastProbability),draft.value.forecastHorizon||claimRow.timeHorizon||'UNKNOWN',observedAt,
    ])
  }
  return {signal,created:true}
}

async function creatorAliases(db){
  const result=await db.query(`SELECT alias."alias", player."fpl_id" FROM "PlayerAlias" alias JOIN "Player" player ON player."id"=alias."player_id"`)
  return result.rows.map(row=>({alias:row.alias,playerId:Number(row.fpl_id)}))
}

async function saveUnmatchedCreatorClaim(db,claim,source,match,candidates){
  const now=new Date().toISOString(),id=String(claim.externalClaimId)
  await db.query(`INSERT INTO "CreatorClaim" ("id","platform","external_source_id","raw_player_name","normalized_player_name","club_hint","position_hint","category","sentiment","summary","timestamp_seconds","time_horizon","claim_json","source_json","match_status","match_confidence","candidates_json","created_at","updated_at")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
    ON CONFLICT ("id") DO UPDATE SET "match_status"=excluded."match_status","match_confidence"=excluded."match_confidence","candidates_json"=excluded."candidates_json","claim_json"=excluded."claim_json","source_json"=excluded."source_json","updated_at"=excluded."updated_at"`,[
      id,source.platform,source.externalId,claim.rawPlayerName,normalizeEntityText(claim.rawPlayerName),claim.clubHint||null,claim.positionHint||null,claim.category,claim.sentiment,claim.summary,claim.timestampSeconds??null,claim.timeHorizon||null,JSON.stringify(claim),JSON.stringify(source),match.status,Number(match.confidence||0),JSON.stringify(candidates),now,
    ])
}

function creatorClaimView(row){
  const source=parseJson(row.source_json,{})
  const claim=parseJson(row.claim_json,{})
  return {id:row.id,rawPlayerName:row.raw_player_name,clubHint:row.club_hint,positionHint:row.position_hint,category:row.category,sentiment:row.sentiment,summary:row.summary,matchStatus:row.match_status,matchConfidence:Number(row.match_confidence||0),matchCandidates:parseJson(row.candidates_json,[]),creator:source.creator||'Unknown creator',contentTitle:source.title||'Untitled source',contentUrl:source.url||'',timestampSeconds:row.timestamp_seconds==null?null:Number(row.timestamp_seconds),createdAt:row.created_at||null,signalId:row.signal_id||null,forecastMetric:claim.forecastMetric||null,forecastDirection:claim.forecastDirection||null,forecastProbability:claim.forecastProbability==null?null:Number(claim.forecastProbability),forecastHorizon:claim.forecastHorizon||claim.timeHorizon||null}
}

async function unresolvedCreatorClaims(db,limit=200){
  const result=await db.query(`SELECT * FROM "CreatorClaim" WHERE "match_status" IN ('AMBIGUOUS','UNRESOLVED') ORDER BY datetime("created_at") DESC LIMIT $1`,[Math.max(1,Math.min(500,Number(limit)||200))])
  return result.rows.map(creatorClaimView)
}

async function resolveCreatorClaim(db, id, { playerId, rememberAlias = true } = {}) {
  const claimResult=await db.query(`SELECT * FROM "CreatorClaim" WHERE "id"=$1 LIMIT 1`,[id])
  const row=claimResult.rows[0]
  if(!row)throw new Error('Creator claim not found')
  const fplId=Number(playerId)
  if(!Number.isInteger(fplId)||fplId<=0)throw new Error('playerId is required')
  const playerResult=await db.query(`SELECT "id","fpl_id" FROM "Player" WHERE "fpl_id"=$1 ORDER BY "season" DESC LIMIT 1`,[fplId])
  const player=playerResult.rows[0]
  if(!player)throw new Error('Player not found')
  const now=new Date().toISOString(),claim=parseJson(row.claim_json,{}),source=parseJson(row.source_json,{})
  const signalValue=Object.fromEntries(['startProbability','minutesIfStarting','substituteProbabilityWhenBenched','minutesIfSubstitute','depthRole','forecastMetric','forecastDirection','forecastProbability','forecastHorizon','confidence'].filter(key=>claim[key]!=null).map(key=>[key,claim[key]]))
  const result=await createSignalForCreatorClaim(db,{...claim,id,externalClaimId:id,resolvedPlayerId:Number(player.fpl_id),signalValue},source,null)
  if(rememberAlias&&normalizeEntityText(row.raw_player_name)){
    await db.query(`INSERT INTO "PlayerAlias" ("id","alias","normalized_alias","player_id","source","created_at","updated_at") VALUES ($1,$2,$3,$4,'USER',$5,$5) ON CONFLICT ("normalized_alias") DO UPDATE SET "player_id"=excluded."player_id","alias"=excluded."alias","updated_at"=excluded."updated_at"`,[randomUUID(),row.raw_player_name,normalizeEntityText(row.raw_player_name),player.id,now])
  }
  await db.query(`UPDATE "CreatorClaim" SET "match_status"='RESOLVED',"resolved_player_id"=$2,"signal_id"=$3,"updated_at"=$4 WHERE "id"=$1`,[id,player.id,String(result.signal.id),now])
  return {claimId:id,signal:result.signal,rememberedAlias:rememberAlias}
}

function safeContextValue(signal) {
  const value=signal?.value&&typeof signal.value==='object'?signal.value:{}
  return Object.fromEntries(['note','forecastMetric','forecastDirection','forecastProbability','forecastHorizon'].filter(key=>value[key]!=null).map(key=>[key,value[key]]))
}

async function reprocessRemoteSignal(db, signal, { includeVerified = false } = {}) {
  if(signal.status!=='PENDING'&&!includeVerified)return {signal,changed:false,reason:'not_pending'}
  const roleKinds=new Set(['EXPECTED_ROLE','DEPTH_CHART','TACTICAL_ROLE','PRESEASON_MINUTES','INJURY'])
  const roleClasses=new Set(['REAL_WORLD_ROLE','ROTATION','INJURY','AVAILABILITY'])
  const text=`${signal.evidenceSummary||''} ${signal.evidenceText||''}`
  const roleEvidence=/\b(?:first[ -]?choice|regular starter|starting (?:xi|line[- ]?up|striker|keeper)|number one|no real competition|nailed|set to start|likely to start|expected to start|not expected to|regular starts?|rotation|rotat(?:e|ion)|one of two|compete? for minutes|competition for minutes|may not start|unavailable|ruled out|will miss|out for|back[ -]?up|third[ -]?choice)\b/i.test(text)
  const unavailableEvidence=/\b(?:ruled out|unavailable|will miss|going to miss|set to miss|out for (?:weeks|months)|miss the start of the season)\b/i.test(text)
  const roleAllowed=roleKinds.has(signal.kind)&&roleClasses.has(signal.claimClass)&&roleEvidence&&(signal.kind!=='INJURY'||unavailableEvidence)
  const sourceDate=signal.sourceDate?Date.parse(signal.sourceDate):NaN
  const maxAgeDays=signal.kind==='INJURY'?10:14
  const fresh=Number.isFinite(sourceDate)&&(Date.now()-sourceDate)>=-86400000&&(Date.now()-sourceDate)<=maxAgeDays*86400000
  if(roleAllowed&&fresh)return {signal,changed:false,reason:'role_evidence_is_current'}
  const safeKinds=new Set(['VALUE_OPINION','TRANSFER_OPINION','STATISTICAL_CLAIM','PERFORMANCE_FORECAST'])
  const finalize=safeKinds.has(signal.kind)||['VALUE_OPINION','STATISTICAL_CONTEXT','FPL_SELECTION','CREATOR_RATING'].includes(signal.claimClass)
  const updated=await revisePlayerSignalInterpretation(db,signal.id,{modelImpact:'NONE',value:safeContextValue(signal),rationale:'Remote reprocess: unsupported, ambiguous, or stale role evidence was retained as context only.',finalizeContext:finalize})
  return {signal:updated,changed:true,reason:finalize?'context_finalized':'role_downgraded_pending'}
}

async function processCreatorPayload(rawPayload){
  const payload=normalizeCreatorPayload(rawPayload),db=await getDb(),data=await liveData()
  const aliases=await creatorAliases(db)
  const contentId=`${payload.source.platform}:${payload.source.externalId}`
  const results=[]
  for(const claim of payload.claims){
    let match=matchCreatorClaim(claim,data.players,aliases)
    match=await resolveCreatorAmbiguityWithLlm(claim,match)
    const resolvedPlayerId=match.player?.id||null
    const signalValue=Object.fromEntries(['startProbability','minutesIfStarting','substituteProbabilityWhenBenched','minutesIfSubstitute','depthRole','forecastMetric','forecastDirection','forecastProbability','forecastHorizon','confidence'].filter(key=>claim[key]!=null).map(key=>[key,claim[key]]))
    const candidates=Array.isArray(match.candidates)&&match.candidates[0]?.player?compactCandidates(match.candidates):match.candidates||[]
    let signalResult=null
    if(match.status==='MATCHED'&&resolvedPlayerId){
      signalResult=await createSignalForCreatorClaim(db,{...claim,id:claim.externalClaimId,externalClaimId:claim.externalClaimId,resolvedPlayerId,signalValue},payload.source,data.currentGameweek)
    }else{
      await saveUnmatchedCreatorClaim(db,claim,payload.source,match,candidates)
    }
    results.push({id:claim.externalClaimId,rawPlayerName:claim.rawPlayerName,matchStatus:match.status,resolvedPlayerId,confidence:match.confidence,candidates,signalId:signalResult?.signal?.id||null,created:Boolean(signalResult?.created)})
  }
  const unresolved=results.filter(row=>row.matchStatus==='AMBIGUOUS'||row.matchStatus==='UNRESOLVED').length
  return {contentId,created:results.filter(row=>row.created).length,matched:results.length-unresolved,unresolved,claims:results}
}

function parseCreatorExtraction(value){
  const cleaned=String(value||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')
  const parsed=JSON.parse(cleaned)
  if(!parsed||typeof parsed!=='object'||!Array.isArray(parsed.claims))throw new Error('LLM extraction did not return a claims array')
  return parsed
}

function creatorExtractionPrompt(video,transcript){
  return `Extract only FPL-relevant, player-specific claims from this timestamped YouTube transcript.
Return JSON with one property, "claims", containing at most 20 objects. Each object must contain:
rawPlayerName, clubHint (string or null), positionHint (GK/DEF/MID/FWD or null), category (ROLE, ROTATION, INJURY, SET_PIECES, PENALTIES, PRESEASON, TACTICS, VALUE, STATS, TRANSFER, FPL_SELECTION, PERFORMANCE_FORECAST, or OTHER), sentiment (POSITIVE, NEGATIVE, MIXED, or NEUTRAL), summary, evidenceText, timestampSeconds, timeHorizon (GW<number>, SHORT_TERM, MEDIUM_TERM, SEASON, or UNKNOWN), and confidence (0 to 1).
Optional fields are depthRole (FIRST_CHOICE, ROTATION, BACKUP, OUT), startProbability, minutesIfStarting, substituteProbabilityWhenBenched, minutesIfSubstitute, numericClaims, and relatedMentions.
For PERFORMANCE_FORECAST claims, also provide forecastMetric (EXPECTED_POINTS or PRICE), forecastDirection (UNDERPERFORM, OUTPERFORM, PRICE_FALL, or PRICE_RISE), forecastProbability (0 to 1), and forecastHorizon. Use this category only for a creator's explicit prediction about the player's FPL output or price, such as "he will blank" or "he will drop in price". These are context-only forecasts and must never be converted into role or minutes adjustments.
Never combine a creator's FPL recommendation with a distinct real-world claim. When one passage contains both, emit separate objects with the same timestamp: an FPL_SELECTION object for the buy/sell/captain/avoid view, and a ROLE or ROTATION object for the minutes evidence. For example, "Foden is a good GW1 pick, set to start, but Cherki may compete for minutes" yields one FPL_SELECTION and separate role claims for "set to start" and the minutes competition.
For claims about real-world availability or minutes, you may also add suggestedInterpretation: {role: FIRST_CHOICE|ROTATION_LOW|ROTATION_MEDIUM|ROTATION_HIGH|BACKUP|OUT, confidence: 0 to 1, rationale: string}. This is a proposed translation for the FPL model, not a claim that the creator supplied a number. Use it only when the wording has a clear real-world implication: "not nailed", "no fixed number one", or "all positions are up for grabs" means ROTATION_MEDIUM; material competition, "one of two", or "may not get regular starts" means ROTATION_HIGH; "likely/expected first choice", "no real competition", or "assured of his place" means FIRST_CHOICE. Treat a conditional transfer, a possible future signing, or a player's own FPL selection as context only unless the speaker also makes a clear current role claim. Never add an interpretation to FPL_SELECTION, value opinions, or vague player mentions.
Never infer numeric probabilities or minutes from vague language in the source claim fields; include those values only when the speaker explicitly states them. A creator's own buy/sell/start/bench choice is FPL_SELECTION, not evidence of real-world minutes. Make a player the subject only when the evidence is actually about that player: do not turn a teammate's injury, a team-level observation, or a list of several signings into the same claim for every mentioned player. For example, "Saliba is out, so Arsenal may suffer" is not an injury claim for Gabriel. Exclude sponsor reads, jokes, repetitions, and claims that are not about a named player. Use the timestamp where the evidence begins. Do not add facts not present in the transcript.

Video: ${video.title}
Creator: ${video.source_name}
Published: ${video.published_at||'unknown'}

Transcript:
${transcriptForPrompt(transcript.segments, 28_000)}`
}

async function refreshNativeCreatorFeeds(){
  const db=await getDb()
  const runId=await startFeedRun(db,{source:'CREATOR',metadata:{provider:'YouTube RSS',label:'YouTube creator feeds'}})
  try {
  const poll=await pollCreatorSources(db)
  const queue=await processCreatorQueue(db,{limit:Number(process.env.CREATOR_INGEST_BATCH_SIZE)||2,extractClaims:async({video,transcript})=>{
    const llm=await callLLMProvider(creatorExtractionPrompt(video,transcript),{rawJson:true,maxOutputTokens:3000})
    await recordAiUsage({feature:'YOUTUBE_EXTRACTION',result:llm})
    if(!llm?.answer){
      const configured=loadAiSettings(),provider=String(configured.provider||'gemini').toLowerCase()
      const environmentKey=provider==='openai'?process.env.OPENAI_API_KEY:provider==='anthropic'?process.env.ANTHROPIC_API_KEY:provider==='deepseek'?process.env.DEEPSEEK_API_KEY:process.env.GEMINI_API_KEY
      if(!configured.apiKey&&!environmentKey)throw new Error(`No ${provider} API key is available to background creator processing. Re-save the key in AI configuration.`)
      throw new Error(`The configured ${provider} provider returned no usable response for creator extraction.`)
    }
    const extracted=parseCreatorExtraction(llm.answer)
    const payload={schemaVersion:1,source:{platform:'YOUTUBE',externalId:video.id,creator:video.source_name,title:video.title,url:video.url,publishedAt:video.published_at},claims:extracted.claims}
    return {provider:llm.provider,payload,ingest:processCreatorPayload}
  }})
  await succeedFeedRun(db,runId,{insertedCount:poll.discovered,updatedCount:queue.processed,unmatchedCount:queue.unavailable+queue.failed,metadata:{sourcesPolled:poll.sources,signalsExtracted:queue.claims}})
  return `Polled ${poll.sources} creator source${poll.sources===1?'':'s'}; processed ${queue.processed} video${queue.processed===1?'':'s'}; extracted ${queue.claims} signal${queue.claims===1?'':'s'}.`
  } catch (error) { await failFeedRun(db,runId,error); throw error }
}


async function liveData() {
  return refreshLiveData()
}

function liveProjectionFixture(item, fixture) {
  const ownAttack = Number(item.teamStrength[fixture.isHome ? 'strengthAttackHome' : 'strengthAttackAway'])
  const ownDefence = Number(item.teamStrength[fixture.isHome ? 'strengthDefenceHome' : 'strengthDefenceAway'])
  const opponentAttack = Number(fixture.opponent.teamStrength[fixture.isHome ? 'strengthAttackAway' : 'strengthAttackHome'])
  const opponentDefence = Number(fixture.opponent.teamStrength[fixture.isHome ? 'strengthDefenceAway' : 'strengthDefenceHome'])
  const marketAttack = fixture.market ? (fixture.isHome ? fixture.market.homeExpectedGoals : fixture.market.awayExpectedGoals) / 1.4 : null
  const marketDefence = fixture.market ? (fixture.isHome ? fixture.market.awayExpectedGoals : fixture.market.homeExpectedGoals) / 1.4 : null
  const officialComplete = [ownAttack, ownDefence, opponentAttack, opponentDefence].every(value => Number.isFinite(value) && value > 0)
  const strength = marketAttack != null && marketDefence != null
    ? { method: 'MARKET_XG', attackMultiplier: marketAttack, defenceMultiplier: marketDefence }
    : officialComplete
      ? { method: 'OFFICIAL_STRENGTH', attackMultiplier: ownAttack / 1000 * (2 - opponentDefence / 1000), defenceMultiplier: opponentAttack / 1000 * (2 - ownDefence / 1000) }
      : undefined
  const marketCleanSheetProbability = fixture.market
    ? (fixture.isHome ? fixture.market.homeCleanSheetProbability : fixture.market.awayCleanSheetProbability) ?? undefined
    : undefined
  return { gameweek: fixture.gameweekFplId || 0, opponent: fixture.opponent.shortName, venue: fixture.isHome ? 'H' : 'A', difficulty: fixture.difficulty || 3, marketCleanSheetProbability, strength }
}

async function refreshLiveData() {
  const db=await getDb(),asOf=new Date().toISOString()
  const catalog=await assembleProjectionInputCatalog(db,{asOf})
  const futureFixtures=catalog.players.flatMap(player=>player.fixtures).filter(fixture=>fixture.gameweekId&&fixture.kickoffAt&&Date.parse(fixture.kickoffAt)>=Date.parse(asOf)).sort((left,right)=>(left.gameweekFplId||Infinity)-(right.gameweekFplId||Infinity))
  const next=futureFixtures[0]||null,currentGameweek=next?.gameweekFplId||null
  const deadline=next?.gameweekId?(await db.query(`SELECT "deadline_at" FROM "GameweekObservation" WHERE "gameweek_id"=$1 AND datetime("observed_at")<=datetime($2) ORDER BY datetime("observed_at") DESC,"id" DESC LIMIT 1`,[next.gameweekId,asOf])).rows[0]?.deadline_at||null:null
  const players=catalog.players.map((item,index)=>{
    const official=item.official||{},first=item.fixtures[0]
    const availability=Number(official.chance_of_playing??100)
    const signals=toCatalogRoleSignals(item)
    const roleProfile=resolvePlayerRole(baseRole(item),signals,{now:new Date(asOf),gameweek:currentGameweek||undefined})
    const expectedMinutes=roleProfile.startProbability*roleProfile.minutesIfStarting+(1-roleProfile.startProbability)*roleProfile.substituteProbabilityWhenBenched*roleProfile.minutesIfSubstitute
    return {id:item.fplId,name:item.name,identityNames:item.identityNames||[item.name],club:item.team.shortName,clubName:item.team.name,position:official.position,price:Number(official.price_tenths||0)/10,form:Number(official.form||0),ownership:Number(official.ownership_percent||0),minutes:availability,expectedMinutes,roleProfile,fixture:first?`${first.opponent.shortName} (${first.isHome?'H':'A'})`:'Blank',difficulty:first?.difficulty||3,projection:Number(official.ep_next||0),colour:colours[index%colours.length],status:String(official.status||'a'),chanceOfPlaying:official.chance_of_playing==null?undefined:Number(official.chance_of_playing),news:official.news||null,transfersIn:Number(official.transfers_in||0),transfersOut:Number(official.transfers_out||0),active:Boolean(official.active),dataConfidence:item.provenance.underlyingObservationId?'HIGH':'MEDIUM',upcomingFixtures:item.fixtures.map(fixture=>liveProjectionFixture(item,fixture)),stats:{minutes:Number(official.minutes||0),starts:Number(official.starts||0),totalPoints:Number(official.total_points||0),goals:Number(official.goals_scored||0),assists:Number(official.assists||0),cleanSheets:Number(official.clean_sheets||0),goalsConceded:Number(official.goals_conceded||0),saves:Number(official.saves||0),bonus:Number(official.bonus||0),bps:Number(official.bps||0),yellowCards:Number(official.yellow_cards||0),redCards:Number(official.red_cards||0),ownGoals:Number(official.own_goals||0),penaltiesMissed:Number(official.penalties_missed||0),penaltiesSaved:Number(official.penalties_saved||0),expectedGoals:Number(official.expected_goals||0),expectedAssists:Number(official.expected_assists||0),expectedGoalsConceded:Number(official.expected_goals_conceded||0)}}
  })
  return {capturedAt:catalog.freshness.official.observedAt||catalog.asOf,currentGameweek,deadline,modelVersion:MODEL_VERSION,players,freshness:catalog.freshness,inputHash:catalog.inputHash}
}

function toCatalogRoleSignals(item) {
  const gameweekByFixture = new Map((item.fixtures || []).map(fixture => [fixture.gameweekId, fixture.gameweekFplId]))
  return (item.roleSignals || []).map(signal => ({
    id: signal.id,
    playerId: item.fplId,
    gameweek: signal.gameweekId ? (gameweekByFixture.get(signal.gameweekId) ?? null) : null,
    kind: signal.kind,
    value: signal.value,
    sourceType: signal.sourceType,
    sourceUrl: signal.sourceUrl || null,
    evidenceSummary: signal.evidenceSummary || '',
    confidence: Number(signal.confidence ?? 1),
    observedAt: signal.observedAt,
    validUntil: signal.validUntil,
    status: 'VERIFIED',
  }))
}

function enrichCatalogRoles(catalogue) {
  const futureFixtures = (catalogue.players || []).flatMap(player => player.fixtures).filter(fixture => fixture.gameweekId && fixture.kickoffAt && Date.parse(fixture.kickoffAt) >= Date.parse(catalogue.asOf)).sort((left, right) => (left.gameweekFplId || Infinity) - (right.gameweekFplId || Infinity))
  const currentGameweek = futureFixtures[0]?.gameweekFplId || null
  const now = new Date(catalogue.asOf)
  const players = (catalogue.players || []).map(item => {
    const roleProfile = resolvePlayerRole(baseRole(item), toCatalogRoleSignals(item), { now, gameweek: currentGameweek || undefined })
    const expectedMinutes = roleProfile.startProbability * roleProfile.minutesIfStarting + (1 - roleProfile.startProbability) * roleProfile.substituteProbabilityWhenBenched * roleProfile.minutesIfSubstitute
    return { ...item, roleProfile, expectedMinutes, dataConfidence: roleProfile.confidence }
  })
  return { ...catalogue, players }
}

function compactClientCatalog(catalogue, fixtureHorizon = 5) {
  const horizon = Math.max(1, Math.min(5, Number(fixtureHorizon) || 5))
  const asOfMs = Date.parse(catalogue.asOf)
  const futureFixtures = (catalogue.players || [])
    .flatMap(player => player.fixtures || [])
    .filter(fixture => fixture.gameweekId && fixture.kickoffAt && Date.parse(fixture.kickoffAt) >= asOfMs)
    .sort((left, right) => (left.gameweekFplId || Infinity) - (right.gameweekFplId || Infinity))
  const currentGameweek = futureFixtures[0]?.gameweekFplId || null
  const players = (catalogue.players || []).map(item => {
    const official = item.official || {}
    const fixtures = (item.fixtures || [])
      .filter(fixture => fixture.kickoffAt && Date.parse(fixture.kickoffAt) >= asOfMs)
      .sort((left, right) => (left.gameweekFplId || Infinity) - (right.gameweekFplId || Infinity))
      .slice(0, horizon)
      .map(fixture => ({
        gameweek: fixture.gameweekFplId || 0,
        opponent: fixture.opponent.shortName,
        venue: fixture.isHome ? 'H' : 'A',
        difficulty: fixture.difficulty || 5,
      }))
    const first = fixtures[0]
    return {
      id: item.fplId,
      name: item.name,
      club: item.team.shortName,
      position: String(official.position || 'MID'),
      price: Number(official.price_tenths || 0) / 10,
      form: Number(official.form || 0),
      ownership: Number(official.ownership_percent || 0),
      minutes: Number(official.chance_of_playing ?? 100),
      expectedMinutes: item.expectedMinutes,
      roleProfile: item.roleProfile,
      dataConfidence: item.dataConfidence,
      fixture: first ? `${first.opponent} (${first.venue})` : 'BLANK',
      difficulty: first?.difficulty || 5,
      projection: Number(official.ep_next || 0),
      status: String(official.status || 'a'),
      chanceOfPlaying: official.chance_of_playing == null ? undefined : Number(official.chance_of_playing),
      news: official.news == null ? undefined : String(official.news),
      transfersIn: Number(official.transfers_in || 0),
      transfersOut: Number(official.transfers_out || 0),
      active: Boolean(official.active),
      stats: {
        minutes: Number(official.minutes || 0),
        starts: Number(official.starts || 0),
        expectedGoals: Number(official.expected_goals || 0),
        expectedAssists: Number(official.expected_assists || 0),
      },
      upcomingFixtures: fixtures,
    }
  })
  return {
    schemaVersion: 1,
    season: catalogue.season || FPL_SEASON,
    currentSeason: catalogue.season || FPL_SEASON,
    capturedAt: catalogue.freshness?.official?.observedAt || catalogue.asOf,
    currentGameweek,
    deadline: null,
    players,
  }
}

function formatProviderAnswer(raw) {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed = null
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    const verdictMatch = cleaned.match(/"verdict"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/)
    const recMatch = cleaned.match(/"recommendation"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/)
    const caveatMatch = cleaned.match(/"caveat"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/)
    const reasoningMatches = Array.from(cleaned.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g))
      .map(m => m[1])
      .filter(str => !['verdict', 'reasoning', 'recommendation', 'caveat'].includes(str) && str.length > 5)

    if (verdictMatch || recMatch || reasoningMatches.length > 0) {
      parsed = {
        verdict: verdictMatch ? verdictMatch[1] : '',
        reasoning: reasoningMatches.slice(0, 3),
        recommendation: recMatch ? recMatch[1] : '',
        caveat: caveatMatch ? caveatMatch[1] : ''
      }
    }
  }

  if (parsed && typeof parsed === 'object') {
    const verdict = typeof parsed.verdict === 'string' ? parsed.verdict.trim() : ''
    const reasoning = Array.isArray(parsed.reasoning)
      ? parsed.reasoning.filter(item => typeof item === 'string').slice(0, 3)
      : typeof parsed.reasoning === 'string' ? [parsed.reasoning] : []
    const recommendation = typeof parsed.recommendation === 'string' ? parsed.recommendation.trim() : ''
    const caveat = typeof parsed.caveat === 'string' ? parsed.caveat.trim() : ''
    return [verdict, ...reasoning, recommendation ? `Recommendation: ${recommendation}` : '', caveat ? `Note: ${caveat}` : ''].filter(Boolean).join('\n\n')
  }

  return cleaned.replace(/[{}[\]"]/g, '').replace(/\*\*|__|`|^#{1,6}\s*/gm, '').trim()
}

async function callLLMProvider(prompt, customConfig = {}) {
  const storedAi = loadAiSettings()
  let userProvider = (customConfig.userProvider || storedAi.provider || 'gemini').toLowerCase()
  const userKey = customConfig.userApiKey ? customConfig.userApiKey.trim() : (storedAi.apiKey || '')

  if (userKey) {
    if ((userKey.startsWith('sk-') && !userKey.startsWith('sk-ant-')) && userProvider !== 'openai' && userProvider !== 'deepseek') {
      userProvider = 'openai'
    } else if (userKey.startsWith('sk-ant-') && userProvider !== 'anthropic') {
      userProvider = 'anthropic'
    } else if (userKey.startsWith('AIzaSy') && userProvider !== 'gemini') {
      userProvider = 'gemini'
    }
  }

  const geminiKey = (userProvider === 'gemini' && userKey) ? userKey : process.env.GEMINI_API_KEY
  const openaiKey = (userProvider === 'openai' && userKey) ? userKey : process.env.OPENAI_API_KEY
  const deepseekKey = (userProvider === 'deepseek' && userKey) ? userKey : process.env.DEEPSEEK_API_KEY
  const anthropicKey = (userProvider === 'anthropic' && userKey) ? userKey : process.env.ANTHROPIC_API_KEY
  const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434'
  const maxOutputTokens = Math.max(200, Math.min(8000, Number(customConfig.maxOutputTokens) || 1200))

  if (geminiKey && (userProvider === 'gemini' || !userKey)) {
    const model = customConfig.userModel || process.env.GEMINI_MODEL || 'gemini-2.0-flash'
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig:{maxOutputTokens,responseMimeType:'application/json'} })
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Gemini API error ${res.status}: ${errText}`)
    }
    const data = await res.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (text) return aiProviderResult(text, 'Gemini', model, data.usageMetadata, customConfig)
  }

  if (openaiKey && (userProvider === 'openai' || !userKey)) {
    const model = customConfig.userModel || process.env.OPENAI_MODEL || 'gpt-4o-mini'
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_completion_tokens:maxOutputTokens, response_format:{type:'json_object'} })
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`OpenAI API error ${res.status}: ${errText}`)
    }
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content
    if (text) return aiProviderResult(text, 'OpenAI', model, data.usage, customConfig)
  }

  if (deepseekKey && userProvider === 'deepseek') {
    const model = customConfig.userModel || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
    const structured = Boolean(customConfig.rawJson)
    const completion = await callDeepSeekCompletion({ apiKey: deepseekKey, model, prompt, maxTokens: maxOutputTokens, structured })
    return aiProviderResult(completion.text, 'DeepSeek', model, completion.data.usage, customConfig)
  }

  if (anthropicKey && (userProvider === 'anthropic' || !userKey)) {
    const model = customConfig.userModel || process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022'
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens:maxOutputTokens, messages: [{ role: 'user', content: prompt }] })
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Anthropic API error ${res.status}: ${errText}`)
    }
    const data = await res.json()
    const text = data.content?.[0]?.text
    if (text) return aiProviderResult(text, 'Anthropic', model, data.usage, customConfig)
  }

  try {
    const res = await fetch(`${ollamaHost}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', prompt, stream: false, format:'json', options:{num_predict:maxOutputTokens} })
    })
    if (res.ok) {
      const data = await res.json()
      if (data.response) return aiProviderResult(data.response, 'Ollama', 'llama3', data, customConfig)
    }
  } catch {}

  return null
}

const challengeSchema={
  type:'object',additionalProperties:false,required:['summary','audits','signals'],properties:{
    summary:{type:'string'},
    audits:{type:'array',maxItems:15,items:{type:'object',additionalProperties:false,
      required:['playerId','playerName','outcome','expectedRole','evidenceSummary','sourceUrl'],
      properties:{
        playerId:{type:'integer'},playerName:{type:'string'},
        outcome:{type:'string',enum:['MATERIAL_RISK','NO_MATERIAL_RISK','INSUFFICIENT_EVIDENCE']},
        expectedRole:{type:'string',enum:['FIRST_CHOICE','ROTATION','BACKUP','OUT','UNKNOWN']},
        evidenceSummary:{type:'string'},sourceUrl:{type:'string'}
      }
    }},
    signals:{type:'array',maxItems:12,items:{type:'object',additionalProperties:false,
      required:['playerId','playerName','kind','value','sourceType','sourceUrl','sourceTitle','evidenceSummary','confidence','validUntil','sourceDate'],
      properties:{
        playerId:{type:'integer'},playerName:{type:'string'},
        kind:{type:'string',enum:['START_PROBABILITY','DEPTH_CHART','INJURY','EXPECTED_ROLE','PENALTIES','SET_PIECES','PRESEASON_MINUTES']},
        sourceDate:{type:['string','null']},
        value:{type:'object',additionalProperties:false,required:['startProbability','minutesIfStarting','substituteProbabilityWhenBenched','minutesIfSubstitute','depthRole','note'],properties:{
          startProbability:{type:['number','null'],minimum:0,maximum:1},minutesIfStarting:{type:['number','null'],minimum:0,maximum:90},
          substituteProbabilityWhenBenched:{type:['number','null'],minimum:0,maximum:1},minutesIfSubstitute:{type:['number','null'],minimum:0,maximum:45},
          depthRole:{type:['string','null'],enum:['FIRST_CHOICE','ROTATION','BACKUP','OUT',null]},note:{type:['string','null']}
        }},
        sourceType:{type:'string',enum:['OFFICIAL_CLUB','OFFICIAL_PL','JOURNALIST','PREDICTED_LINEUP']},
        sourceUrl:{type:'string'},sourceTitle:{type:'string'},evidenceSummary:{type:'string'},confidence:{type:'number',minimum:0,maximum:1},validUntil:{type:'string'}
      }
    }}
  }
}

const canonicalUrl=value=>{
  try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol))return null;url.hash='';url.search='';return url.toString().replace(/\/$/,'')}catch{return null}
}

function researchUsage(model,usage={},webSearchCalls=0,provider='openai'){
  const rates=provider==='deepseek'&&model.startsWith('deepseek-v4-flash')?{input:.14,cached:.0028,output:.28}
    :model.startsWith('gpt-4o-mini')?{input:.15,cached:.075,output:.6}
    :model.startsWith('gpt-4o')?{input:2.5,cached:1.25,output:10}
    :model.startsWith('gemini-2.0-flash')?{input:.1,cached:.025,output:.4}
    :model.startsWith('claude-3-5-haiku')?{input:.8,cached:.08,output:4}
    :model.startsWith('gpt-5-mini')?{input:.25,cached:.025,output:2}
    :model.startsWith('gpt-5.6-luna')?{input:1,cached:.1,output:6}
    :model.startsWith('gpt-5.6-terra')?{input:2.5,cached:.25,output:15}
    :model.startsWith('gpt-5.6-sol')||model==='gpt-5.6'?{input:5,cached:.5,output:30}
    :model.startsWith('gpt-5.4-mini')?{input:.75,cached:.075,output:4.5}:null
  const inputTokens=Number(usage.input_tokens)||0
  const cachedInputTokens=Number(usage.input_tokens_details?.cached_tokens)||0
  const outputTokens=Number(usage.output_tokens)||0
  const searchCharge=provider==='deepseek'?0:webSearchCalls*.01
  const estimatedCostUsd=rates?((inputTokens-cachedInputTokens)*rates.input+cachedInputTokens*rates.cached+outputTokens*rates.output)/1_000_000+searchCharge:null
  return {inputTokens,cachedInputTokens,outputTokens,totalTokens:Number(usage.total_tokens)||inputTokens+outputTokens,webSearchCalls,estimatedCostUsd:estimatedCostUsd===null?null:+estimatedCostUsd.toFixed(4)}
}

function rssExtractionPrompt(item) {
  return `Extract only FPL-relevant, player-specific claims from this RSS or Atom item and its linked article text. The article text was fetched server-side from the publisher URL and is supplied below; do not open any additional links or infer anything beyond the supplied evidence.
Return JSON with one property, "claims", containing at most 20 objects. Each object must contain: rawPlayerName, clubHint (string or null), positionHint (GK/DEF/MID/FWD or null), category (ROLE, ROTATION, INJURY, SET_PIECES, PENALTIES, PRESEASON, TACTICS, VALUE, STATS, TRANSFER, FPL_SELECTION, or OTHER), sentiment (POSITIVE, NEGATIVE, MIXED, or NEUTRAL), summary, evidenceText, timestampSeconds (null), timeHorizon (GW<number>, SHORT_TERM, MEDIUM_TERM, SEASON, or UNKNOWN), and confidence (0 to 1).
Optional fields are depthRole (FIRST_CHOICE, ROTATION, BACKUP, OUT), startProbability, minutesIfStarting, substituteProbabilityWhenBenched, minutesIfSubstitute, numericClaims, and relatedMentions. Never infer numeric probabilities or minutes. Exclude claims not directly supported by the supplied evidence. Do not add facts from general knowledge.

Feed: ${item.source_name}
Title: ${item.title}
Published: ${item.published_at || 'unknown'}
Item URL (for attribution only; do not open): ${item.url || 'none'}

Feed-supplied content:
${item.content_text}

Linked article text (may be unavailable):
${item.article_content_text || '(not available)'}`
}

async function refreshRssFeeds() {
  const db = await getDb()
  const runId = await startFeedRun(db, { source: 'RESEARCH', metadata: { provider: 'RSS/Atom', label: 'RSS/Atom feeds' } })
  try {
  const poll = await pollRssSources(db)
  const queue = await processRssQueue(db, { limit: Number(process.env.RSS_INGEST_BATCH_SIZE) || 3, extractClaims: async ({ item }) => {
    const llm = await callLLMProvider(rssExtractionPrompt(item), { rawJson: true, maxOutputTokens: 3000 })
    await recordAiUsage({ feature: 'RSS_EXTRACTION', result: llm })
    if (!llm?.answer) throw new Error('Configured LLM provider returned no usable response for RSS extraction')
    const extracted = parseCreatorExtraction(llm.answer)
    const payload = { schemaVersion: 1, source: { platform: 'RSS', externalId: item.id, creator: item.source_name, title: item.title, url: item.url || item.feed_url, publishedAt: item.published_at, signalSourceType: 'LLM_RESEARCH' }, claims: extracted.claims }
    return { provider: llm.provider, payload, ingest: processCreatorPayload }
  } })
  await succeedFeedRun(db, runId, { insertedCount: poll.discovered, updatedCount: queue.processed, unmatchedCount: queue.insufficient + queue.failed, metadata: { sourcesPolled: poll.sources, signalsExtracted: queue.claims } })
  return `Polled ${poll.sources} RSS source${poll.sources === 1 ? '' : 's'}; processed ${queue.processed} item${queue.processed === 1 ? '' : 's'}; extracted ${queue.claims} pending signal${queue.claims === 1 ? '' : 's'}.`
  } catch (error) { await failFeedRun(db, runId, error); throw error }
}

function normalizedAiUsage(provider, model, usage={}, webSearchCalls=0){
  const inputTokens=Number(usage.input_tokens??usage.prompt_tokens??usage.promptTokenCount??usage.prompt_eval_count)||0
  const cachedInputTokens=Number(usage.input_tokens_details?.cached_tokens??usage.prompt_tokens_details?.cached_tokens??usage.cache_read_input_tokens)||0
  const outputTokens=Number(usage.output_tokens??usage.completion_tokens??usage.candidatesTokenCount??usage.eval_count)||0
  const totalTokens=Number(usage.total_tokens??usage.totalTokenCount)||inputTokens+outputTokens
  const estimatedCostUsd=researchUsage(model,{input_tokens:inputTokens,output_tokens:outputTokens,total_tokens:totalTokens,input_tokens_details:{cached_tokens:cachedInputTokens}},webSearchCalls,provider.toLowerCase()).estimatedCostUsd
  return {inputTokens,cachedInputTokens,outputTokens,totalTokens,webSearchCalls,estimatedCostUsd}
}

function aiProviderResult(answer, provider, model, usage, config){
  return {answer:config.rawJson?answer:formatProviderAnswer(answer),provider:`${provider} (${model})`,model,usage:normalizedAiUsage(provider,model,usage),billingSource:config.userApiKey?'USER_API_KEY':provider==='Ollama'?'LOCAL':'SERVER_API_KEY'}
}

async function recordAiUsage({feature,result,billingSource}){
  if(!result?.usage)return
  const usage=result.usage
  if(!usage.totalTokens&&!usage.webSearchCalls)return
  const db=await getDb()
  await db.query(`INSERT INTO "AiUsageEvent" ("id","feature","provider","model","billing_source","input_tokens","cached_input_tokens","output_tokens","total_tokens","web_search_calls","estimated_cost_usd","created_at") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[
    randomUUID(),feature,result.provider||'Unknown',result.model||'Unknown',billingSource||result.billingSource||'SERVER_API_KEY',usage.inputTokens||0,usage.cachedInputTokens||0,usage.outputTokens||0,usage.totalTokens||0,usage.webSearchCalls||0,usage.estimatedCostUsd,new Date().toISOString(),
  ])
}

function responseOutputText(data){
  return (Array.isArray(data?.output)?data.output:[])
    .filter(item=>item?.type==='message')
    .flatMap(item=>Array.isArray(item.content)?item.content:[])
    .filter(content=>content?.type==='output_text'&&typeof content.text==='string')
    .map(content=>content.text)
}

function responseRawOutput(data){
  return (Array.isArray(data?.output)?data.output:[]).flatMap(item=>{
    const parts=Array.isArray(item?.content)?item.content:[]
    const textParts=parts.map(part=>typeof part?.text==='string'?part.text:typeof part?.refusal==='string'?part.refusal:'').filter(Boolean)
    if(textParts.length)return [`[${item.type}]\n${textParts.join('\n')}`]
    if(item?.type==='web_search_call'&&item.action?.query)return [`[web_search_call] query: ${item.action.query}`]
    return []
  }).join('\n\n').trim()
}

function groundedOutputError(message,data,parsed=null){
  const error=new Error(message)
  const parsedOutput=parsed?`\n\n[parsed candidate JSON]\n${JSON.stringify(parsed,null,2)}`:''
  error.rawOutput=`${responseRawOutput(data)}${parsedOutput}`.trim()
  error.outputTypes=(Array.isArray(data?.output)?data.output:[]).map(item=>item?.type).filter(Boolean)
  error.usage=data?.usage||null
  return error
}

function parseStructuredOutput(data){
  const blocks=responseOutputText(data)
  const candidates=[...blocks,typeof data?.output_text==='string'?data.output_text:'']
  for(const raw of candidates){
    const text=String(raw||'').trim()
    if(!text)continue
    const stripped=text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim()
    try{return JSON.parse(stripped)}catch{}
    const start=stripped.indexOf('{'),end=stripped.lastIndexOf('}')
    if(start>=0&&end>start){try{return JSON.parse(stripped.slice(start,end+1))}catch{}}
  }
  return null
}

function mergeGroundedResponses(primary,followup){
  const firstUsage=primary?.usage||{},secondUsage=followup?.usage||{}
  const firstDetails=firstUsage.input_tokens_details||{},secondDetails=secondUsage.input_tokens_details||{}
  return {
    ...followup,
    output:[...(Array.isArray(primary?.output)?primary.output:[]),...(Array.isArray(followup?.output)?followup.output:[])],
    output_text:followup?.output_text||primary?.output_text,
    usage:{
      input_tokens:(Number(firstUsage.input_tokens)||0)+(Number(secondUsage.input_tokens)||0),
      output_tokens:(Number(firstUsage.output_tokens)||0)+(Number(secondUsage.output_tokens)||0),
      total_tokens:(Number(firstUsage.total_tokens)||0)+(Number(secondUsage.total_tokens)||0),
      input_tokens_details:{cached_tokens:(Number(firstDetails.cached_tokens)||0)+(Number(secondDetails.cached_tokens)||0)}
    }
  }
}

function groundedResponseFailure(data,model,webSearchCalls,provider='openai'){
  const status=typeof data?.status==='string'?data.status:'unknown'
  const reason=data?.incomplete_details?.reason
  const refusal=(Array.isArray(data?.output)?data.output:[])
    .flatMap(item=>Array.isArray(item?.content)?item.content:[])
    .find(content=>content?.type==='refusal')?.refusal
  const usage=researchUsage(model,data?.usage,webSearchCalls,provider)
  const tokenSummary=usage.totalTokens?` Usage: ${usage.totalTokens.toLocaleString()} tokens (${usage.inputTokens.toLocaleString()} input, ${usage.outputTokens.toLocaleString()} output).`:''
  if(refusal)return `Grounded research was refused: ${String(refusal).slice(0,400)}${tokenSummary}`
  if(status==='incomplete'&&reason==='max_output_tokens')return `Grounded research exhausted its token response budget before producing the structured audit.${tokenSummary}`
  if(status==='incomplete')return `Grounded research was incomplete (${reason||'reason not supplied'}) and produced no structured audit.${tokenSummary}`
  if(status==='failed')return `Grounded research failed${data?.error?.message?`: ${data.error.message}`:'.'}${tokenSummary}`
  const outputTypes=(Array.isArray(data?.output)?data.output:[]).map(item=>item?.type).filter(Boolean)
  return `Grounded research produced no structured audit (response status: ${status}${outputTypes.length?`; output: ${outputTypes.join(', ')}`:''}).${tokenSummary}`
}

function prioritySquadAudit(players){
  return players.map(player=>{
    const reasons=[]
    let priority=0
    if(player.position==='GK'&&player.isStarter){reasons.push('starting goalkeeper: verify first-choice status');priority+=100}
    if(player.position==='GK'&&player.price<=4.5){reasons.push('budget goalkeeper: verify first-choice status');priority+=90}
    if(player.status&&player.status!=='a'){reasons.push(`FPL availability status ${player.status}`);priority+=95}
    if(player.news){reasons.push(`current player news: ${String(player.news).slice(0,160)}`);priority+=85}
    if((player.roleProfile?.startProbability??1)<.85){reasons.push(`model start probability ${Math.round(player.roleProfile.startProbability*100)}%`);priority+=80}
    if(player.roleProfile?.confidence==='LOW'){reasons.push('low role confidence');priority+=70}
    if(player.transferredRecently){reasons.push('recent transfer with uncertain new-team role');priority+=60}
    if(player.isStarter&&player.price<=6){reasons.push('low-cost selected starter: verify minutes and role');priority+=20}
    return reasons.length?{id:player.id,name:player.name,club:player.club,reasons,priority}:null
  }).filter(Boolean).sort((a,b)=>b.priority-a.priority).slice(0,RESEARCH_AUDIT_LIMIT).map(({priority,...player})=>player)
}

function deepSeekSourceType(sourceUrl){
  try{
    const host=new URL(sourceUrl).hostname.replace(/^www\./,'')
    if(host==='premierleague.com'||host.endsWith('.premierleague.com'))return 'OFFICIAL_PL'
    if(host==='cpfc.co.uk'||host.endsWith('.cpfc.co.uk')||host==='chelseafc.com'||host.endsWith('.chelseafc.com'))return 'OFFICIAL_CLUB'
  }catch{}
  return 'JOURNALIST'
}

function normalizeDeepSeekSignals(parsed,players,priorityAudit,deadline){
  const rawSignals=Array.isArray(parsed.signals)?parsed.signals:[]
  return rawSignals.map(raw=>{
    if(!raw||typeof raw!=='object')return raw
    const audit=priorityAudit.find(item=>item.id===raw.playerId)
    const sourceUrl=raw.sourceUrl||audit?.sourceUrl||''
    const expectedRole=raw.expectedRole||audit?.expectedRole||raw.value?.depthRole||null
    const signalType=String(raw.signalType||'').toUpperCase()
    const kind=raw.kind||(
      signalType.includes('START')?'START_PROBABILITY':
      signalType.includes('INJUR')?'INJURY':
      signalType.includes('ROLE')||signalType.includes('DEPTH')?'EXPECTED_ROLE':'EXPECTED_ROLE'
    )
    const originalValue=raw.value&&typeof raw.value==='object'?raw.value:{}
    const rawStartProb = originalValue.startProbability ?? raw.startProbability ?? null
    const startProbability = typeof rawStartProb === 'number' ? (rawStartProb > 1 ? rawStartProb / 100 : rawStartProb) : null
    return {
      ...raw,
      playerName:raw.playerName||audit?.name||players.find(player=>player.id===raw.playerId)?.name||`Player ${raw.playerId}`,
      kind,
      value:{
        startProbability,
        minutesIfStarting:originalValue.minutesIfStarting??null,
        substituteProbabilityWhenBenched:originalValue.substituteProbabilityWhenBenched??null,
        minutesIfSubstitute:originalValue.minutesIfSubstitute??null,
        depthRole:originalValue.depthRole||expectedRole,
        note:originalValue.note||raw.evidenceSummary||audit?.evidenceSummary||null
      },
      sourceType:raw.sourceType||deepSeekSourceType(sourceUrl),
      sourceUrl,
      sourceTitle:raw.sourceTitle||'DeepSeek researched source',
      evidenceSummary:raw.evidenceSummary||audit?.evidenceSummary||'DeepSeek identified a material role or availability risk.',
      confidence:Number.isFinite(Number(raw.confidence))?Number(raw.confidence):.7,
      validUntil:raw.validUntil||deadline
    }
  })
}

const waitFor=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))

async function callGroundedSquadChallenge(players,gameweek,deadline,customConfig={}){
  const storedAi = loadAiSettings()
  const userProvider=(customConfig.userProvider||storedAi.provider||'openai').toLowerCase()
  const userKey=String(customConfig.userApiKey||storedAi.apiKey||'').trim()
  const isDeepSeek=userProvider==='deepseek'
  const apiKey=(isDeepSeek&&userKey)||(!isDeepSeek&&userProvider==='openai'&&userKey)||(isDeepSeek?process.env.DEEPSEEK_API_KEY:process.env.OPENAI_API_KEY)
  if(!apiKey)throw new Error(`Grounded squad research currently requires a ${isDeepSeek?'DeepSeek':'OpenAI'} API key.`)
  const model=customConfig.userModel||(isDeepSeek?process.env.DEEPSEEK_RESEARCH_MODEL||process.env.DEEPSEEK_MODEL||'deepseek-v4-flash':process.env.OPENAI_RESEARCH_MODEL||'gpt-5-mini')
  const priorityAudit=prioritySquadAudit(players)
  const prompt=[
    'You are the evidence researcher for a Fantasy Premier League projection system.',
    `Today is ${new Date().toISOString().slice(0,10)}. Research the supplied locked squad for Gameweek ${gameweek}.`,
    'Search the live web. Challenge only factual assumptions that materially affect expected starts, minutes, position/role, injuries, penalties, set pieces, or preseason hierarchy.',
    'Use a maximum of one focused web search per priority player and stop searching once that player has a credible current source. Do not repeat broad squad-wide searches or paste long source text into the response.',
    'Prefer official club and Premier League sources, then reputable current journalists or established predicted-lineup publications. Do not create signals from fan opinion, squad-structure preferences, or another site merely preferring one player. Note: Preseason friendly lineups alone are high-rotation and low-confidence unless backed by manager comments.',
    'Every signal must have a directly supporting source URL returned by web search. A URL present in the search results is sufficient: do not spend another tool call opening or re-finding it. Copy sourceUrl verbatim; do not reconstruct or rewrite it. If evidence is conflicting, lower confidence and explain the conflict. Start probabilities are calibrated estimates between 0.0 and 1.0 (e.g. 0.05 for 5%, 0.15 for 15%), NOT percentages over 1.0.',
    'You must return exactly one audits entry for every player in Priority audit. Do not spend searches proving routine low-risk starters are safe. For a budget goalkeeper, explicitly establish whether they are first choice, competition, or backup. For a recent transfer, explicitly establish their expected new-team role rather than carrying forward old-club minutes.',
    'Use outcome MATERIAL_RISK whenever the evidence implies a meaningful projection change, and include a matching signal for that player. NO_MATERIAL_RISK requires a supporting searched source. Use INSUFFICIENT_EVIDENCE only after searching; its sourceUrl may be an empty string.',
    'Keep the overall summary under 180 words and each audit or signal evidenceSummary under 80 words. Return only the requested JSON object—no preamble, no markdown, and no conversational explanation before or after it.',
    'JSON shape is exactly: {"summary":string,"audits":[{"playerId":number,"playerName":string,"outcome":"MATERIAL_RISK"|"NO_MATERIAL_RISK"|"INSUFFICIENT_EVIDENCE","expectedRole":"FIRST_CHOICE"|"ROTATION"|"BACKUP"|"OUT"|"UNKNOWN","evidenceSummary":string,"sourceUrl":string}],"signals":[{"playerId":number,"playerName":string,"kind":"EXPECTED_ROLE"|"START_PROBABILITY"|"DEPTH_CHART"|"INJURY"|"PENALTIES"|"SET_PIECES"|"PRESEASON_MINUTES","value":{"startProbability":number|null,"minutesIfStarting":number|null,"substituteProbabilityWhenBenched":number|null,"minutesIfSubstitute":number|null,"depthRole":"FIRST_CHOICE"|"ROTATION"|"BACKUP"|"OUT"|null,"note":string|null},"sourceType":"OFFICIAL_CLUB"|"OFFICIAL_PL"|"JOURNALIST"|"PREDICTED_LINEUP","sourceUrl":string,"sourceTitle":string,"evidenceSummary":string,"confidence":number,"validUntil":string,"sourceDate":string|null}]}. If there are no material risks, return an empty signals array. Every MATERIAL_RISK audit must have exactly one matching signal.',
    'For every signal set sourceDate to the publication date (ISO YYYY-MM-DD) of the supporting article. Never cite stale or outdated news: a lineup, injury, availability or preseason-minutes claim is only usable if its source was published within the last two weeks, otherwise return no signal for it. Only standing facts like penalty-taker or set-piece ownership may rely on older sources, and still date them. If you cannot determine the source publication date, then return no signal (sourceDate null will be rejected).',
    'The summary must accurately state what produced a signal. Never say assumptions were identified, addressed, or adjusted when signals is empty.',
    'Return no signal when the evidence is insufficient. validUntil must be an ISO timestamp no later than the relevant deadline for lineup/injury claims.',
    `Deadline: ${deadline||'unknown'}`,
    `Priority audit: ${JSON.stringify(priorityAudit)}`,
    `Players: ${JSON.stringify(players.map(player=>({id:player.id,name:player.name,club:player.club,position:player.position,price:player.price,projectedPoints:player.projectedPoints,roleProfile:player.roleProfile,transferredRecently:player.transferredRecently,status:player.status,news:player.news})))}`
  ].join('\n')
  const endpoint=isDeepSeek?'https://api.deepseek.com/responses':'https://api.openai.com/v1/responses'
  const requestBody={model,tools:[{type:'web_search'}],tool_choice:'auto',input:prompt,max_output_tokens:12000,text:{format:isDeepSeek?{type:'json_object'}:{type:'json_schema',name:'fpl_squad_challenge',strict:true,schema:challengeSchema}}}
  if(isDeepSeek)requestBody.reasoning={effort:'low'}
  if(!isDeepSeek)Object.assign(requestBody,{background:true,max_tool_calls:8,include:['web_search_call.action.sources']})
  let response=await fetch(endpoint,{
    method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${apiKey}`},
    // Reasoning options are deliberately omitted so a configured research model
    // can be either a reasoning or non-reasoning Responses API model.
    body:JSON.stringify(requestBody)
  })
  if(!response.ok)throw new Error(`${isDeepSeek?'DeepSeek':'OpenAI'} grounded research error ${response.status}: ${(await response.text()).slice(0,500)}`)
  let data=await response.json()
  const researchDeadline=Date.now()+8*60*1000
  while(data?.status==='queued'||data?.status==='in_progress'){
    if(isDeepSeek)throw new Error('DeepSeek returned an in-progress response, but its Responses API does not support background polling.')
    if(Date.now()>=researchDeadline){
      if(data?.id)await fetch(`https://api.openai.com/v1/responses/${encodeURIComponent(data.id)}/cancel`,{method:'POST',headers:{'authorization':`Bearer ${apiKey}`}}).catch(()=>null)
      throw new Error('Grounded research exceeded the 8-minute server limit and was cancelled.')
    }
    await waitFor(2500)
    response=await fetch(`https://api.openai.com/v1/responses/${encodeURIComponent(data.id)}`,{headers:{'authorization':`Bearer ${apiKey}`}})
    if(!response.ok)throw new Error(`Unable to poll OpenAI research ${response.status}: ${(await response.text()).slice(0,500)}`)
    data=await response.json()
  }
  let parsed=parseStructuredOutput(data)
  // A web-enabled response can occasionally finish after its search/reasoning
  // turns without emitting the required final message. Continue the stored
  // response once with tools removed so it must synthesize the JSON it already
  // researched instead of discarding the entire audit.
  if(!parsed&&data?.id){
    const synthesisBody={
      model,previous_response_id:data.id,
      input:'Stop researching. Using only the evidence already gathered, emit the requested final JSON object now. Do not call tools, explain your process, or add markdown.',
      max_output_tokens:6000,
      text:{format:isDeepSeek?{type:'json_object'}:{type:'json_schema',name:'fpl_squad_challenge',strict:true,schema:challengeSchema}}
    }
    if(isDeepSeek)synthesisBody.reasoning={effort:'low'}
    const synthesisResponse=await fetch(endpoint,{
      method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${apiKey}`},
      body:JSON.stringify(synthesisBody)
    })
    if(synthesisResponse.ok){
      const synthesis=await synthesisResponse.json()
      data=mergeGroundedResponses(data,synthesis)
      parsed=parseStructuredOutput(data)
    }
  }
  const webSearchCalls=data.output?.filter(item=>item.type==='web_search_call').length||0
  if(!parsed)throw groundedOutputError(`Grounded research returned malformed structured output (no parseable JSON object). Usage: ${(Number(data.usage?.total_tokens)||0).toLocaleString()} tokens (${(Number(data.usage?.input_tokens)||0).toLocaleString()} input, ${(Number(data.usage?.output_tokens)||0).toLocaleString()} output).`,data)
  const searchSourceUrls=data.output?.filter(item=>item.type==='web_search_call').flatMap(item=>item.action?.sources||item.sources||item.action?.results||[]).map(source=>typeof source==='string'?source:source.url||source.link).filter(Boolean)||[]
  const citationUrls=data.output?.filter(item=>item.type==='message').flatMap(item=>item.content||[]).flatMap(content=>content.annotations||[]).filter(annotation=>annotation.type==='url_citation').map(annotation=>annotation.url)||[]
  const searchedSources=new Set([...searchSourceUrls,...citationUrls].map(canonicalUrl).filter(Boolean))
  // DeepSeek supports server-side web search but does not support OpenAI's
  // include=web_search_call.action.sources payload. Keep its findings pending,
  // but allow a valid HTTPS URL from a completed DeepSeek search through for
  // manual review instead of dropping every audit as unverifiable.
  const sourceBacked=source=>source&&(searchedSources.has(source)||(isDeepSeek&&webSearchCalls>0&&/^https:\/\//.test(source)))
  const allowedIds=new Set(players.map(player=>player.id))
  const evidenceExpiry=deadline&&Number.isFinite(new Date(deadline).getTime())?new Date(deadline).getTime():Date.now()+7*24*60*60*1000
  // Recency gate: a time-sensitive claim (lineup, injury, availability,
  // preseason minutes) is only usable from a recent source; standing facts
  // (penalties, set pieces) tolerate older sources but are still dated.
  const signalRecencyDays={EXPECTED_ROLE:14,START_PROBABILITY:14,DEPTH_CHART:14,INJURY:10,PRESEASON_MINUTES:14,PENALTIES:120,SET_PIECES:120}
  const baselineById=new Map(players.map(player=>[player.id,player.roleProfile?.startProbability==null?null:Number(player.roleProfile.startProbability)]))
  const baselineMinutesById=new Map(players.map(player=>[player.id,player.roleProfile?.minutesIfStarting==null?null:Number(player.roleProfile.minutesIfStarting)]))
  const proposedSignals=isDeepSeek?normalizeDeepSeekSignals(parsed,players,priorityAudit,deadline):Array.isArray(parsed.signals)?parsed.signals:[]
  // softDroppedIds: players whose proposed signal was removed by the recency or
  // material-impact gates (soft reasons). Their MATERIAL_RISK audits are demoted
  // to NO_MATERIAL_RISK below so the whole challenge does not fail because a
  // single stale or zero-delta finding was correctly filtered out.
  const softDroppedIds=new Set()
  const signals=proposedSignals.filter(signal=>{
    if(!signal||typeof signal!=='object')return false
    const source=canonicalUrl(signal.sourceUrl)
    if(!(signal.value&&typeof signal.value==='object'&&allowedIds.has(signal.playerId)&&sourceBacked(source)&&Number.isFinite(new Date(signal.validUntil).getTime())))return false
    if(String(signal.sourceType).startsWith('OFFICIAL_')&&!sourceTypeMatchesUrl(signal.sourceType,source))return false
    // Recency gate: source publication date must exist and be recent enough.
    const sourceDate=signal.sourceDate==null?NaN:Date.parse(String(signal.sourceDate))
    // OpenAI is required to supply a dated source; DeepSeek cannot reliably
    // expose publication dates, so for DeepSeek we only enforce recency when a
    // date is present rather than dropping every search finding.
    if(!Number.isFinite(sourceDate)){if(!isDeepSeek){softDroppedIds.add(signal.playerId);return false}}
    else if(Date.now()-sourceDate>(signalRecencyDays[signal.kind]??14)*86400000){softDroppedIds.add(signal.playerId);return false}
    // Material-impact gate: a signal that barely changes the player's start
    // chance (beyond the model's existing estimate) and changes no role or
    // minutes is non-material noise and should not trigger an approval prompt.
    if(typeof signal.value.startProbability==='number'){
      const depthChanged=!!signal.value.depthRole&&signal.value.depthRole!=='UNKNOWN'
      const startBaseline=baselineById.get(signal.playerId)
      const startDelta=Number.isFinite(startBaseline)?Math.abs(signal.value.startProbability-startBaseline):null
      const minutes=signal.value.minutesIfStarting
      const minutesBaseline=baselineMinutesById.get(signal.playerId)
      const minutesChanged=Number.isFinite(minutes)&&Number.isFinite(minutesBaseline)&&Math.abs(minutes-minutesBaseline)>=8
      // Unknown baseline is treated as potentially material to avoid silently dropping
      // evidence; a null baseline (e.g. player without role data) keeps the signal.
      if(startDelta!==null&&startDelta<0.05&&!depthChanged&&!minutesChanged){softDroppedIds.add(signal.playerId);return false}
    }
    return true
  }).map(signal=>{
    const sourceUrl=canonicalUrl(signal.sourceUrl)
    const sourceType=sourceTypeMatchesUrl(signal.sourceType,sourceUrl)?signal.sourceType:'LLM_RESEARCH'
    return {...signal,sourceType,sourceUrl,sourceDate:signal.sourceDate?new Date(signal.sourceDate).toISOString():null,validUntil:new Date(Math.min(new Date(signal.validUntil).getTime(),evidenceExpiry)).toISOString(),value:Object.fromEntries(Object.entries(signal.value).filter(([,value])=>value!==null))}
  })
  const requiredAuditIds=new Set(priorityAudit.map(player=>player.id))
  const seenAuditIds=new Set()
  const audits=(Array.isArray(parsed.audits)?parsed.audits:[]).filter(audit=>{
    if(!requiredAuditIds.has(audit.playerId)||seenAuditIds.has(audit.playerId))return false
    const source=canonicalUrl(audit.sourceUrl)
    const sourceValid=audit.outcome==='INSUFFICIENT_EVIDENCE'&&!audit.sourceUrl||sourceBacked(source)
    if(!sourceValid)return false
    seenAuditIds.add(audit.playerId)
    return true
  }).map(audit=>{
    // A MATERIAL_RISK finding whose only signal was removed by the recency or
    // material-impact gate is no longer a material risk: demote it so the
    // challenge reports a consistent outcome instead of failing the whole run.
    const demote=audit.outcome==='MATERIAL_RISK'&&softDroppedIds.has(audit.playerId)
    return {...audit,sourceUrl:canonicalUrl(audit.sourceUrl),outcome:demote?'NO_MATERIAL_RISK':audit.outcome}
  })
  const missingAuditNames=priorityAudit.filter(player=>!seenAuditIds.has(player.id)).map(player=>player.name)
  if(missingAuditNames.length)throw groundedOutputError(`Grounded research was incomplete and changed nothing. Missing source-validated audits for: ${missingAuditNames.join(', ')}`,data,parsed)
  const signalledIds=new Set(signals.map(signal=>signal.playerId))
  const uncoveredRisks=audits.filter(audit=>audit.outcome==='MATERIAL_RISK'&&!signalledIds.has(audit.playerId)).map(audit=>audit.playerName)
  if(uncoveredRisks.length)throw groundedOutputError(`Grounded research identified risks without usable signals and changed nothing: ${uncoveredRisks.join(', ')}`,data,parsed)
  const rejectedSignalCount=proposedSignals.length-signals.length
  const summary=signals.length
    ? `${signals.length} source-backed finding${signals.length===1?'':'s'} require review. No projection or squad has changed yet.`
    : `Research completed, but no proposed claim passed source validation. No projection or squad was changed.`
  return {summary,researchSummary:parsed.summary,audits,signals,usage:researchUsage(model,data.usage,webSearchCalls,isDeepSeek?'deepseek':'openai'),proposedSignalCount:proposedSignals.length,rejectedSignalCount,provider:`${isDeepSeek?'DeepSeek':'OpenAI'} grounded research (${model})`,provenanceWarning:isDeepSeek?'DeepSeek source metadata is not exposed through its Responses compatibility layer; HTTPS URLs are retained for manual review only.':'',sources:[...searchedSources].map(url=>({url}))}
}

const squadChallengeJobs=new Map()

async function persistChallengeSignals(challenge,currentGameweek){
  const db=await getDb(),observedAt=new Date().toISOString(),stored=[]
  for(const signal of challenge.signals){
    const validUntil=new Date(signal.validUntil)
    if(!Number.isFinite(validUntil.getTime()))continue
    const existing=(await listPlayerSignals(db,{playerId:signal.playerId,status:'PENDING',limit:500})).find(row=>row.gameweek===currentGameweek&&row.kind===signal.kind&&row.sourceUrl===signal.sourceUrl)
    if(existing){
      stored.push(existing)
      continue
    }
    stored.push(await createPlayerSignal(db,{playerId:signal.playerId,gameweek:currentGameweek,kind:signal.kind,value:signal.value,sourceType:signal.sourceType,sourceUrl:signal.sourceUrl,evidenceSummary:signal.evidenceSummary,confidence:signal.confidence,observedAt,validUntil:validUntil.toISOString(),status:'PENDING',actorType:'RESEARCH',sourceDate:signal.sourceDate||null}))
  }
  return {...challenge,signals:stored}
}

function pruneSquadChallengeJobs(){
  const expiry=Date.now()-60*60*1000
  for(const [id,job] of squadChallengeJobs)if(job.updatedAt<expiry)squadChallengeJobs.delete(id)
}

function startServerOnAvailablePort(targetPort) {
  const server = http.createServer(async (req, res) => {
    res.requestId = randomUUID()
    res.requestHeaders = req.headers
    const request = (req.url || '/').split('?')[0]

    // Every API write that carries a payload is JSON-only. Empty command
    // endpoints are explicitly listed rather than silently accepting an
    // arbitrary content type.
    const isApiWrite = request.startsWith('/api/') && ['POST', 'PUT', 'PATCH'].includes(req.method || '')
    const noBodyWrite = request === '/api/fpl-refresh' || /^\/api\/plans\/[^/]+\/select$/.test(request) || /^\/api\/decisions\/[^/]+\/evaluate$/.test(request)
    if (isApiWrite && !noBodyWrite) {
      const contentLength = Number(req.headers['content-length'] || 0)
      if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
        sendJson(res, 413, { error: 'Request body too large' })
        req.resume()
        return
      }
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        sendJson(res, 415, { error: 'Content-Type must be application/json' })
        req.resume()
        return
      }
    }

    if (request === '/api/health') {
      if (systemStatus.status === 'initializing' || systemStatus.status === 'error') {
        sendJson(res, 503, { error: systemStatus.message, database: systemStatus.status, isSeeding: systemStatus.isSeeding, playerCount: systemStatus.playerCount })
      } else {
        sendJson(res, 200, { status: 'ok', database: systemStatus.status, isSeeding: systemStatus.isSeeding, playerCount: systemStatus.playerCount })
      }
      return
    }

    if (request === '/api/system-status') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }).end(JSON.stringify({ ...systemStatus, season: FPL_SEASON, currentSeason: FPL_SEASON }))
      return
    }

    if (request === '/api/forecast-runs/recompute' && req.method === 'POST') {
      try {
        sendJson(res, 202, await triggerForecastRecompute())
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'Unable to schedule forecast recompute' })
      }
      return
    }

    if (request === '/api/admin/status' && req.method === 'GET') {
      try { sendJson(res, 200, await adminStatusSnapshot()) }
      catch (error) { sendJson(res, 500, { error: error instanceof Error ? error.message : 'Admin status unavailable' }) }
      return
    }

    if (request === '/api/creator-sources' && req.method === 'GET') {
      try { sendJson(res, 200, await listCreatorSources(await getDb())) }
      catch (error) { sendJson(res, 500, { error: error instanceof Error ? error.message : 'Creator sources unavailable' }) }
      return
    }

    if (request === '/api/creator-sources' && req.method === 'POST') {
      try {
        const payload = await readRequestBody(req)
        const id = await addCreatorSource(await getDb(), payload)
        if (!startAdminOperation('creator-sync', refreshNativeCreatorFeeds)) await scheduleAuxiliaryRefresh('creator')
        sendJson(res, 201, { id, ...(await listCreatorSources(await getDb())) })
      } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : 'Could not add creator source' }) }
      return
    }

    const creatorVideoRetryMatch=request.match(/^\/api\/creator-videos\/([^/]+)\/retry$/)
    if(creatorVideoRetryMatch&&req.method==='POST'){
      try{
        await retryCreatorVideo(await getDb(),decodeURIComponent(creatorVideoRetryMatch[1]))
        if(!startAdminOperation('creator-sync',refreshNativeCreatorFeeds))await scheduleAuxiliaryRefresh('creator')
        sendJson(res,202,await listCreatorSources(await getDb()))
      }catch(error){
        const message=error instanceof Error?error.message:'Creator video could not be retried'
        sendJson(res,message.endsWith('not found')?404:409,{error:message})
      }
      return
    }

    if (request === '/api/rss-sources' && req.method === 'GET') {
      try { sendJson(res, 200, await listRssSources(await getDb())) }
      catch (error) { sendJson(res, 500, { error: error instanceof Error ? error.message : 'RSS sources unavailable' }) }
      return
    }
    if (request === '/api/rss-sources' && req.method === 'POST') {
      try {
        const payload = await readRequestBody(req), id = await addRssSource(await getDb(), payload)
        await scheduleAuxiliaryRefresh('rss')
        sendJson(res, 201, { id, ...(await listRssSources(await getDb())) })
      } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : 'Could not add RSS source' }) }
      return
    }

    const creatorVideoMatch=request.match(/^\/api\/creator-videos\/([^/]+)$/)
    if(creatorVideoMatch&&req.method==='GET'){
      try{
        const video=await getCreatorVideoDetail(await getDb(),decodeURIComponent(creatorVideoMatch[1]))
        if(!video){sendJson(res,404,{error:'Creator video not found'});return}
        sendJson(res,200,{schemaVersion:1,video})
      }catch(error){sendJson(res,500,{error:error instanceof Error?error.message:'Creator video unavailable'})}
      return
    }

    const creatorSourceMatch=request.match(/^\/api\/creator-sources\/(.+)$/)
    if(creatorSourceMatch&&req.method==='PATCH'){
      try{const payload=await readRequestBody(req);await setCreatorSourceEnabled(await getDb(),decodeURIComponent(creatorSourceMatch[1]),Boolean(payload.enabled));await scheduleAuxiliaryRefresh('creator');sendJson(res,200,await listCreatorSources(await getDb()))}
      catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Could not update creator source'})}
      return
    }
    if(creatorSourceMatch&&req.method==='DELETE'){
      try{await deleteCreatorSource(await getDb(),decodeURIComponent(creatorSourceMatch[1]));await scheduleAuxiliaryRefresh('creator');sendJson(res,200,await listCreatorSources(await getDb()))}
      catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Could not delete creator source'})}
      return
    }

    const rssSourceMatch=request.match(/^\/api\/rss-sources\/(.+)$/)
    if(rssSourceMatch&&req.method==='PATCH'){
      try{const payload=await readRequestBody(req);await setRssSourceEnabled(await getDb(),decodeURIComponent(rssSourceMatch[1]),Boolean(payload.enabled));await scheduleAuxiliaryRefresh('rss');sendJson(res,200,await listRssSources(await getDb()))}
      catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Could not update RSS source'})}
      return
    }
    if(rssSourceMatch&&req.method==='DELETE'){
      try{await deleteRssSource(await getDb(),decodeURIComponent(rssSourceMatch[1]));await scheduleAuxiliaryRefresh('rss');sendJson(res,200,await listRssSources(await getDb()))}
      catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Could not delete RSS source'})}
      return
    }

    if (request.startsWith('/api/admin/actions/') && req.method === 'POST') {
      if (!requireAdminToken(req, res)) return
      const action = decodeURIComponent(request.slice('/api/admin/actions/'.length))
      if (!adminOperations[action]) { sendJson(res, 404, { error: 'Unknown admin operation' }); return }
      if (systemStatus.isIngesting || systemStatus.isSeeding) { sendJson(res, 409, { error: 'FPL ingestion is already in progress' }); return }
      let work
      if (action === 'fpl-sync') {
        work = async () => {
          systemStatus.isIngesting = true
          systemStatus.status = 'ready'
          systemStatus.message = 'Manual FPL sync is running...'
          try {
            await runChildScript('scripts/ingest-fpl.mjs')
            return await refreshSystemPlayerCount('Manual FPL sync completed successfully.')
          } finally { systemStatus.isIngesting = false }
        }
      } else if (action === 'signals-sync') {
        work = async () => {
          const output = await runChildScript('scripts/ingest-signals.mjs')
          const forecast = await runChildScript('scripts/create-forecast-run.mjs')
          return `${output || 'Performance and odds sync completed'} ${forecast}`.trim()
        }
      } else if (action === 'odds-sync') {
        work = async () => {
          const output = await runChildScript('scripts/ingest-signals.mjs', ['--market-only'])
          const forecast = await runChildScript('scripts/create-forecast-run.mjs')
          return `${output || 'Betting odds sync completed'} ${forecast}`.trim()
        }
      } else if (action === 'team-refresh') {
        work = refreshLinkedManagerTeam
      } else if (action === 'creator-sync') {
        work = refreshNativeCreatorFeeds
      } else if (action === 'rss-sync') {
        work = refreshRssFeeds
      } else {
        work = async () => {
          systemStatus.isIngesting = true
          systemStatus.message = 'Refreshing official player-to-club links...'
          try {
            await runChildScript('scripts/ingest-fpl.mjs', [], { FPL_INGEST_MATCH_HISTORY: '0' })
            const catalogMessage = await refreshSystemPlayerCount('Official player-to-club links refreshed.')
            let managerMessage = 'No linked manager team to refresh'
            try { managerMessage = await refreshLinkedManagerTeam() } catch (error) {
              if (!String(error?.message || error).includes('No FPL manager team is linked')) throw error
            }
            return `${catalogMessage} ${managerMessage}.`
          } finally { systemStatus.isIngesting = false }
        }
      }
      if (!startAdminOperation(action, work)) { sendJson(res, 409, { error: 'Another admin operation is already running' }); return }
      sendJson(res, 202, { schemaVersion: 1, operation: adminOperations[action] })
      return
    }

    if (request === '/api/ai-config') {
      if (req.method === 'GET') {
        try {
          const db = await getDb()
          const state = await getUserState(db)
          const stored = loadAiSettings()
          const provider = state.ai.provider || stored.provider || ''
          const configuredKey = stored.apiKey || (provider === 'openai' && process.env.OPENAI_API_KEY) || (provider === 'gemini' && process.env.GEMINI_API_KEY) || (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) || (provider === 'deepseek' && process.env.DEEPSEEK_API_KEY) || ''
          sendJson(res, 200, { provider, configured: Boolean(configuredKey), suffix: configuredKey ? String(configuredKey).slice(-4) : null })
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : 'AI config unavailable' })
        }
        return
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        try {
          const body = await readRequestBody(req)
          saveAiSettings({ provider: body.provider || '', apiKey: body.apiKey || '' })
          try {
            const db = await getDb()
            await updateAiState(db, { provider: body.provider || '' })
          } catch {}
          sendJson(res, 200, { success: true, provider: body.provider || '', configured: Boolean(body.apiKey) })
        } catch (err) {
          sendJson(res, errorStatus(err), { error: sanitizeError(err) })
        }
        return
      }
    }

    if ((request === '/api/catalog' || request === '/api/client-catalog') && req.method === 'GET') {
      const params = new URL(req.url || '/', `http://${host}`).searchParams
      const options = { asOf: params.get('asOf') || undefined, season: params.get('season') || undefined }
      const requestKey = catalogueRequestKey(options)
      const clientResponse = request === '/api/client-catalog'
      const fixtureHorizon = params.get('fixtureHorizon') || 5
      const responsePayload = (catalogue, cacheStatus) => {
        const enriched = enrichCatalogRoles(catalogue)
        return clientResponse
          ? compactClientCatalog(enriched, fixtureHorizon)
          : { schemaVersion: 1, season: catalogue.season || FPL_SEASON, currentSeason: catalogue.season || FPL_SEASON, ...enriched, cache: { status: cacheStatus } }
      }
      try {
        const db = await getDb()
        const key = catalogueCacheKey(requestKey, await projectionCatalogInputVersions(db, options.season))
        const cached = catalogueCache.get(key)
        if (cached) {
          sendJson(res, 200, responsePayload(cached, 'FRESH'), clientResponse ? { cacheControl: 'public, max-age=30, stale-while-revalidate=300', etag: true } : undefined)
          return
        }
        const catalogue = await assembleProjectionInputCatalog(db, options)
        await catalogueCache.put(key, requestKey, catalogue)
        sendJson(res, 200, responsePayload(catalogue, 'MISS'), clientResponse ? { cacheControl: 'public, max-age=30, stale-while-revalidate=300', etag: true } : undefined)
      } catch (error) {
        const restart = await catalogueCache.getRestart(requestKey)
        if (restart) {
          sendJson(res, 200, responsePayload(restart, 'STALE_RESTART'), clientResponse ? { cacheControl: 'public, max-age=30, stale-while-revalidate=300', etag: true } : undefined)
          return
        }
        sendJson(res, 503, { schemaVersion: 1, cache: { status: 'MISS' }, error: error instanceof Error ? error.message : 'Catalogue unavailable' })
      }
      return
    }

    if (request === '/api/backtests' && req.method === 'GET') {
      try {
        const params = new URL(req.url || '/', `http://${host}`).searchParams
        const modelVersion = params.get('modelVersion') || undefined
        const backtest = await runBacktest(await getDb(), { modelVersion })
        sendJson(res, 200, { schemaVersion: 1, ...backtest })
      } catch (error) {
        sendJson(res, 500, { schemaVersion: 1, error: error instanceof Error ? error.message : 'Backtest unavailable' })
      }
      return
    }

    if (request === '/api/forecast-runs/latest' && req.method === 'GET') {
      try {
        const horizon = Number(new URL(req.url || '/', `http://${host}`).searchParams.get('horizon') || 1)
        const forecast = await latestForecastSummary(await getDb(), { horizon })
        sendJson(res, forecast ? 200 : 404, { schemaVersion: 1, forecast })
      } catch (error) {
        sendJson(res, 400, { schemaVersion: 1, error: error instanceof Error ? error.message : 'Forecast unavailable' })
      }
      return
    }

    if (request === '/api/fpl-data') {
      try {
        const data = await liveData()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          .end(JSON.stringify(data))
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 503, { error: error instanceof Error ? error.message : 'Live data unavailable' })
        }
      }
      return
    }

    if (request === '/api/fpl-refresh' && req.method === 'POST') {
      try {
        if (systemStatus.isIngesting || systemStatus.isSeeding || adminOperationRunning()) {
          sendJson(res, 409, { error: 'Ingestion is already in progress' })
          return
        }
        const triggered = await triggerBackgroundIngest()
        if (triggered) {
          sendJson(res, 202, { message: 'Background FPL data ingestion triggered successfully', status: systemStatus })
        } else {
          sendJson(res, 409, { error: 'Ingestion is already in progress' })
        }
      } catch (err) {
        sendJson(res, 500, { error: err.message })
      }
      return
    }

    if(request==='/api/remote/signals'&&req.method==='GET'){
      if(!requireRemoteToken(req,res))return
      try{
        const params=new URL(req.url||'/',`http://${host}`).searchParams
        const db=await getDb()
        const feed=await getRemoteSignalFeed(db,{
          status:params.get('status'), playerId:params.get('playerId'), since:params.get('since'),
          actionableOnly:['1','true','yes'].includes((params.get('actionableOnly')||'').toLowerCase()), limit:params.get('limit')||100,
        })
        const claims=await unresolvedCreatorClaims(db,params.get('limit')||100)
        const since=params.get('since')?Date.parse(params.get('since')):NaN
        const claimFindings=claims.filter(claim=>!Number.isFinite(since)||!claim.createdAt||Date.parse(claim.createdAt)>since).map(claim=>({
          type:'PLAYER_EVENT', id:claim.id, actionable:true, suggestedAction:'RESOLVE_OR_DISMISS', state:'ACTION_REQUIRED',
          event:claim,
        }))
        const limit=Math.min(500,Math.max(1,Number(params.get('limit'))||100))
        const findings=[]
        for(let index=0;findings.length<limit&&(index<feed.findings.length||index<claimFindings.length);index++){
          if(feed.findings[index])findings.push({...feed.findings[index],type:'SIGNAL'})
          if(claimFindings[index]&&findings.length<limit)findings.push(claimFindings[index])
        }
        sendJson(res,200,{...feed,count:findings.length,actionableCount:findings.filter(item=>item.actionable).length,signalCount:findings.filter(item=>item.type==='SIGNAL').length,playerEventCount:findings.filter(item=>item.type==='PLAYER_EVENT').length,availableSignalCount:feed.findings.length,availablePlayerEventCount:claimFindings.length,findings},{cacheControl:'private, no-store',etag:true})
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Unable to read remote signals'})}
      return
    }

    if(request==='/api/remote/actions'&&req.method==='POST'){
      if(!requireRemoteToken(req,res))return
      try{
        const payload=await readRequestBody(req)
        const action=String(payload.action||'').toLowerCase()
        const db=await getDb()
        if(action==='reprocess'){
          const requestedIds=[...(Array.isArray(payload.signalIds)?payload.signalIds:[]),...(payload.signalId?[payload.signalId]:[])].map(String).filter(Boolean).slice(0,500)
          const includeVerified=payload.includeVerified===true
          const available=await listPlayerSignals(db,{status:requestedIds.length?null:includeVerified?null:'PENDING',limit:500})
          const candidates=(requestedIds.length?available.filter(signal=>requestedIds.includes(signal.id)):available)
            .filter(signal=>includeVerified?signal.interpretation.modelImpact==='ROLE':signal.status==='PENDING')
          const results=[]
          for(const signal of candidates)results.push(await reprocessRemoteSignal(db,signal,{includeVerified}))
          sendJson(res,200,{schemaVersion:1,action,includeVerified,processed:results.length,changed:results.filter(result=>result.changed).length,results})
          return
        }
        if(action==='dismiss_claim'){
          const claimId=String(payload.claimId||'')
          if(!claimId)throw new Error('claimId is required')
          const result=await db.query(`UPDATE "CreatorClaim" SET "match_status"='DISMISSED',"updated_at"=$2 WHERE "id"=$1`,[claimId,new Date().toISOString()])
          if(!result.changes)throw new Error('Creator claim not found')
          sendJson(res,200,{schemaVersion:1,action,claimId,status:'DISMISSED'})
          return
        }
        if(action==='resolve_claim'){
          const result=await resolveCreatorClaim(db,String(payload.claimId||''),{playerId:payload.playerId,rememberAlias:payload.rememberAlias!==false})
          sendJson(res,200,{schemaVersion:1,action,...result,recompute:await triggerForecastRecompute()})
          return
        }
        const actionStatus={approve:'VERIFIED',approve_signal:'VERIFIED',reject:'REJECTED',reject_signal:'REJECTED',expire:'EXPIRED',expire_signal:'EXPIRED'}[action]
        const ids=[...(Array.isArray(payload.signalIds)?payload.signalIds:[]),...(payload.signalId?[payload.signalId]:[])].map(String).filter(Boolean).slice(0,50)
        if(!actionStatus)throw new Error('action must be approve, reject, or expire')
        if(!ids.length)throw new Error('signalId or signalIds is required')
        const status=/** @type {'VERIFIED'|'REJECTED'|'EXPIRED'} */ (actionStatus)
        const signals=await updatePlayerSignalStatuses(db,ids.map(id=>({id,status})),{actorType:'REMOTE_API',reason:String(payload.reason||`Remote action: ${action}`)})
        const recompute=status==='VERIFIED'?await triggerForecastRecompute():null
        sendJson(res,200,{schemaVersion:1,action,signals,count:signals.length,recompute})
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Unable to action remote signals'})}
      return
    }

    if(request==='/api/player-signals'&&req.method==='GET'){
      try{
        const db=await getDb(),params=new URL(req.url||'/',`http://${host}`).searchParams
        const playerId=params.get('playerId')||null,status=params.get('status')||null,sourceType=params.get('sourceType')||null
        const limit=Math.min(500,Math.max(1,Number(params.get('limit'))||200))
        sendJson(res,200,{signals:await listPlayerSignals(db,{playerId,status,sourceType,limit})})
      }catch(error){sendJson(res,500,{error:error instanceof Error?error.message:'Unable to read signals'})}
      return
    }

    if(request==='/api/team-market-snapshots'&&req.method==='GET'){
      try{
        const db=await getDb(),params=new URL(req.url||'/',`http://${host}`).searchParams
        const limit=Math.min(50,Math.max(1,Number(params.get('limit'))||12))
        const marketMaxAgeMs=Number(process.env.FPL_MARKET_MAX_AGE_MS||48*60*60*1000)
        const result=await db.query(`SELECT observation."id",observation."source",observation."external_event_id",observation."captured_at",observation."kickoff_at",observation."home_team_name",observation."away_team_name",observation."home_win_probability",observation."draw_probability",observation."away_win_probability",observation."home_clean_sheet_probability",observation."away_clean_sheet_probability",observation."fixture_id",observation."home_expected_goals",observation."away_expected_goals"
          FROM "MarketFixtureObservation" observation JOIN "FeedRun" run ON run."id"=observation."feed_run_id"
          WHERE run."status" IN ('SUCCEEDED','PARTIAL') AND NOT EXISTS (
            SELECT 1 FROM "MarketFixtureObservation" newer JOIN "FeedRun" newer_run ON newer_run."id"=newer."feed_run_id"
            WHERE newer."external_event_id"=observation."external_event_id" AND newer_run."status" IN ('SUCCEEDED','PARTIAL')
              AND (datetime(newer."captured_at")>datetime(observation."captured_at") OR (newer."captured_at"=observation."captured_at" AND newer."id">observation."id"))
          ) ORDER BY COALESCE(observation."kickoff_at",observation."captured_at") ASC,observation."captured_at" DESC LIMIT $1`,[limit])
        sendJson(res,200,{snapshots:result.rows.map(row=>({id:row.id,source:row.source,externalEventId:row.external_event_id,capturedAt:row.captured_at,kickoff:row.kickoff_at,homeTeam:row.home_team_name,awayTeam:row.away_team_name,homeWinProb:row.home_win_probability==null?null:Number(row.home_win_probability),drawProb:row.draw_probability==null?null:Number(row.draw_probability),awayWinProb:row.away_win_probability==null?null:Number(row.away_win_probability),homeCleanSheetProb:row.home_clean_sheet_probability==null?null:Number(row.home_clean_sheet_probability),awayCleanSheetProb:row.away_clean_sheet_probability==null?null:Number(row.away_clean_sheet_probability),forecastEligible:Boolean(row.fixture_id&&row.home_expected_goals!=null&&row.away_expected_goals!=null&&Date.parse(row.captured_at)>=Date.now()-marketMaxAgeMs)}))})
      }catch(error){sendJson(res,500,{error:error instanceof Error?error.message:'Unable to read market snapshots'})}
      return
    }

    if(request==='/api/player-signals'&&req.method==='POST'){
      try{
        const payload=await readRequestBody(req),db=await getDb()
        if(payload.playerId==null||!payload.kind||!payload.evidenceSummary)throw new Error('playerId, kind and evidenceSummary are required')
        const manual=payload.manualOverride===true
        const observedAt=new Date().toISOString(),validUntil=new Date(payload.validUntil||Date.now()+7*24*60*60*1000)
        if(!Number.isFinite(validUntil.getTime()))throw new Error('validUntil must be a valid timestamp')
        const signal=await createPlayerSignal(db,{playerId:payload.playerId,gameweek:payload.gameweek||null,kind:payload.kind,value:payload.value||{},sourceType:manual?'MANUAL_OVERRIDE':'USER_FEEDBACK',sourceUrl:payload.sourceUrl||null,evidenceSummary:payload.evidenceSummary,evidenceText:payload.evidenceText||payload.evidenceSummary,claimClass:payload.claimClass,interpretationRationale:payload.interpretationRationale,modelImpact:payload.modelImpact,confidence:manual?1:Math.max(0,Math.min(1,Number(payload.confidence)||.4)),observedAt,validUntil:validUntil.toISOString(),status:manual?'VERIFIED':'PENDING'})
        sendJson(res,201,{signal})
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Unable to create signal'})}
      return
    }

    const signalInterpretationMatch=request.match(/^\/api\/player-signals\/([^/]+)\/interpretation$/)
    if(signalInterpretationMatch&&req.method==='PATCH'){
      try{
        const payload=await readRequestBody(req)
        const signal=await revisePlayerSignalInterpretation(await getDb(),decodeURIComponent(signalInterpretationMatch[1]),payload)
        sendJson(res,200,{signal})
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Unable to revise signal interpretation'})}
      return
    }

    const signalStatusMatch=request.match(/^\/api\/player-signals\/([^/]+)$/)
    if(signalStatusMatch&&req.method==='DELETE'){
      try{
        const signal=await deletePlayerSignal(await getDb(),decodeURIComponent(signalStatusMatch[1]))
        sendJson(res,200,{signal})
      }catch(error){
        const message=error instanceof Error?error.message:'Unable to delete signal'
        sendJson(res,message.endsWith('not found')?404:400,{error:message})
      }
      return
    }
    if(signalStatusMatch&&req.method==='PATCH'){
      try{
        const payload=await readRequestBody(req),allowed=new Set(['PENDING','VERIFIED','REJECTED','EXPIRED'])
        if(!allowed.has(payload.status))throw new Error('Invalid signal status')
        const signals=await updatePlayerSignalStatuses(await getDb(),[{id:decodeURIComponent(signalStatusMatch[1]),status:payload.status}])
        sendJson(res,200,{signal:signals[0]})
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Unable to update signal'})}
      return
    }

    if(request==='/api/player-signals/batch-status'&&req.method==='POST'){
      try{
        const payload=await readRequestBody(req)
        const updates=Array.isArray(payload.updates)?payload.updates:[]
        if(!updates.length)throw new Error('updates array is required')
        const allowed=new Set(['PENDING','VERIFIED','REJECTED'])
        if(updates.some((item)=>!item||!String(item.id||'').trim()||!allowed.has(item.status)))throw new Error('Each update must include an id and a valid status')
        const updatedSignals=await updatePlayerSignalStatuses(await getDb(),updates)
        sendJson(res,200,{signals:updatedSignals,count:updatedSignals.length})
      }catch(error){
        sendJson(res,400,{error:error instanceof Error?error.message:'Unable to batch update signals'})
      }
      return
    }

    // Local UI helper for ad-hoc notes. It cannot impersonate a trusted source.
    if(request==='/api/signals/manual'&&req.method==='POST'){
      try{
        const payload=await readRequestBody(req)
        if(!payload.text||typeof payload.text!=='string')throw new Error('text field is required')
        const data=await liveData()
        const text=String(payload.text).slice(0,8000)
        const sourceType='USER_FEEDBACK'
        const sourceUrl=payload.sourceUrl||null
        const gameweek=payload.gameweek||data.currentGameweek||null
        const payloadConfidence=.4
        const drafts=interpretManualSignalText(text,data.players)
        if(!drafts.length){sendJson(res,200,{created:0,signals:[],message:'No player-specific claims could be interpreted safely'});return}
        const db=await getDb()
        const created=[]
        for(const draft of drafts.slice(0,10)){
          const observedAt=new Date().toISOString()
          const validUntil=new Date(Date.now()+7*24*60*60*1000).toISOString()
          const signal=await createPlayerSignal(db,{playerId:draft.playerId,gameweek:null,kind:draft.kind,value:draft.value,sourceType,sourceUrl,evidenceSummary:draft.evidenceSummary,evidenceText:draft.evidenceText,claimClass:draft.claimClass,modelImpact:draft.modelImpact,interpretationRationale:draft.interpretationRationale,confidence:draft.confidence||payloadConfidence,observedAt,validUntil,status:draft.status})
          created.push({...signal,autoApproved:false})
        }
        sendJson(res,201,{created:created.length,signals:created,autoApproved:false})
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Ingest failed'})}
      return
    }

    if(request==='/api/creator-claims'&&req.method==='GET'){
      try{sendJson(res,200,{claims:await unresolvedCreatorClaims(await getDb(),new URL(req.url,'http://localhost').searchParams.get('limit'))})}
      catch(error){sendJson(res,500,{error:error instanceof Error?error.message:'Could not load creator claims'})}
      return
    }

    const creatorClaimMatch=request.match(/^\/api\/creator-claims\/(.+)$/)
    if(creatorClaimMatch&&req.method==='PATCH'){
      try{
        const id=decodeURIComponent(creatorClaimMatch[1]),payload=await readRequestBody(req),db=await getDb()
        const claimResult=await db.query(`SELECT * FROM "CreatorClaim" WHERE "id"=$1 LIMIT 1`,[id])
        const row=claimResult.rows[0]
        if(!row){sendJson(res,404,{error:'Creator claim not found'});return}
        const now=new Date().toISOString()
        if(payload.dismiss){
          await db.query(`UPDATE "CreatorClaim" SET "match_status"='DISMISSED',"updated_at"=$2 WHERE "id"=$1`,[id,now])
          sendJson(res,200,{claim:{...creatorClaimView(row),matchStatus:'DISMISSED'}});return
        }
        const fplId=Number(payload.playerId)
        if(!Number.isInteger(fplId)||fplId<=0)throw new Error('playerId is required')
        const playerResult=await db.query(`SELECT "id","fpl_id" FROM "Player" WHERE "fpl_id"=$1 ORDER BY "season" DESC LIMIT 1`,[fplId])
        const player=playerResult.rows[0]
        if(!player)throw new Error('Player not found')
        const claim=parseJson(row.claim_json,{}),source=parseJson(row.source_json,{})
        const signalValue=Object.fromEntries(['startProbability','minutesIfStarting','substituteProbabilityWhenBenched','minutesIfSubstitute','depthRole','forecastMetric','forecastDirection','forecastProbability','forecastHorizon','confidence'].filter(key=>claim[key]!=null).map(key=>[key,claim[key]]))
        const result=await createSignalForCreatorClaim(db,{...claim,id,externalClaimId:id,resolvedPlayerId:Number(player.fpl_id),signalValue},source,null)
        if(payload.rememberAlias!==false&&normalizeEntityText(row.raw_player_name)){
          await db.query(`INSERT INTO "PlayerAlias" ("id","alias","normalized_alias","player_id","source","created_at","updated_at") VALUES ($1,$2,$3,$4,'USER',$5,$5) ON CONFLICT ("normalized_alias") DO UPDATE SET "player_id"=excluded."player_id","alias"=excluded."alias","updated_at"=excluded."updated_at"`,[randomUUID(),row.raw_player_name,normalizeEntityText(row.raw_player_name),player.id,now])
        }
        await db.query(`UPDATE "CreatorClaim" SET "match_status"='RESOLVED',"resolved_player_id"=$2,"signal_id"=$3,"updated_at"=$4 WHERE "id"=$1`,[id,player.id,String(result.signal.id),now])
        sendJson(res,200,{claimId:id,signal:result.signal,rememberedAlias:payload.rememberAlias!==false})
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Could not resolve creator claim'})}
      return
    }

    const challengeJobMatch=request.match(/^\/api\/challenge-squad\/([a-f0-9-]+)$/)
    if(challengeJobMatch&&req.method==='GET'){
      pruneSquadChallengeJobs()
      const job=squadChallengeJobs.get(challengeJobMatch[1])
      if(!job){sendJson(res,404,{error:'Research job not found or expired'});return}
      if(job.status==='completed'){sendJson(res,200,{status:job.status,result:job.result});return}
      if(job.status==='failed'){sendJson(res,200,{status:job.status,error:job.error,rawOutput:job.rawOutput||'',outputTypes:job.outputTypes||[]});return}
      sendJson(res,200,{status:job.status,elapsedSeconds:Math.floor((Date.now()-job.createdAt)/1000)})
      return
    }

    if(request==='/api/challenge-squad'&&req.method==='POST'){
      try{
        const payload=await readRequestBody(req),data=await liveData()
        const requestedIds=new Set((Array.isArray(payload.playerIds)?payload.playerIds:[]).filter(Number.isInteger).slice(0,15))
        const startingIds=new Set((Array.isArray(payload.startingPlayerIds)?payload.startingPlayerIds:[]).filter(Number.isInteger).slice(0,11))
        const selected=data.players.filter(player=>requestedIds.has(player.id)).map(player=>({...player,isStarter:startingIds.has(player.id),projectedPoints:Number(payload.projections?.[player.id])||null}))
        if(!selected.length)throw new Error('At least one valid squad player is required')
        const jobId=randomUUID(),createdAt=Date.now()
        squadChallengeJobs.set(jobId,{status:'running',createdAt,updatedAt:createdAt})
        void (async()=>{
          try{
            const challenge=await callGroundedSquadChallenge(selected,data.currentGameweek,data.deadline,{userApiKey:payload.userApiKey,userProvider:payload.userProvider,userModel:payload.userModel})
            await recordAiUsage({feature:'SQUAD_CHALLENGE',result:{provider:challenge.provider,model:challenge.provider.match(/\((.+)\)$/)?.[1]||'Unknown',usage:challenge.usage,billingSource:payload.userApiKey?'USER_API_KEY':'SERVER_API_KEY'}})
            const result=await persistChallengeSignals(challenge,data.currentGameweek)
            squadChallengeJobs.set(jobId,{status:'completed',result,createdAt,updatedAt:Date.now()})
          }catch(error){
            squadChallengeJobs.set(jobId,{status:'failed',error:error instanceof Error?error.message:'Squad challenge failed',rawOutput:error?.rawOutput||'',outputTypes:error?.outputTypes||[],createdAt,updatedAt:Date.now()})
          }
        })()
        pruneSquadChallengeJobs()
        sendJson(res,202,{jobId,status:'running',auditTargetCount:prioritySquadAudit(selected).length})
      }catch(error){sendJson(res,500,{error:error instanceof Error?error.message:'Squad challenge failed'})}
      return
    }

    if (request === '/api/manager/import' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req)
        const db = await getDb()
        const payload = await fetchManagerPayload({ teamId: body.teamId, gameweek: body.gameweek })
        const importedAt = new Date().toISOString()
        if (!payload.squadAvailable) {
          const manager = await linkManagerAccount(db, {
            entry: payload.entry,
            gameweek: payload.gameweek,
            linkedAt: importedAt,
          })
          sendJson(res, 200, {
            ...manager,
            account: { ...manager.account, leagues: payload.entry?.leagues || { classic: [], h2h: [] } },
            importStatus: {
              squadAvailable: false,
              code: 'SQUAD_NOT_PUBLIC',
              message: `Account linked, but FPL has not made the GW${payload.gameweek} squad public yet. Sync again after the deadline to import the official 15-player squad.`,
            },
          })
        } else {
          const manager = await importManagerPayload(db, {
            ...payload,
            season: body.season,
            importedAt,
          })
          sendJson(res, 200, {
            ...manager,
            account: { ...manager.account, leagues: payload.entry?.leagues || { classic: [], h2h: [] } },
            importStatus: { squadAvailable: true, code: 'SQUAD_IMPORTED' },
          })
        }
        scheduleAuxiliaryRefreshes().catch(error => console.error('⚠️ Could not update manager refresh schedule:', sanitizeError(error)))
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Manager import failed' })
      }
      return
    }

    if (request === '/api/manager/current' && req.method === 'GET') {
      try {
        const params = new URL(req.url || '/', `http://${host}`).searchParams
        const teamId = params.get('teamId')
        const db = await getDb()
        const manager = await getCurrentManager(db, {
          fplEntryId: teamId ? Number(teamId) : undefined,
          season: params.get('season') || undefined,
        })
        sendJson(res, manager.account ? 200 : 404, manager)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Manager state unavailable' })
      }
      return
    }

    if (request === '/api/manager/rank-history' && req.method === 'GET') {
      try {
        const params = new URL(req.url || '/', `http://${host}`).searchParams
        const teamId = params.get('teamId')
        if (!teamId) throw new Error('teamId is required')
        sendJson(res, 200, { history: await fetchManagerRankHistory({ teamId }) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Manager rank history unavailable' })
      }
      return
    }

    if (request === '/api/manager/current' && req.method === 'DELETE') {
      try {
        const db = await getDb()
        await unlinkCurrentManager(db)
        await scheduleAuxiliaryRefresh('manager')
        sendJson(res, 200, { success: true })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Manager could not be unlinked' })
      }
      return
    }

    if (request === '/api/manager/assumptions' && req.method === 'PATCH') {
      try {
        const body = await readRequestBody(req)
        const db = await getDb()
        const current = await getCurrentManager(db, { fplEntryId: body.teamId === undefined ? undefined : Number(body.teamId) })
        const fplEntryId = body.teamId ?? current.account?.teamId
        const manager = await updateManagerAssumptions(db, {
          fplEntryId,
          season: body.season,
          gameweek: body.gameweek,
          freeTransfers: body.freeTransfers,
          sellingPrices: body.sellingPrices || body.selling_prices,
          createdAt: new Date().toISOString(),
        })
        if (body.freeTransfers !== undefined && manager.activePlan) {
          manager.activePlan = await createPlan(db, {
            fplEntryId,
            parentPlanId: manager.activePlan.id,
            playerIds: manager.activePlan.players.map(player => player.fplId),
            lockedPlayerIds: manager.activePlan.players.filter(player => player.locked).map(player => player.fplId),
            freeTransfers: body.freeTransfers,
            name: manager.activePlan.name,
            status: 'ACTIVE',
            changeSummary: { kind: 'FREE_TRANSFERS_CONFIRMED' },
            createdAt: new Date().toISOString(),
          })
        }
        sendJson(res, 200, manager)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Manager assumptions could not be saved' })
      }
      return
    }

    if (request === '/api/plans' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req)
        const db = await getDb()
        const plan = await createPlan(db, {
          fplEntryId: body.teamId,
          managerAccountId: body.managerAccountId,
          snapshotId: body.snapshotId,
          parentPlanId: body.parentPlanId,
          name: body.name,
          status: body.status,
          playerIds: body.playerIds,
          lockedPlayerIds: body.lockedPlayerIds,
          bankTenths: body.bankTenths,
          freeTransfers: body.freeTransfers,
          changeSummary: body.changeSummary || {},
          createdAt: new Date().toISOString(),
        })
        sendJson(res, 201, plan)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Plan could not be created' })
      }
      return
    }

    if (request === '/api/plans/current' && req.method === 'GET') {
      try {
        const params = new URL(req.url || '/', `http://${host}`).searchParams
        const db = await getDb()
        const plan = await getActivePlan(db, { fplEntryId: params.get('teamId') ? Number(params.get('teamId')) : undefined })
        sendJson(res, plan ? 200 : 404, { plan })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Active plan unavailable' })
      }
      return
    }

    const planSelectMatch = request.match(/^\/api\/plans\/([^/]+)\/select$/)
    if (planSelectMatch && req.method === 'POST') {
      try {
        const db = await getDb()
        const plan = await selectPlan(db, decodeURIComponent(planSelectMatch[1]))
        sendJson(res, 200, plan)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Plan could not be selected' })
      }
      return
    }

    const planRecommendationMatch = request.match(/^\/api\/plans\/([^/]+)\/recommendations$/)
    if (planRecommendationMatch && req.method === 'POST') {
      try {
        const body = await readRequestBody(req)
        const db = await getDb()
        let league = null
        try {
          const state = await getUserState(db)
          if (state.preferences.defaultLeagueId != null) {
            const details = await loadLeagueDetailsWithEO(state.preferences.defaultLeagueId, body.gameweek)
            if (details && details.effectiveOwnership?.length) league = leagueCoverageFromResponse(details)
          }
        } catch (leagueError) {
          league = null
        }
        const recommendation = await createRecommendationSet(db, {
          planId: decodeURIComponent(planRecommendationMatch[1]),
          forecastRunId: body.forecastRunId,
          horizon: body.horizon ?? 1,
          maxTransfers: body.maxTransfers ?? 5,
          uncertaintyPenaltyRate: body.uncertaintyPenaltyRate ?? .15,
          chip: body.chip ?? null,
          league,
        })
        if (recommendation.league && league?.coverageByFplId?.size) {
          recommendation.league.coverageByFplId = Object.fromEntries(league.coverageByFplId)
        }
        sendJson(res, 201, { schemaVersion: 1, ...recommendation })
      } catch (error) {
        sendJson(res, 400, { schemaVersion: 1, error: error instanceof Error ? error.message : 'Recommendation could not be generated' })
      }
      return
    }

    if (request === '/api/decisions' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req)
        const decision = await recordDecision(await getDb(), {
          recommendationSetId: body.recommendationSetId,
          candidateId: body.candidateId ?? null,
          decision: body.decision,
          selectedPlanId: body.selectedPlanId ?? null,
          reason: body.reason ?? null,
        })
        sendJson(res, 201, { schemaVersion: 1, ...decision })
      } catch (error) {
        sendJson(res, 400, { schemaVersion: 1, error: error instanceof Error ? error.message : 'Decision could not be recorded' })
      }
      return
    }

    if (request.startsWith('/api/decisions') && req.method === 'GET') {
      try {
        const limit = Number(new URL(req.url || '/', 'http://localhost').searchParams.get('limit') || 50)
        sendJson(res, 200, { schemaVersion: 1, decisions: await listDecisions(await getDb(), { limit }) })
      } catch (error) {
        sendJson(res, 400, { schemaVersion: 1, error: error instanceof Error ? error.message : 'Decision history could not be loaded' })
      }
      return
    }

    const decisionEvaluateMatch = request.match(/^\/api\/decisions\/([^/]+)\/evaluate$/)
    if (decisionEvaluateMatch && req.method === 'POST') {
      try {
        const decision = await evaluateDecision(await getDb(), decodeURIComponent(decisionEvaluateMatch[1]))
        sendJson(res, 200, { schemaVersion: 1, ...decision })
      } catch (error) {
        sendJson(res, 400, { schemaVersion: 1, error: error instanceof Error ? error.message : 'Decision could not be evaluated' })
      }
      return
    }

    if (request === '/api/fpl-league-details') {
      const urlParams = new URLSearchParams((req.url || '').split('?')[1] || '')
      const leagueIdStr = urlParams.get('leagueId')
      const leagueId = leagueIdStr ? Number(leagueIdStr) : null
      if (!leagueId || isNaN(leagueId)) {
        sendJson(res, 400, { error: 'Valid numeric leagueId parameter is required' })
        return
      }

      const requestedGameweek = urlParams.get('gameweek') || ''
      const youEntryParam = urlParams.get('youEntry')
      const youEntry = youEntryParam && !isNaN(Number(youEntryParam)) ? Number(youEntryParam) : undefined

      try {
        const response = await loadLeagueDetailsWithEO(leagueId, requestedGameweek, { youEntry })
        sendJson(res, 200, response)
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : 'FPL league details fetch failed' })
        }
      }
      return
    }

    if (request === '/api/user-profile') {
      if (req.method === 'GET') {
        const db = await getDb()
        const [manager, state] = await Promise.all([getCurrentManager(db), getUserState(db)])
        const selectedIds = manager.activePlan?.players?.map(player => player.fplId) || null
        sendJson(res, 200, {
          account: manager.account,
          selectedIds,
          preferences: {
            ...state.preferences,
            selectedIds: selectedIds || [],
            lockedIds: manager.activePlan?.players?.filter(player => player.locked).map(player => player.fplId) || [],
            bank: manager.activePlan?.bankTenths == null ? state.preferences.bank : manager.activePlan.bankTenths / 10,
            freeTransfers: manager.activePlan?.freeTransfers ?? state.preferences.freeTransfers,
          },
        })
        return
      }
      if (req.method === 'POST') {
        sendJson(res, 410, { error: 'Use /api/manager/import and /api/plans; legacy profile writes are disabled' })
        return
      }
      if (req.method === 'DELETE') {
        await unlinkCurrentManager(await getDb())
        await scheduleAuxiliaryRefresh('manager')
        sendJson(res, 200, { success: true })
        return
      }
      sendJson(res, 405, { error: 'Method not allowed' })
      return
    }

    if (request === '/api/user-preferences' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req)
        const db = await getDb()
        const state = await updateUserState(db, body)
        sendJson(res, 200, { success: true, preferences: state.preferences })
      } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : 'Could not save user preferences' }) }
      return
    }

    if (request === '/api/user-preferences' && req.method === 'GET') {
      try {
        const state = await getUserState(await getDb())
        sendJson(res, 200, state.preferences)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Could not load user preferences' })
      }
      return
    }


    if (request === '/api/ask' && req.method === 'POST') {
      try {
          const payload = await readRequestBody(req)
          const { question, context, userApiKey, userProvider, userModel } = payload
          if (!question) {
            sendJson(res, 400, { error: 'Question is required' })
            return
          }

          const sanitizedContext = context && typeof context==='object' ? context : {}
          const prompt = [
            `You are Insomnia FPL, an expert Fantasy Premier League squad advisor.`,
            `Answer the exact question using only the compact deterministic context. The engine has already calculated legality, budget, hit costs and projections; do not recalculate or invent alternatives.`,
            `For named_player_transfer, explicitly name the best route's moves, bankAfter, hitCost and netGain. Mention at most two alternatives. If routes is empty, say that no legal route was found.`,
            `For player_comparison, complete statistics are provided in 'players' and 'comparisonSummary' for all resolved players. Compare all listed candidates directly using their projected points (xPts), price, club, and upcoming fixtures. Give a clear decision on which player to prioritize. Do NOT claim stats or data are missing for any player present in 'players' or 'comparisonSummary'.`,
            `For position_ranking, complete statistics are provided in 'rankedPlayers' and 'rankingSummary'. Directly list and analyze all candidates provided in 'rankedPlayers' in order of their projected points (xPts). Mention their price, club, xPts, and upcoming fixtures. Give a clear verdict on the best options and captaincy/transfer considerations. Do NOT claim stats or rankings are missing.`,
            `For player_question, complete statistics are provided in 'player' and 'playerSummary'. Provide a concise analysis of the player's projections, fixtures, role, and owned status. Do NOT claim stats or data are missing.`,
            `For other intents, discuss only the fields relevant to that intent. Never dump the whole squad unless intent is lineup.`,
            `Use official FPL terms. Treat pricingBasis as a required caveat when discussing affordability.`,
            `Return one valid JSON object and no Markdown with this exact shape: {"verdict":"direct answer","reasoning":["up to three concise evidence points"],"recommendation":"one next action","caveat":"short caveat or empty string"}.`,
            `Keep the complete answer below 350 words.`,
            `User Question: ${question}`,
            `Deterministic Context: ${JSON.stringify(sanitizedContext)}`
          ].join('\n')

          const llmResult = await callLLMProvider(prompt, { userApiKey, userProvider, userModel })
          if (llmResult) {
            await recordAiUsage({feature:'ASK',result:llmResult})
            sendJson(res, 200, llmResult)
          } else {
            sendJson(res, 200, {
              answer: null,
              provider: 'Deterministic Engine (No API Key)'
            })
          }
      } catch (err) {
        if (!res.headersSent) sendJson(res, errorStatus(err), { error: sanitizeError(err) })
      }
      return
    }

    if (request.startsWith('/api/')) {
      sendJson(res, 404, { error: 'API route not found' })
      return
    }

    const file = path.join(process.cwd(), 'dist', request === '/' ? 'index.html' : request)
    if (!file.startsWith(path.join(process.cwd(), 'dist'))) return res.writeHead(403).end()
    fs.readFile(file, (error, data) => {
      if (error) {
        if (!path.extname(request)) {
          const indexPath = path.join(process.cwd(), 'dist', 'index.html')
          return fs.readFile(indexPath, (err2, indexData) => {
            if (err2) return res.writeHead(404).end('Not found')
            const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', etag: responseEtag(indexData) }
            sendBody(res, 200, indexData, headers)
          })
        }
        return res.writeHead(404).end('Not found')
      }
      const extension = path.extname(file)
      const headers = {
        'content-type': mime[extension] || 'application/octet-stream',
        'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=0, must-revalidate',
        etag: responseEtag(data),
      }
      sendBody(res, 200, data, headers)
    })
  })

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`⚠️ Port ${targetPort} in use, trying ${targetPort + 1}...`)
      startServerOnAvailablePort(targetPort + 1)
    } else {
      console.error(`❌ Dev server error: ${sanitizeError(err)}`)
      process.exit(1)
    }
  })

  server.listen(targetPort, host, () => {
    console.log(`Insomnia FPL running at http://${host}:${targetPort}`)
    performColdStartInitialization().catch(err => console.error('Cold-start initialization failed:', sanitizeError(err)))
  })
}

startServerOnAvailablePort(port)
