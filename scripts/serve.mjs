import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { resolvePlayerRole } from '../src/player-signals.ts'
import { matchCreatorClaim, normalizeCreatorPayload, signalDraftFromClaim } from './creator-signals.mjs'

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
import { fetchManagerPayload, getCurrentManager, importManagerPayload, linkManagerAccount, unlinkCurrentManager, updateManagerAssumptions } from './manager-service.mjs'
import { createPlan, getActivePlan, selectPlan } from './plan-service.mjs'
import { createRecommendationSet } from './recommendation-service.mjs'
import { evaluateDecision, listDecisions, recordDecision } from './decision-journal-service.mjs'
import { getUserState, updateAiState, updateUserState } from './user-state-service.mjs'
import { assembleProjectionInputCatalog, projectionCatalogInputVersions } from '../src/server/catalog-service.ts'
import { runBacktest } from '../src/server/backtest-service.ts'
import { latestForecastSummary } from '../src/server/forecast-service.ts'
import { CatalogueCache, catalogueCacheKey, catalogueRequestKey } from '../src/server/catalog-cache.ts'
import { ConcurrencyLimiter, TtlCache } from '../src/server/upstream-control.ts'
import { HttpRequestError, MAX_JSON_BODY_BYTES, readJsonBody, sanitizeError } from '../src/server/http-security.mjs'
import { createPlayerSignal, listPlayerSignals, updatePlayerSignalStatuses } from '../src/server/signal-service.ts'
import { latestSuccessfulFeedRun } from './feed-run.mjs'
import { nextIngestSchedule, parseIngestIntervalHours } from '../src/server/ingest-scheduler.ts'

let systemStatus = {
  status: 'initializing',
  isSeeding: false,
  isIngesting: false,
  message: 'Initializing database schema...',
  playerCount: 0,
  lastIngestedAt: null,
  nextIngestAt: null,
  ingestIntervalHours: 12
}

let scheduledIngestTimer = null
const INGEST_RETRY_DELAY_MS = 15 * 60 * 1000
const MAX_TIMER_DELAY_MS = 2_147_483_647

const adminOperations = Object.fromEntries(['fpl-sync', 'odds-sync', 'team-refresh', 'relink-player-teams'].map(id => [id, {
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
  setAdminOperation(id, { status: 'RUNNING', startedAt, finishedAt: null, message: 'Operation started', error: null })
  void work().then(result => {
    setAdminOperation(id, { status: 'SUCCEEDED', finishedAt: new Date().toISOString(), message: result || 'Operation completed', error: null })
  }).catch(error => {
    setAdminOperation(id, { status: 'FAILED', finishedAt: new Date().toISOString(), message: null, error: sanitizeError(error) })
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
  if (hours <= 0) {
    console.log('⏱️ Periodic FPL ingestion is disabled (FPL_INGEST_INTERVAL_HOURS=0).')
    systemStatus.nextIngestAt = null
    return
  }
  console.log(`⏱️ Periodic FPL ingestion is enabled every ${hours} hour(s).`)
}

async function scheduleNextIngestion({ notBefore = 0 } = {}) {
  clearScheduledIngestion()
  const hours = systemStatus.ingestIntervalHours
  if (!(hours > 0)) {
    systemStatus.nextIngestAt = null
    return
  }
  const latest = await latestSuccessfulFeedRun(await getDb(), 'OFFICIAL_FPL')
  const completedAt = latest?.finished_at || latest?.started_at || null
  const schedule = nextIngestSchedule(completedAt, hours, Date.now(), notBefore)
  systemStatus.lastIngestedAt = schedule.lastIngestedAt
  systemStatus.nextIngestAt = schedule.nextIngestAt
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

function readRequestBody(req) { return readJsonBody(req) }

function errorStatus(error, fallback = 500) {
  return error instanceof HttpRequestError ? error.status : fallback
}

function sendJson(res,status,payload){
  let safePayload = payload
  if (status >= 400) {
    const rawError = payload && typeof payload === 'object' ? payload.error : null
    const message = sanitizeError(typeof rawError === 'string' ? rawError : rawError?.message || 'Request failed')
    const code = typeof rawError === 'object' && rawError?.code ? String(rawError.code) : ({ 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 410: 'GONE', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE' })[status] || (status >= 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`)
    const { error: _discardedError, schemaVersion: _discardedVersion, ...context } = payload && typeof payload === 'object' ? payload : {}
    safePayload = { schemaVersion: 1, ...context, error: { code, message, requestId: res.requestId || 'unknown' } }
  }
  const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store'}
  if(res.requestId)headers['x-request-id']=res.requestId
  res.writeHead(status,headers).end(JSON.stringify(safePayload))
}

// ── Signal source config (persisted beside the SQLite database) ─────────────
function appDataFile(filename) {
  const rawDatabasePath=process.env.DATABASE_URL||'file:./dev.db'
  const cleanDatabasePath=rawDatabasePath.replace(/^file:\/\//,'').replace(/^file:/,'')
  const resolvedDatabasePath=path.isAbsolute(cleanDatabasePath)?cleanDatabasePath:path.resolve(cleanDatabasePath)
  return path.join(path.dirname(resolvedDatabasePath),filename)
}
const SIGNAL_CONFIG_PATH = process.env.SIGNAL_CONFIG_FILE || appDataFile('signal-config.json')
const DEFAULT_SOURCE_CONFIG = {
  OFFICIAL_FPL:      { autoApprove: true,  confidenceThreshold: 0.5 },
  OFFICIAL_CLUB:     { autoApprove: true,  confidenceThreshold: 0.5 },
  OFFICIAL_PL:       { autoApprove: true,  confidenceThreshold: 0.5 },
  YOUTUBE_TRANSCRIPT:{ autoApprove: false, confidenceThreshold: 0.6 },
  JOURNALIST:        { autoApprove: false, confidenceThreshold: 0.6 },
  LLM_RESEARCH:      { autoApprove: false, confidenceThreshold: 0.7 },
  SCRAPE:            { autoApprove: false, confidenceThreshold: 0.6 },
  PREDICTED_LINEUP:  { autoApprove: false, confidenceThreshold: 0.65 },
  USER_FEEDBACK:     { autoApprove: false, confidenceThreshold: 0.4 },
  MANUAL_OVERRIDE:   { autoApprove: true,  confidenceThreshold: 0.0 },
}
function loadSignalConfig() {
  try {
    if (fs.existsSync(SIGNAL_CONFIG_PATH)) {
      return { ...DEFAULT_SOURCE_CONFIG, ...JSON.parse(fs.readFileSync(SIGNAL_CONFIG_PATH, 'utf8')) }
    }
  } catch {}
  return { ...DEFAULT_SOURCE_CONFIG }
}
function saveSignalConfig(config) {
  fs.mkdirSync(path.dirname(SIGNAL_CONFIG_PATH),{recursive:true})
  fs.writeFileSync(SIGNAL_CONFIG_PATH, JSON.stringify(config, null, 2))
}

const AI_SETTINGS_PATH = process.env.AI_SETTINGS_FILE || appDataFile('ai-settings.json')
const catalogueCache = new CatalogueCache({
  ttlMs: Number(process.env.FPL_CATALOG_CACHE_TTL_MS || 60_000),
  maxStaleMs: Number(process.env.FPL_CATALOG_CACHE_MAX_STALE_MS || 24 * 60 * 60 * 1000),
  filePath: process.env.FPL_CATALOG_CACHE_FILE || appDataFile('cache/projection-catalog.json'),
})
const leagueCache = new TtlCache(5 * 60 * 1000)
const leagueUpstream = new ConcurrencyLimiter(5)

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
function shouldAutoApprove(sourceType, confidence, config) {
  const entry = (config || loadSignalConfig())[sourceType]
  if (!entry) return false
  return entry.autoApprove && confidence >= (entry.confidenceThreshold ?? 0)
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

function requireIngestToken(req,res){
  const expected=process.env.SIGNAL_INGEST_TOKEN||''
  if(!expected){sendJson(res,503,{error:'SIGNAL_INGEST_TOKEN is not configured'});return false}
  if(!tokenMatches(bearerToken(req),expected)){sendJson(res,401,{error:'Invalid ingestion token'});return false}
  return true
}

function requireAdminToken(req, res) {
  const expected = process.env.ADMIN_TOKEN || ''
  if (!expected) return true
  if (!tokenMatches(bearerToken(req), expected)) { sendJson(res, 401, { error: 'Invalid admin token' }); return false }
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
  const [runs, unresolved, manager] = await Promise.all([
    db.query(`SELECT "id","source","status","started_at","finished_at","inserted_count","updated_count","unmatched_count","used_cache","error_summary"
      FROM "FeedRun" ORDER BY "started_at" DESC LIMIT 12`),
    db.query(`SELECT
      (SELECT COUNT(*) FROM "UnderlyingObservation" WHERE "match_status" != 'MATCHED') AS unresolved_players,
      (SELECT COUNT(*) FROM "MarketFixtureObservation" WHERE "fixture_id" IS NULL) AS unresolved_fixtures`),
    getCurrentManager(db).catch(() => null),
  ])
  return {
    schemaVersion: 1,
    authenticationRequired: Boolean(process.env.ADMIN_TOKEN),
    operations: publicAdminOperations(),
    feedRuns: runs.rows.map(row => ({ id: row.id, source: row.source, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, insertedCount: Number(row.inserted_count), updatedCount: Number(row.updated_count), unmatchedCount: Number(row.unmatched_count), usedCache: Boolean(row.used_cache), error: row.error_summary })),
    unresolved: { players: Number(unresolved.rows[0]?.unresolved_players || 0), fixtures: Number(unresolved.rows[0]?.unresolved_fixtures || 0) },
    manager: manager?.account ? { teamId: manager.account.teamId, teamName: manager.account.teamName, lastSynced: manager.account.lastSynced, playerCount: manager.squad?.length || 0 } : null,
    oddsConfigured: Boolean(process.env.ODDS_API_KEY),
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

function validityDeadline(timeHorizon){
  const days={GW1:7,SHORT_TERM:14,MEDIUM_TERM:42,SEASON:120,UNKNOWN:14}[String(timeHorizon||'').toUpperCase()]||14
  return new Date(Date.now()+days*24*60*60*1000).toISOString()
}

async function createSignalForCreatorClaim(db,claimRow,source,gameweek){
  const signalValue=parseJson(claimRow.signalValue,{})
  const draft=signalDraftFromClaim({...claimRow,...signalValue,numericClaims:parseJson(claimRow.numericClaims,[]),relatedMentions:parseJson(claimRow.relatedMentions,[])},Number(claimRow.resolvedPlayerId),source)
  const confidence=Math.max(0,Math.min(1,Number(draft.confidence)||.65))
  const status=shouldAutoApprove('YOUTUBE_TRANSCRIPT',confidence,loadSignalConfig())?'VERIFIED':'PENDING'
  const observedAt=new Date().toISOString()
  const id=`creator:${String(claimRow.externalClaimId||claimRow.id).slice(0,220)}`
  const existing=await listPlayerSignals(db,{playerId:draft.playerId,limit:500})
  if(existing.some(signal=>signal.id===id))return {signal:existing.find(signal=>signal.id===id),created:false}
  const signal=await createPlayerSignal(db,{id,playerId:draft.playerId,gameweek,kind:draft.kind,value:draft.value,sourceType:draft.sourceType,sourceUrl:draft.sourceUrl,evidenceSummary:draft.evidenceSummary,confidence,observedAt,validUntil:validityDeadline(claimRow.timeHorizon),status,actorType:'INGESTION'})
  return {signal,created:true}
}

async function processCreatorPayload(rawPayload){
  const payload=normalizeCreatorPayload(rawPayload),db=await getDb(),data=await liveData()
  const contentId=`${payload.source.platform}:${payload.source.externalId}`
  const results=[]
  for(const claim of payload.claims){
    const match=matchCreatorClaim(claim,data.players,[])
    const resolvedPlayerId=match.player?.id||null
    const signalValue=Object.fromEntries(['startProbability','minutesIfStarting','substituteProbabilityWhenBenched','minutesIfSubstitute','depthRole','confidence'].filter(key=>claim[key]!=null).map(key=>[key,claim[key]]))
    const candidates=Array.isArray(match.candidates)&&match.candidates[0]?.player?compactCandidates(match.candidates):match.candidates||[]
    let signalResult=null
    if(match.status==='MATCHED'&&resolvedPlayerId){
      signalResult=await createSignalForCreatorClaim(db,{...claim,id:claim.externalClaimId,externalClaimId:claim.externalClaimId,resolvedPlayerId,signalValue},payload.source,data.currentGameweek)
    }
    results.push({id:claim.externalClaimId,rawPlayerName:claim.rawPlayerName,matchStatus:match.status,resolvedPlayerId,confidence:match.confidence,candidates,signalId:signalResult?.signal?.id||null,created:Boolean(signalResult?.created)})
  }
  const unresolved=results.filter(row=>row.matchStatus!=='MATCHED').length
  return {contentId,created:results.filter(row=>row.created).length,matched:results.length-unresolved,unresolved,claims:results}
}


async function liveData() {
  return refreshLiveData()
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
    const baseRole={startProbability:Math.max(0,Math.min(1,availability/100)),minutesIfStarting:item.official.position==='GK'?90:86,substituteProbabilityWhenBenched:item.official.position==='GK'?.005:.2,minutesIfSubstitute:item.official.position==='GK'?5:18,confidence:'MEDIUM',derivedFromSignalIds:[]}
    const signals=item.roleSignals.map(signal=>({id:signal.id,playerId:item.fplId,gameweek:null,kind:signal.kind,value:signal.value,sourceType:signal.sourceType,sourceUrl:signal.sourceUrl||null,evidenceSummary:signal.evidenceSummary||'',confidence:Number(signal.confidence??1),observedAt:signal.observedAt,validUntil:signal.validUntil,status:'VERIFIED'}))
    const roleProfile=resolvePlayerRole(baseRole,signals,{now:new Date(asOf),gameweek:currentGameweek||undefined})
    const expectedMinutes=roleProfile.startProbability*roleProfile.minutesIfStarting+(1-roleProfile.startProbability)*roleProfile.substituteProbabilityWhenBenched*roleProfile.minutesIfSubstitute
    return {id:item.fplId,name:item.name,club:item.team.shortName,clubName:item.team.name,position:official.position,price:Number(official.price_tenths||0)/10,form:Number(official.form||0),ownership:Number(official.ownership_percent||0),minutes:availability,expectedMinutes,roleProfile,fixture:first?`${first.opponent.shortName} (${first.isHome?'H':'A'})`:'Blank',difficulty:first?.difficulty||3,projection:Number(official.ep_next||0),colour:colours[index%colours.length],status:String(official.status||'a'),chanceOfPlaying:official.chance_of_playing==null?undefined:Number(official.chance_of_playing),news:official.news||null,transfersIn:Number(official.transfers_in||0),transfersOut:Number(official.transfers_out||0),active:Boolean(official.active),dataConfidence:item.provenance.underlyingObservationId?'HIGH':'MEDIUM',upcomingFixtures:item.fixtures.map(fixture=>({gameweek:fixture.gameweekFplId||0,opponent:fixture.opponent.shortName,venue:fixture.isHome?'H':'A',difficulty:fixture.difficulty||3})),stats:{minutes:Number(official.minutes||0),starts:Number(official.starts||0),totalPoints:Number(official.total_points||0),goals:Number(official.goals_scored||0),assists:Number(official.assists||0),cleanSheets:Number(official.clean_sheets||0),goalsConceded:Number(official.goals_conceded||0),saves:Number(official.saves||0),bonus:Number(official.bonus||0),bps:Number(official.bps||0),yellowCards:Number(official.yellow_cards||0),redCards:Number(official.red_cards||0),ownGoals:Number(official.own_goals||0),penaltiesMissed:Number(official.penalties_missed||0),penaltiesSaved:Number(official.penalties_saved||0),expectedGoals:Number(official.expected_goals||0),expectedAssists:Number(official.expected_assists||0),expectedGoalsConceded:Number(official.expected_goals_conceded||0)}}
  })
  return {capturedAt:catalog.freshness.official.observedAt||catalog.asOf,currentGameweek,deadline,modelVersion:'role-aware-v2.0',players,freshness:catalog.freshness,inputHash:catalog.inputHash}
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

  if (geminiKey && (userProvider === 'gemini' || !userKey)) {
    const model = customConfig.userModel || process.env.GEMINI_MODEL || 'gemini-2.0-flash'
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig:{maxOutputTokens:1200,responseMimeType:'application/json'} })
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Gemini API error ${res.status}: ${errText}`)
    }
    const data = await res.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (text) return { answer: formatProviderAnswer(text), provider: `Gemini (${model})` }
  }

  if (openaiKey && (userProvider === 'openai' || !userKey)) {
    const model = customConfig.userModel || process.env.OPENAI_MODEL || 'gpt-4o-mini'
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_completion_tokens:1200, response_format:{type:'json_object'} })
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`OpenAI API error ${res.status}: ${errText}`)
    }
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content
    if (text) return { answer: formatProviderAnswer(text), provider: `OpenAI (${model})` }
  }

  if (deepseekKey && userProvider === 'deepseek') {
    const model = customConfig.userModel || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${deepseekKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1200, response_format: { type: 'json_object' } })
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`DeepSeek API error ${res.status}: ${errText}`)
    }
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content
    if (text) return { answer: formatProviderAnswer(text), provider: `DeepSeek (${model})` }
  }

  if (anthropicKey && (userProvider === 'anthropic' || !userKey)) {
    const model = customConfig.userModel || process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022'
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens:1200, messages: [{ role: 'user', content: prompt }] })
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Anthropic API error ${res.status}: ${errText}`)
    }
    const data = await res.json()
    const text = data.content?.[0]?.text
    if (text) return { answer: formatProviderAnswer(text), provider: `Anthropic (${model})` }
  }

  try {
    const res = await fetch(`${ollamaHost}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', prompt, stream: false, format:'json', options:{num_predict:650} })
    })
    if (res.ok) {
      const data = await res.json()
      if (data.response) return { answer: formatProviderAnswer(data.response), provider: 'Ollama (Local)' }
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
      required:['playerId','playerName','kind','value','sourceType','sourceUrl','sourceTitle','evidenceSummary','confidence','validUntil'],
      properties:{
        playerId:{type:'integer'},playerName:{type:'string'},
        kind:{type:'string',enum:['START_PROBABILITY','DEPTH_CHART','INJURY','EXPECTED_ROLE','PENALTIES','SET_PIECES','PRESEASON_MINUTES']},
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
    'Every signal must have a directly supporting source URL you actually opened. Copy sourceUrl verbatim from a URL returned by web search; do not reconstruct or rewrite it. If evidence is conflicting, lower confidence and explain the conflict. Start probabilities are calibrated estimates between 0.0 and 1.0 (e.g. 0.05 for 5%, 0.15 for 15%), NOT percentages over 1.0.',
    'You must return exactly one audits entry for every player in Priority audit. Do not spend searches proving routine low-risk starters are safe. For a budget goalkeeper, explicitly establish whether they are first choice, competition, or backup. For a recent transfer, explicitly establish their expected new-team role rather than carrying forward old-club minutes.',
    'Use outcome MATERIAL_RISK whenever the evidence implies a meaningful projection change, and include a matching signal for that player. NO_MATERIAL_RISK requires a supporting searched source. Use INSUFFICIENT_EVIDENCE only after searching; its sourceUrl may be an empty string.',
    'Keep the overall summary under 180 words and each audit or signal evidenceSummary under 80 words. Return only the requested JSON object—no preamble, no markdown, and no conversational explanation before or after it.',
    'JSON shape is exactly: {"summary":string,"audits":[{"playerId":number,"playerName":string,"outcome":"MATERIAL_RISK"|"NO_MATERIAL_RISK"|"INSUFFICIENT_EVIDENCE","expectedRole":"FIRST_CHOICE"|"ROTATION"|"BACKUP"|"OUT"|"UNKNOWN","evidenceSummary":string,"sourceUrl":string}],"signals":[{"playerId":number,"playerName":string,"kind":"EXPECTED_ROLE"|"START_PROBABILITY"|"DEPTH_CHART"|"INJURY"|"PENALTIES"|"SET_PIECES"|"PRESEASON_MINUTES","value":{"startProbability":number|null,"minutesIfStarting":number|null,"substituteProbabilityWhenBenched":number|null,"minutesIfSubstitute":number|null,"depthRole":"FIRST_CHOICE"|"ROTATION"|"BACKUP"|"OUT"|null,"note":string|null},"sourceType":"OFFICIAL_CLUB"|"OFFICIAL_PL"|"JOURNALIST"|"PREDICTED_LINEUP","sourceUrl":string,"sourceTitle":string,"evidenceSummary":string,"confidence":number,"validUntil":string}]}. If there are no material risks, return an empty signals array. Every MATERIAL_RISK audit must have exactly one matching signal.',
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
    response=await fetch(`https://api.openai.com/v1/responses/${encodeURIComponent(data.id)}`,{headers:{'authorization':`Bearer ${openaiKey}`}})
    if(!response.ok)throw new Error(`Unable to poll OpenAI research ${response.status}: ${(await response.text()).slice(0,500)}`)
    data=await response.json()
  }
  const webSearchCalls=data.output?.filter(item=>item.type==='web_search_call').length||0
  const parsed=parseStructuredOutput(data)
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
  const proposedSignals=isDeepSeek?normalizeDeepSeekSignals(parsed,players,priorityAudit,deadline):Array.isArray(parsed.signals)?parsed.signals:[]
  const signals=proposedSignals.filter(signal=>{
    if(!signal||typeof signal!=='object')return false
    const source=canonicalUrl(signal.sourceUrl)
    return signal&&signal.value&&typeof signal.value==='object'&&allowedIds.has(signal.playerId)&&sourceBacked(source)&&Number.isFinite(new Date(signal.validUntil).getTime())
  }).map(signal=>({...signal,sourceUrl:canonicalUrl(signal.sourceUrl),validUntil:new Date(Math.min(new Date(signal.validUntil).getTime(),evidenceExpiry)).toISOString(),value:Object.fromEntries(Object.entries(signal.value).filter(([,value])=>value!==null))}))
  const requiredAuditIds=new Set(priorityAudit.map(player=>player.id))
  const seenAuditIds=new Set()
  const audits=(Array.isArray(parsed.audits)?parsed.audits:[]).filter(audit=>{
    if(!requiredAuditIds.has(audit.playerId)||seenAuditIds.has(audit.playerId))return false
    const source=canonicalUrl(audit.sourceUrl)
    const sourceValid=audit.outcome==='INSUFFICIENT_EVIDENCE'&&!audit.sourceUrl||sourceBacked(source)
    if(!sourceValid)return false
    seenAuditIds.add(audit.playerId)
    return true
  }).map(audit=>({...audit,sourceUrl:canonicalUrl(audit.sourceUrl)}))
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
    stored.push(await createPlayerSignal(db,{playerId:signal.playerId,gameweek:currentGameweek,kind:signal.kind,value:signal.value,sourceType:signal.sourceType,sourceUrl:signal.sourceUrl,evidenceSummary:signal.evidenceSummary,confidence:signal.confidence,observedAt,validUntil:validUntil.toISOString(),status:'PENDING',actorType:'RESEARCH'}))
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

    if (request === '/api/admin/status' && req.method === 'GET') {
      try { sendJson(res, 200, await adminStatusSnapshot()) }
      catch (error) { sendJson(res, 500, { error: error instanceof Error ? error.message : 'Admin status unavailable' }) }
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
      } else if (action === 'odds-sync') {
        work = async () => {
          const output = await runChildScript('scripts/ingest-signals.mjs', ['--market-only'])
          return output || 'Betting odds sync completed'
        }
      } else if (action === 'team-refresh') {
        work = refreshLinkedManagerTeam
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

    if (request === '/api/catalog' && req.method === 'GET') {
      const params = new URL(req.url || '/', `http://${host}`).searchParams
      const options = { asOf: params.get('asOf') || undefined, season: params.get('season') || undefined }
      const requestKey = catalogueRequestKey(options)
      try {
        const db = await getDb()
        const key = catalogueCacheKey(requestKey, await projectionCatalogInputVersions(db, options.season))
        const cached = catalogueCache.get(key)
        if (cached) {
          sendJson(res, 200, { schemaVersion: 1, season: cached.season || FPL_SEASON, currentSeason: cached.season || FPL_SEASON, ...cached, cache: { status: 'FRESH' } })
          return
        }
        const catalogue = await assembleProjectionInputCatalog(db, options)
        await catalogueCache.put(key, requestKey, catalogue)
        sendJson(res, 200, { schemaVersion: 1, season: catalogue.season || FPL_SEASON, currentSeason: catalogue.season || FPL_SEASON, ...catalogue, cache: { status: 'MISS' } })
      } catch (error) {
        const restart = await catalogueCache.getRestart(requestKey)
        if (restart) {
          sendJson(res, 200, { schemaVersion: 1, season: restart.season || FPL_SEASON, currentSeason: restart.season || FPL_SEASON, ...restart, cache: { status: 'STALE_RESTART' } })
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
        const result=await db.query('SELECT "id","source","external_event_id","captured_at","kickoff_at","home_team_name","away_team_name","home_win_probability","draw_probability","away_win_probability" FROM "MarketFixtureObservation" ORDER BY COALESCE("kickoff_at","captured_at") ASC,"captured_at" DESC LIMIT $1',[limit])
        sendJson(res,200,{snapshots:result.rows.map(row=>({id:row.id,source:row.source,externalEventId:row.external_event_id,capturedAt:row.captured_at,kickoff:row.kickoff_at,homeTeam:row.home_team_name,awayTeam:row.away_team_name,homeWinProb:row.home_win_probability==null?null:Number(row.home_win_probability),drawProb:row.draw_probability==null?null:Number(row.draw_probability),awayWinProb:row.away_win_probability==null?null:Number(row.away_win_probability)}))})
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
        const signal=await createPlayerSignal(db,{playerId:payload.playerId,gameweek:payload.gameweek||null,kind:payload.kind,value:payload.value||{},sourceType:manual?'MANUAL_OVERRIDE':'USER_FEEDBACK',sourceUrl:payload.sourceUrl||null,evidenceSummary:payload.evidenceSummary,confidence:manual?1:Math.max(0,Math.min(1,Number(payload.confidence)||.4)),observedAt,validUntil:validUntil.toISOString(),status:manual?'VERIFIED':'PENDING'})
        sendJson(res,201,{signal})
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Unable to create signal'})}
      return
    }

    const signalStatusMatch=request.match(/^\/api\/player-signals\/([^/]+)$/)
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

    // Secured n8n webhook. Source identity is assigned here, never by the caller.
    if(request==='/api/signals/ingest'&&req.method==='POST'){
      if(!requireIngestToken(req,res))return
      try{
        const payload=await readRequestBody(req)
        const result=await processCreatorPayload(payload)
        sendJson(res,201,result)
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Ingest failed'})}
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
        // Resolve player mentions from text using the same fuzzy matcher as the Ask tab
        const { resolveMultiplePlayerMentions } = await import('../src/integrations.ts')
        let mentionedPlayers=resolveMultiplePlayerMentions(text,data.players)
        // Supplement with explicit hints from n8n
        if(Array.isArray(payload.playerHints)&&payload.playerHints.length){
          for(const hint of payload.playerHints){
            const matches=resolveMultiplePlayerMentions(hint,data.players)
            for(const p of matches){
              if(!mentionedPlayers.find(m=>m.id===p.id))mentionedPlayers.push(p)
            }
          }
        }
        if(!mentionedPlayers.length){sendJson(res,200,{created:0,signals:[],message:'No players resolved from text'});return}
        const db=await getDb()
        const created=[]
        for(const player of mentionedPlayers.slice(0,10)){
          const summary=(text.slice(0,300)+(text.length>300?'…':'')).replace(/\s+/g,' ').trim()
          const observedAt=new Date().toISOString()
          const validUntil=new Date(Date.now()+7*24*60*60*1000).toISOString()
          const status='PENDING'
          const signal=await createPlayerSignal(db,{playerId:player.id,gameweek,kind:'EXPECTED_ROLE',value:{note:summary},sourceType,sourceUrl,evidenceSummary:`[${player.name}] ${summary}`,confidence:payloadConfidence,observedAt,validUntil,status})
          created.push({...signal,autoApproved:false})
        }
        sendJson(res,201,{created:created.length,signals:created,autoApproved:false})
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Ingest failed'})}
      return
    }

    if(request==='/api/creator-claims'&&req.method==='GET'){
      sendJson(res,200,{claims:[],notice:'Unmatched creator claims are returned synchronously by the ingestion response and are not retained.'})
      return
    }

    const creatorClaimMatch=request.match(/^\/api\/creator-claims\/(.+)$/)
    if(creatorClaimMatch&&req.method==='PATCH'){
      sendJson(res,410,{error:'Unmatched creator claims are not persisted. Correct the source payload and ingest it again.'})
      return
    }

    // Signal source trust config
    if(request==='/api/signal-config'&&req.method==='GET'){
      sendJson(res,200,loadSignalConfig())
      return
    }
    if(request==='/api/signal-config'&&req.method==='PUT'){
      try{
        const payload=await readRequestBody(req)
        const current=loadSignalConfig()
        const updated={...current}
        for(const [key,val] of Object.entries(payload)){
          if(val&&typeof val==='object'){
            updated[key]={...current[key],...val}
            if(typeof updated[key].confidenceThreshold==='number'){
              updated[key].confidenceThreshold=Math.max(0,Math.min(1,updated[key].confidenceThreshold))
            }
          }
        }
        saveSignalConfig(updated)
        sendJson(res,200,updated)
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Could not save config'})}
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

    if (request === '/api/manager/current' && req.method === 'DELETE') {
      try {
        const db = await getDb()
        await unlinkCurrentManager(db)
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
        const recommendation = await createRecommendationSet(await getDb(), {
          planId: decodeURIComponent(planRecommendationMatch[1]),
          forecastRunId: body.forecastRunId,
          horizon: body.horizon ?? 1,
          maxTransfers: body.maxTransfers ?? 5,
          uncertaintyPenaltyRate: body.uncertaintyPenaltyRate ?? .15,
          chip: body.chip ?? null,
        })
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
      const leagueKey = `${leagueId}:${requestedGameweek}`
      const cachedLeague = leagueCache.get(leagueKey)
      if (cachedLeague) {
        sendJson(res, 200, cachedLeague)
        return
      }

      try {
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

        const topRivals = results.slice(0, 35)

        const defaultGw = urlParams.get('gameweek') || standingsData.league?.start_event || 1

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

              return {
                ...rival,
                activeChip: picksData?.active_chip || null,
                eventTransfers: picksData?.entry_history?.event_transfers || 0,
                eventTransfersCost: picksData?.entry_history?.event_transfers_cost || 0,
                picks: picksData?.picks || [],
                chipsUsed: historyData?.chips || []
              }
            } catch {
              return {
                ...rival,
                activeChip: null,
                eventTransfers: 0,
                eventTransfersCost: 0,
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

        const response = {
            league: standingsData.league,
            standings: enrichedRivals,
            totalAnalyzed,
            sampledManagerCount: enrichedRivals.length,
            totalManagerCount: Number(standingsData.standings?.total_results || results.length),
            pagination: { policy: 'FIRST_PAGE_SAMPLE', fetchedPages: 1, complete: false },
            isPreSeason: Boolean(isPreSeason),
            effectiveOwnership
          }
        leagueCache.set(leagueKey, response)
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

    const file = path.join(process.cwd(), 'dist', request === '/' ? 'index.html' : request)
    if (!file.startsWith(path.join(process.cwd(), 'dist'))) return res.writeHead(403).end()
    fs.readFile(file, (error, data) => {
      if (error) {
        if (!path.extname(request)) {
          const indexPath = path.join(process.cwd(), 'dist', 'index.html')
          return fs.readFile(indexPath, (err2, indexData) => {
            if (err2) return res.writeHead(404).end('Not found')
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(indexData)
          })
        }
        return res.writeHead(404).end('Not found')
      }
      res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(data)
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
