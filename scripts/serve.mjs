import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { resolvePlayerRole } from '../src/player-signals.ts'
import { matchCreatorClaim, normalizeCreatorPayload, normalizeEntityText, signalDraftFromClaim } from './creator-signals.mjs'

const port = Number(process.env.PORT || 4173)
const host = process.env.HOST || '127.0.0.1'
const RESEARCH_AUDIT_LIMIT = 6
const ROLE_BEARING_SIGNAL_KINDS = new Set(['DEPTH_CHART', 'EXPECTED_ROLE', 'START_PROBABILITY'])
export const EMPIRICAL_EXPIRY_MIN_MINUTES = 75
export const EMPIRICAL_EXPIRY_LOOKBACK_GW = 3
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

import { getDb } from './db.mjs'
import { migrateDatabase } from './db-migrate.mjs'

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

export async function expirePriorRoleSignals(db, playerId, kind) {
  if (!ROLE_BEARING_SIGNAL_KINDS.has(kind)) return 0
  const result = await db.query(
    `UPDATE "PlayerSignal"
     SET status='EXPIRED', "updatedAt"=CURRENT_TIMESTAMP
     WHERE "playerId"=$1 AND kind=$2 AND status IN ('VERIFIED','PENDING')
       AND "sourceType" <> 'MANUAL_OVERRIDE'`,
    [playerId, kind],
  )
  return Number(result.changes || 0)
}

export async function expireContradictedSignals(db, currentGameweek) {
  const completed = await db.query(
    `SELECT id FROM "Gameweek"
     WHERE finished=true AND id < $1
     ORDER BY id DESC LIMIT $2`,
    [currentGameweek, EMPIRICAL_EXPIRY_LOOKBACK_GW],
  )
  if (!completed.rows.length) return 0

  const gameweeks = completed.rows.map(row => Number(row.id))
  const placeholders = gameweeks.map((_, index) => `$${index + 1}`).join(',')
  const averages = await db.query(
    `SELECT "playerId", AVG(minutes) AS averageMinutes
     FROM "PlayerMatchStat"
     WHERE gameweek IN (${placeholders})
     GROUP BY "playerId"
     HAVING AVG(minutes) >= $${gameweeks.length + 1}`,
    [...gameweeks, EMPIRICAL_EXPIRY_MIN_MINUTES],
  )
  let expired = 0
  for (const row of averages.rows) {
    const playerId = Number(row.playerId)
    const signals = await db.query(
      `SELECT id, kind, value FROM "PlayerSignal"
       WHERE "playerId"=$1 AND status IN ('VERIFIED','PENDING')`,
      [playerId],
    )
    for (const signal of signals.rows) {
      const value = parseJson(signal.value, {})
      const depthRole = value.depthRole
      const startProbability = Number(value.startProbability)
      const contradicted = depthRole === 'BACKUP' || depthRole === 'ROTATION' ||
        (Number.isFinite(startProbability) && startProbability < 0.4)
      if (!contradicted) continue
      const reasons = []
      if (depthRole === 'BACKUP' || depthRole === 'ROTATION') reasons.push(`depthRole=${depthRole}`)
      if (Number.isFinite(startProbability) && startProbability < 0.4) reasons.push(`startProbability=${startProbability}`)
      const reason = `Empirical expiry: average ${Number(row.averageMinutes).toFixed(1)} minutes/game across last ${gameweeks.length} completed gameweeks contradicts ${reasons.join(' and ')}`
      await db.query(
        `UPDATE "PlayerSignal" SET status='EXPIRED', "updatedAt"=CURRENT_TIMESTAMP WHERE id=$1 AND status IN ('VERIFIED','PENDING')`,
        [signal.id],
      )
      console.log(`⏳ Expired signal ${signal.id} for player ${playerId}: ${reason}`)
      expired += 1
    }
  }
  return expired
}

function setupScheduledIngestion() {
  const hoursRaw = process.env.FPL_INGEST_INTERVAL_HOURS ?? '12'
  const hours = parseFloat(hoursRaw)
  if (isNaN(hours) || hours <= 0) {
    console.log('⏱️ Periodic FPL ingestion is disabled (FPL_INGEST_INTERVAL_HOURS=0).')
    systemStatus.ingestIntervalHours = 0
    return
  }

  const intervalMs = hours * 60 * 60 * 1000
  systemStatus.ingestIntervalHours = hours
  systemStatus.nextIngestAt = new Date(Date.now() + intervalMs).toISOString()
  console.log(`⏱️ Scheduled periodic FPL ingestion active every ${hours} hour(s). Next run at: ${systemStatus.nextIngestAt}`)

  if (scheduledIngestTimer) clearInterval(scheduledIngestTimer)
  scheduledIngestTimer = setInterval(() => {
    if (systemStatus.isSeeding || systemStatus.isIngesting) {
      console.log('⏱️ Scheduled ingestion skipped (ingestion already in progress).')
      return
    }
    console.log('⏱️ Starting scheduled periodic FPL ingestion...')
    triggerBackgroundIngest()
  }, intervalMs)
}

async function performColdStartInitialization() {
  try {
    console.log('🚀 Ensuring database schema...')
    await migrateDatabase()
    const db = await getDb()
    const result = await db.query('SELECT COUNT(*) as count FROM "Player"').catch(() => ({ rows: [{ count: 0 }] }))
    const count = Number(result.rows[0]?.count || 0)
    systemStatus.playerCount = count

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
    }

    setupScheduledIngestion()
  } catch (err) {
    console.error('⚠️ Cold-start setup warning:', err.message)
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
    systemStatus.isIngesting = true
    const { execFile } = await import('node:child_process')
    const scriptPath = path.resolve('scripts/ingest-fpl.mjs')
    execFile(process.execPath, ['--experimental-strip-types', scriptPath], async (error) => {
      systemStatus.isIngesting = false
      if (error) {
        console.error('⚠️ Background FPL ingestion note:', error.message)
        systemStatus.status = 'error'
        systemStatus.isSeeding = false
        systemStatus.message = `Ingestion error: ${error.message}`
      } else {
        console.log('✅ Background FPL ingestion completed.')
        systemStatus.status = 'ready'
        systemStatus.isSeeding = false
        systemStatus.message = 'Live FPL data ingested successfully.'
        systemStatus.lastIngestedAt = new Date().toISOString()
        if (systemStatus.ingestIntervalHours > 0) {
          systemStatus.nextIngestAt = new Date(Date.now() + systemStatus.ingestIntervalHours * 60 * 60 * 1000).toISOString()
        }
        try {
          const db = await getDb()
          const result = await db.query('SELECT COUNT(*) as count FROM "Player"').catch(() => ({ rows: [{ count: 0 }] }))
          systemStatus.playerCount = Number(result.rows[0]?.count || 0)
          const current = await db.query('SELECT id FROM "Gameweek" WHERE "isCurrent"=true ORDER BY id DESC LIMIT 1').catch(() => ({ rows: [] }))
          if (current.rows[0]?.id != null) {
            await expireContradictedSignals(db, Number(current.rows[0].id))
          }
        } catch {}
      }
    })
    return true
  } catch (err) {
    systemStatus.isIngesting = false
    console.error('⚠️ Background ingestion launch error:', err)
    systemStatus.status = 'ready'
    systemStatus.isSeeding = false
    return false
  }
}

function invalidateLiveDataCache() {}

function readRequestBody(req){
  return new Promise((resolve,reject)=>{
    let body=''
    req.on('data',chunk=>{body+=chunk;if(body.length>1_000_000)reject(new Error('Request body too large'))})
    req.on('end',()=>{try{resolve(JSON.parse(body||'{}'))}catch(error){reject(error)}})
    req.on('error',reject)
  })
}

function sendJson(res,status,payload){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}).end(JSON.stringify(payload))
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

function loadAiSettings() {
  try {
    if (fs.existsSync(AI_SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(AI_SETTINGS_PATH, 'utf8'))
    }
  } catch {}
  return { provider: '', apiKey: '' }
}

function saveAiSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(AI_SETTINGS_PATH), { recursive: true })
    fs.writeFileSync(AI_SETTINGS_PATH, JSON.stringify(settings, null, 2))
  } catch (err) {
    console.error('Failed to save AI settings:', err)
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
  if(claimRow.signalId){
    const existing=await db.query('SELECT * FROM "PlayerSignal" WHERE id=$1',[claimRow.signalId])
    if(existing.rows[0])return {signal:existing.rows[0],created:false}
  }
  const signalValue=parseJson(claimRow.signalValue,{})
  const draft=signalDraftFromClaim({...claimRow,...signalValue,numericClaims:parseJson(claimRow.numericClaims,[]),relatedMentions:parseJson(claimRow.relatedMentions,[])},Number(claimRow.resolvedPlayerId),source)
  const confidence=Math.max(0,Math.min(1,Number(draft.confidence)||.65))
  const status=shouldAutoApprove('YOUTUBE_TRANSCRIPT',confidence,loadSignalConfig())?'VERIFIED':'PENDING'
  const observedAt=new Date().toISOString()
  await expirePriorRoleSignals(db, Number(draft.playerId), draft.kind)
  const inserted=await db.query('INSERT INTO "PlayerSignal" ("playerId","gameweekId",kind,value,"sourceType","sourceUrl","evidenceSummary",confidence,"observedAt","validUntil",status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[draft.playerId,gameweek,draft.kind,JSON.stringify(draft.value),draft.sourceType,draft.sourceUrl,draft.evidenceSummary,confidence,observedAt,validityDeadline(claimRow.timeHorizon),status])
  const signal=inserted.rows[0]
  await db.query('UPDATE "CreatorClaim" SET "signalId"=$1,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$2',[signal.id,claimRow.id])
  if(status==='VERIFIED')await materializePlayerOutlook(Number(claimRow.resolvedPlayerId))
  return {signal,created:true}
}

async function processCreatorPayload(rawPayload){
  const payload=normalizeCreatorPayload(rawPayload),db=await getDb(),data=await liveData()
  const contentId=`${payload.source.platform}:${payload.source.externalId}`
  const aliases=(await db.query('SELECT * FROM "PlayerAlias"')).rows
  const receivedAt=new Date().toISOString()
  await db.query(`INSERT INTO "CreatorContent" (id,platform,"externalId",creator,title,url,"publishedAt",payload,status,"receivedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET creator=EXCLUDED.creator,title=EXCLUDED.title,url=EXCLUDED.url,"publishedAt"=EXCLUDED."publishedAt",payload=EXCLUDED.payload`,[contentId,payload.source.platform,payload.source.externalId,payload.source.creator,payload.source.title,payload.source.url,payload.source.publishedAt,JSON.stringify(payload),'PENDING',receivedAt])
  const results=[]
  for(const claim of payload.claims){
    const existing=(await db.query('SELECT * FROM "CreatorClaim" WHERE id=$1',[claim.externalClaimId])).rows[0]
    const match=existing?.signalId
      ? {status:existing.matchStatus,player:data.players.find(player=>player.id===Number(existing.resolvedPlayerId))||null,confidence:Number(existing.matchConfidence),candidates:parseJson(existing.matchCandidates,[])}
      : matchCreatorClaim(claim,data.players,aliases)
    const resolvedPlayerId=match.player?.id||existing?.resolvedPlayerId||null
    const signalValue=Object.fromEntries(['startProbability','minutesIfStarting','substituteProbabilityWhenBenched','minutesIfSubstitute','depthRole','confidence'].filter(key=>claim[key]!=null).map(key=>[key,claim[key]]))
    const candidates=Array.isArray(match.candidates)&&match.candidates[0]?.player?compactCandidates(match.candidates):match.candidates||[]
    await db.query(`INSERT INTO "CreatorClaim" (id,"contentId","rawPlayerName","normalizedPlayerName","resolvedPlayerId","clubHint","positionHint","priceHint",category,sentiment,summary,"evidenceText","timestampSeconds","timeHorizon","numericClaims","relatedMentions","signalValue","matchStatus","matchConfidence","matchCandidates","signalId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT (id) DO UPDATE SET "rawPlayerName"=EXCLUDED."rawPlayerName","clubHint"=EXCLUDED."clubHint","positionHint"=EXCLUDED."positionHint","priceHint"=EXCLUDED."priceHint",category=EXCLUDED.category,sentiment=EXCLUDED.sentiment,summary=EXCLUDED.summary,"evidenceText"=EXCLUDED."evidenceText","timestampSeconds"=EXCLUDED."timestampSeconds","timeHorizon"=EXCLUDED."timeHorizon","numericClaims"=EXCLUDED."numericClaims","relatedMentions"=EXCLUDED."relatedMentions","signalValue"=EXCLUDED."signalValue","resolvedPlayerId"=COALESCE("CreatorClaim"."resolvedPlayerId",EXCLUDED."resolvedPlayerId"),"matchStatus"=CASE WHEN "CreatorClaim"."signalId" IS NULL THEN EXCLUDED."matchStatus" ELSE "CreatorClaim"."matchStatus" END,"matchConfidence"=CASE WHEN "CreatorClaim"."signalId" IS NULL THEN EXCLUDED."matchConfidence" ELSE "CreatorClaim"."matchConfidence" END,"matchCandidates"=CASE WHEN "CreatorClaim"."signalId" IS NULL THEN EXCLUDED."matchCandidates" ELSE "CreatorClaim"."matchCandidates" END`,[claim.externalClaimId,contentId,claim.rawPlayerName,normalizeEntityText(claim.rawPlayerName),resolvedPlayerId,claim.clubHint,claim.positionHint,claim.priceHint,claim.category,claim.sentiment,claim.summary,claim.evidenceText,claim.timestampSeconds,claim.timeHorizon,JSON.stringify(claim.numericClaims),JSON.stringify(claim.relatedMentions),JSON.stringify(signalValue),match.status,match.confidence,JSON.stringify(candidates),existing?.signalId||null])
    let signalResult=null
    if(match.status==='MATCHED'&&resolvedPlayerId){
      const stored=(await db.query('SELECT * FROM "CreatorClaim" WHERE id=$1',[claim.externalClaimId])).rows[0]
      signalResult=await createSignalForCreatorClaim(db,stored,payload.source,data.currentGameweek)
    }
    results.push({id:claim.externalClaimId,rawPlayerName:claim.rawPlayerName,matchStatus:match.status,resolvedPlayerId,confidence:match.confidence,candidates,signalId:signalResult?.signal?.id||existing?.signalId||null,created:Boolean(signalResult?.created)})
  }
  const unresolved=results.filter(row=>row.matchStatus!=='MATCHED').length
  await db.query('UPDATE "CreatorContent" SET status=$1,"processedAt"=CURRENT_TIMESTAMP,"processingError"=NULL WHERE id=$2',[unresolved?'NEEDS_REVIEW':'PROCESSED',contentId])
  invalidateLiveDataCache()
  return {contentId,created:results.filter(row=>row.created).length,matched:results.length-unresolved,unresolved,claims:results}
}


async function liveData() {
  return refreshLiveData()
}

async function refreshLiveData() {
  const db = await getDb()
  const gw = await db.query('SELECT id, deadline FROM "Gameweek" WHERE "isCurrent"=true OR ("finished"=false AND "deadline" >= NOW()) ORDER BY "isCurrent" DESC, "deadline" ASC NULLS LAST, id ASC LIMIT 1')
  const currentGameweek=gw.rows[0]?.id||1
  const result=await db.query(`SELECT p.*,t."shortName" AS club,t.name AS "clubName" FROM "Player" p JOIN "Team" t ON t.id=p."clubId" WHERE p.active=true AND p.status!='u' ORDER BY p.id`)
  const underlyingResult=await db.query(`SELECT s.* FROM "PlayerUnderlyingSnapshot" s JOIN (SELECT "playerId", MAX("capturedAt") AS capturedAt FROM "PlayerUnderlyingSnapshot" WHERE "source"='UNDERSTAT' GROUP BY "playerId") latest ON latest."playerId"=s."playerId" AND latest.capturedAt=s."capturedAt"`).catch(()=>({rows:[]}))
  const fixtureResult=await db.query(`SELECT f."gameweekId" AS gameweek,f."homeTeamId",f."awayTeamId",f."difficultyHome",f."difficultyAway",home."shortName" AS home,away."shortName" AS away FROM "Fixture" f JOIN "Gameweek" g ON g.id=f."gameweekId" JOIN "Team" home ON home.id=f."homeTeamId" JOIN "Team" away ON away.id=f."awayTeamId" WHERE g.finished=false AND f."gameweekId">=$1 ORDER BY f."gameweekId",f.kickoff NULLS LAST`,[currentGameweek])
  const calibrationResult=await db.query('SELECT position,factor FROM "ModelCalibration" WHERE "modelVersion"=$1',['role-aware-v2.0']).catch(()=>({rows:[]}))
  const signalResult=await db.query('SELECT * FROM "PlayerSignal" WHERE status=$1 AND "validUntil">=NOW() AND ("gameweekId" IS NULL OR "gameweekId"=$2) ORDER BY "observedAt" DESC',['VERIFIED',currentGameweek]).catch(()=>({rows:[]}))
  const outlookResult=await db.query('SELECT * FROM "PlayerOutlook" WHERE "gameweekId"=$1',[''+currentGameweek]).catch(()=>({rows:[]}))
  const fixturesByTeam=new Map()
  for(const fixture of fixtureResult.rows){
    const homeRows=fixturesByTeam.get(fixture.homeTeamId)||[]
    homeRows.push({gameweek:fixture.gameweek,opponent:fixture.away,venue:'H',difficulty:Number(fixture.difficultyHome)||3})
    fixturesByTeam.set(fixture.homeTeamId,homeRows)
    const awayRows=fixturesByTeam.get(fixture.awayTeamId)||[]
    awayRows.push({gameweek:fixture.gameweek,opponent:fixture.home,venue:'A',difficulty:Number(fixture.difficultyAway)||3})
    fixturesByTeam.set(fixture.awayTeamId,awayRows)
  }
  const calibration=Object.fromEntries(calibrationResult.rows.map(row=>[row.position,Number(row.factor)]))
  const signalsByPlayer=new Map()
  for(const signal of signalResult.rows){
    const parsedValue = typeof signal.value === 'string' ? JSON.parse(signal.value) : (signal.value || {})
    const existing=signalsByPlayer.get(signal.playerId)||[]
    existing.push({...signal, value: parsedValue, gameweek:signal.gameweekId})
    signalsByPlayer.set(signal.playerId,existing)
  }
  const outlookByPlayer=new Map(outlookResult.rows.map(row=>[Number(row.playerId),row]))
  const underlyingByPlayer=new Map(underlyingResult.rows.map(row=>[Number(row.playerId),row]))
  const staleOutlookPlayerIds=new Set()
  const players = result.rows.map(p => {
    const underlying=underlyingByPlayer.get(Number(p.id))
    const availability = p.chanceOfPlaying ?? (p.status === 'i'||p.status === 'u' ? 0 : p.status === 'd' ? 75 : 100)
    const completedGameweeks=Math.max(0,currentGameweek-1)
    const historicalMinutes=Number(p.minutes)||0
    const coldStart=historicalMinutes===0
    const epNext=Number(p.epNext)||0
    const roleMinutes=completedGameweeks?Math.min(90,historicalMinutes/completedGameweeks):coldStart?Math.min(55,Math.max(30,30+epNext*15)):Math.min(90,historicalMinutes/38)
    const projectedMinutes=roleMinutes*availability/100
    const transferredRecently=p.clubChangedAt&&Date.now()-new Date(p.clubChangedAt).getTime()<60*24*60*60*1000
    const goalkeeper=p.position==='GK'
    const minutesIfStarting=goalkeeper?90:86
    const substituteProbabilityWhenBenched=goalkeeper ? .005 : .2
    const minutesIfSubstitute=goalkeeper?5:18
    const cameoMinutes=substituteProbabilityWhenBenched*minutesIfSubstitute
    const baseStartProbability=Math.max(0,Math.min(1,(projectedMinutes-cameoMinutes)/(minutesIfStarting-cameoMinutes)))
    const baseRole=transferredRecently?{
      startProbability:.55*availability/100,minutesIfStarting:p.position==='GK'?90:84,
      substituteProbabilityWhenBenched:p.position==='GK' ? .01 : .3,minutesIfSubstitute:p.position==='GK' ? 5 : 20,
      confidence:'LOW',derivedFromSignalIds:[]
    }:{startProbability:baseStartProbability,minutesIfStarting,substituteProbabilityWhenBenched,minutesIfSubstitute,confidence:coldStart?'LOW':historicalMinutes>=900?'HIGH':'MEDIUM',derivedFromSignalIds:[]}
    const outlook=outlookByPlayer.get(Number(p.id))
    const playerSignals=signalsByPlayer.get(p.id)||[]
    let outlookSignalIds=[]
    try{outlookSignalIds=Array.isArray(outlook?.derivedSignalIds)?outlook.derivedSignalIds:JSON.parse(outlook?.derivedSignalIds||'[]')}catch{}
    const trustedStandaloneOutlook=outlook&&outlookSignalIds.length===0
    if(outlook&&outlookSignalIds.length>0&&!playerSignals.length)staleOutlookPlayerIds.add(Number(p.id))
    const roleProfile=playerSignals.length
      ? resolvePlayerRole(baseRole,playerSignals,{gameweek:currentGameweek})
      : trustedStandaloneOutlook
        ? {startProbability:Number(outlook.startProbability),minutesIfStarting:Number(outlook.minutesIfStarting),substituteProbabilityWhenBenched:Number(outlook.substituteProbabilityWhenBenched),minutesIfSubstitute:Number(outlook.minutesIfSubstitute),confidence:outlook.confidence,derivedFromSignalIds:outlookSignalIds}
        : resolvePlayerRole(baseRole,[],{gameweek:currentGameweek})
    const actualExpectedMinutes=roleProfile.startProbability*roleProfile.minutesIfStarting+(1-roleProfile.startProbability)*roleProfile.substituteProbabilityWhenBenched*roleProfile.minutesIfSubstitute
    const rawBasePoints=Number(p.epNext)||(Number(p.pointsPerGame)||0)*.7+(Number(p.form)||0)*.3
    const minutesFactor=actualExpectedMinutes/90
    const singleGwProjection=+Math.max(.1,rawBasePoints*minutesFactor).toFixed(2)
    const form = Number(p.form) || 0
    const ppg = Number(p.pointsPerGame) || 0
    const upcomingFixtures=(fixturesByTeam.get(p.clubId)||[]).slice(0,5)
    const firstFixture=upcomingFixtures[0]
    return {
      id: p.id,
      name: p.name,
      club: p.club,
      transferredRecently:Boolean(transferredRecently),
      position: p.position,
      price: Number(p.price),
      form,
      ownership: Number(p.ownership) || 0,
      minutes: availability,
      expectedMinutes:+actualExpectedMinutes.toFixed(1),
      roleProfile,
      fixture:firstFixture?`${firstFixture.opponent} (${firstFixture.venue})`:'Blank',
      difficulty:firstFixture?.difficulty||3,
      projection:singleGwProjection,
      colour:colours[p.id%colours.length],
      status: p.status || (availability === 0 ? 'i' : availability < 100 ? 'd' : 'a'),
      chanceOfPlaying: p.chanceOfPlaying ?? availability,
      news: p.news || (p.status === 'i' || availability === 0 ? 'Injured - 0% chance of playing' : p.status === 'd' || availability < 100 ? `Doubtful - ${availability}% chance of playing` : null),
      transfersIn:Number(p.transfersIn)||0,
      transfersOut:Number(p.transfersOut)||0,
      active:Boolean(p.active),
      coldStart,
      dataConfidence:coldStart?'LOW':historicalMinutes>=900?'HIGH':'MEDIUM',
      calibrationFactor:calibration[p.position]||1,
      upcomingFixtures,
      stats:{minutes:Number(p.minutes)||0,starts:Number(p.starts)||0,totalPoints:Number(p.totalPoints)||0,goals:Number(p.goals)||0,assists:Number(p.assists)||0,cleanSheets:Number(p.cleanSheets)||0,goalsConceded:Number(p.goalsConceded)||0,saves:Number(p.saves)||0,bonus:Number(p.bonus)||0,bps:Number(p.bps)||0,yellowCards:Number(p.yellowCards)||0,redCards:Number(p.redCards)||0,ownGoals:Number(p.ownGoals)||0,penaltiesMissed:Number(p.penaltiesMissed)||0,penaltiesSaved:Number(p.penaltiesSaved)||0,expectedGoals:Number(p.expectedGoals)||0,expectedAssists:Number(p.expectedAssists)||0,expectedGoalsConceded:Number(p.expectedGC)||0,expectedGoalsPer90:Number(underlying?.xgPer90 ?? p.expectedGoalsPer90)||0,expectedAssistsPer90:Number(underlying?.xaPer90 ?? p.expectedAssistsPer90)||0,expectedGoalsConcededPer90:Number(p.expectedGCPer90)||0,savesPer90:Number(p.savesPer90)||0,clearancesBlocksInterceptions:Number(p.clearancesBlocksInterceptions)||0,tackles:Number(p.tackles)||0,recoveries:Number(p.recoveries)||0,defensiveContribution:Number(p.defensiveContribution)||0,defensiveContributionPer90:Number(p.defensiveContributionPer90)||0}
    }
  })
  for(const playerId of staleOutlookPlayerIds){
    await db.query('DELETE FROM "PlayerOutlook" WHERE "playerId"=$1 AND "gameweekId"=$2',[playerId,currentGameweek]).catch(()=>{})
  }
  return { capturedAt: new Date().toISOString(), currentGameweek, deadline: gw.rows[0]?.deadline || null, modelVersion:'role-aware-v2.0', players }
}

async function materializePlayerOutlook(playerId, { invalidate = true } = {}) {
  if (invalidate) invalidateLiveDataCache()
  const db=await getDb()
  const current=await db.query('SELECT id FROM "Gameweek" WHERE "isCurrent"=true OR (finished=false AND deadline>=CURRENT_TIMESTAMP) ORDER BY "isCurrent" DESC,deadline ASC LIMIT 1')
  const currentGameweek=Number(current.rows[0]?.id)||1
  await db.query('DELETE FROM "PlayerOutlook" WHERE "playerId"=$1 AND "gameweekId"=$2',[playerId,currentGameweek])
  const data=await liveData()
  const player=data.players.find(candidate=>candidate.id===playerId)
  if(!player?.roleProfile||!data.currentGameweek||!(player.roleProfile.derivedFromSignalIds||[]).length)return
  const role=player.roleProfile
  await db.query(`INSERT INTO "PlayerOutlook" ("playerId","gameweekId","startProbability","minutesIfStarting","substituteProbabilityWhenBenched","minutesIfSubstitute",confidence,"derivedSignalIds","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP) ON CONFLICT ("playerId","gameweekId") DO UPDATE SET "startProbability"=EXCLUDED."startProbability","minutesIfStarting"=EXCLUDED."minutesIfStarting","substituteProbabilityWhenBenched"=EXCLUDED."substituteProbabilityWhenBenched","minutesIfSubstitute"=EXCLUDED."minutesIfSubstitute",confidence=EXCLUDED.confidence,"derivedSignalIds"=EXCLUDED."derivedSignalIds","updatedAt"=CURRENT_TIMESTAMP`,[playerId,data.currentGameweek,role.startProbability,role.minutesIfStarting,role.substituteProbabilityWhenBenched,role.minutesIfSubstitute,role.confidence,JSON.stringify(role.derivedFromSignalIds)])
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
    const existing=await db.query('SELECT id,"observedAt" FROM "PlayerSignal" WHERE "playerId"=$1 AND "gameweekId"=$2 AND kind=$3 AND "sourceUrl"=$4 AND status=$5 ORDER BY id DESC LIMIT 1',[signal.playerId,currentGameweek,signal.kind,signal.sourceUrl,'PENDING'])
    if(existing.rows[0]){
      stored.push({...signal,id:existing.rows[0].id,status:'PENDING',observedAt:existing.rows[0].observedAt})
      continue
    }
    await expirePriorRoleSignals(db, Number(signal.playerId), signal.kind)
    const result=await db.query('INSERT INTO "PlayerSignal" ("playerId","gameweekId",kind,value,"sourceType","sourceUrl","evidenceSummary",confidence,"observedAt","validUntil",status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',[signal.playerId,currentGameweek,signal.kind,JSON.stringify(signal.value),signal.sourceType,signal.sourceUrl,signal.evidenceSummary,signal.confidence,observedAt,validUntil.toISOString(),'PENDING'])
    stored.push({...signal,id:result.rows[0].id,status:'PENDING',observedAt})
  }
  return {...challenge,signals:stored}
}

function pruneSquadChallengeJobs(){
  const expiry=Date.now()-60*60*1000
  for(const [id,job] of squadChallengeJobs)if(job.updatedAt<expiry)squadChallengeJobs.delete(id)
}

function startServerOnAvailablePort(targetPort) {
  const server = http.createServer(async (req, res) => {
    const request = (req.url || '/').split('?')[0]

    if (request === '/api/health') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }).end(JSON.stringify({ status: 'ok', database: systemStatus.status, isSeeding: systemStatus.isSeeding, playerCount: systemStatus.playerCount }))
      return
    }

    if (request === '/api/system-status') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }).end(JSON.stringify(systemStatus))
      return
    }

    if (request === '/api/ai-config') {
      if (req.method === 'GET') {
        try {
          const db = await getDb()
          const resDb = await db.query('SELECT "aiProvider", "apiKey" FROM "UserAccount" WHERE id=\'default\' LIMIT 1')
          if (resDb.rows.length > 0 && resDb.rows[0].apiKey) {
            sendJson(res, 200, { provider: resDb.rows[0].aiProvider || '', apiKey: resDb.rows[0].apiKey || '' })
            return
          }
        } catch {}
        const stored = loadAiSettings()
        sendJson(res, 200, { provider: stored.provider || '', apiKey: stored.apiKey || '' })
        return
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        try {
          const body = await readRequestBody(req)
          saveAiSettings({ provider: body.provider || '', apiKey: body.apiKey || '' })
          try {
            const db = await getDb()
            await db.query('UPDATE "UserAccount" SET "aiProvider" = $1, "apiKey" = $2, "updatedAt" = NOW() WHERE id=\'default\'', [body.provider || '', body.apiKey || ''])
          } catch {}
          sendJson(res, 200, { success: true, provider: body.provider || '', apiKey: body.apiKey || '' })
        } catch (err) {
          sendJson(res, 500, { error: err.message })
        }
        return
      }
    }

    if (request === '/api/fpl-data') {
      try {
        const data = await liveData()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          .end(JSON.stringify(data))
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
            .end(JSON.stringify({ error: error instanceof Error ? error.message : 'Live data unavailable' }))
        }
      }
      return
    }

    if (request === '/api/fpl-refresh' && req.method === 'POST') {
      try {
        if (systemStatus.isIngesting || systemStatus.isSeeding) {
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
        const playerId=Number(params.get('playerId'))||null,status=params.get('status')||null,sourceType=params.get('sourceType')||null
        const limit=Math.min(500,Math.max(1,Number(params.get('limit'))||200))
        const result=await db.query('SELECT * FROM "PlayerSignal" WHERE ($1 IS NULL OR "playerId"=$1) AND ($2 IS NULL OR status=$2) AND ($3 IS NULL OR "sourceType"=$3) ORDER BY "observedAt" DESC LIMIT $4',[playerId,status,sourceType,limit])
        sendJson(res,200,{signals:result.rows.map(row=>({...row,value:typeof row.value==='string'?JSON.parse(row.value):(row.value||{}),confidence:Number(row.confidence),gameweek:row.gameweekId}))})
      }catch(error){sendJson(res,500,{error:error instanceof Error?error.message:'Unable to read signals'})}
      return
    }

    if(request==='/api/team-market-snapshots'&&req.method==='GET'){
      try{
        const db=await getDb(),params=new URL(req.url||'/',`http://${host}`).searchParams
        const limit=Math.min(50,Math.max(1,Number(params.get('limit'))||12))
        const result=await db.query('SELECT id,source,"externalEventId",capturedAt,kickoff,"homeTeam","awayTeam","homeWinProb","drawProb","awayWinProb" FROM "TeamMarketSnapshot" ORDER BY COALESCE(kickoff,capturedAt) ASC,capturedAt DESC LIMIT $1',[limit])
        sendJson(res,200,{snapshots:result.rows.map(row=>({...row,id:Number(row.id),homeWinProb:row.homeWinProb==null?null:Number(row.homeWinProb),drawProb:row.drawProb==null?null:Number(row.drawProb),awayWinProb:row.awayWinProb==null?null:Number(row.awayWinProb)}))})
      }catch(error){sendJson(res,500,{error:error instanceof Error?error.message:'Unable to read market snapshots'})}
      return
    }

    if(request==='/api/player-signals'&&req.method==='POST'){
      try{
        const payload=await readRequestBody(req),db=await getDb()
        if(!Number.isInteger(payload.playerId)||!payload.kind||!payload.evidenceSummary)throw new Error('playerId, kind and evidenceSummary are required')
        const manual=payload.manualOverride===true
        const observedAt=new Date().toISOString(),validUntil=new Date(payload.validUntil||Date.now()+7*24*60*60*1000)
        if(!Number.isFinite(validUntil.getTime()))throw new Error('validUntil must be a valid timestamp')
        await expirePriorRoleSignals(db, Number(payload.playerId), payload.kind)
        const result=await db.query('INSERT INTO "PlayerSignal" ("playerId","gameweekId",kind,value,"sourceType","sourceUrl","evidenceSummary",confidence,"observedAt","validUntil",status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[payload.playerId,payload.gameweek||null,payload.kind,JSON.stringify(payload.value||{}),manual?'MANUAL_OVERRIDE':'USER_FEEDBACK',payload.sourceUrl||null,payload.evidenceSummary,manual?1:Math.max(0,Math.min(1,Number(payload.confidence)||.4)),observedAt,validUntil.toISOString(),manual?'VERIFIED':'PENDING'])
        invalidateLiveDataCache()
        if(manual)await materializePlayerOutlook(payload.playerId)
        sendJson(res,201,{signal:result.rows[0]})
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Unable to create signal'})}
      return
    }

    const signalStatusMatch=request.match(/^\/api\/player-signals\/(\d+)$/)
    if(signalStatusMatch&&req.method==='PATCH'){
      try{
        const payload=await readRequestBody(req),allowed=new Set(['PENDING','VERIFIED','REJECTED','EXPIRED'])
        if(!allowed.has(payload.status))throw new Error('Invalid signal status')
        const db=await getDb(),result=await db.query('UPDATE "PlayerSignal" SET status=$1,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *',[payload.status,Number(signalStatusMatch[1])])
        if(!result.rows[0])return sendJson(res,404,{error:'Signal not found'})
        invalidateLiveDataCache()
        await materializePlayerOutlook(result.rows[0].playerId)
        sendJson(res,200,{signal:result.rows[0]})
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Unable to update signal'})}
      return
    }

    if(request==='/api/player-signals/batch-status'&&req.method==='POST'){
      let transactionStarted=false
      try{
        const payload=await readRequestBody(req)
        const updates=Array.isArray(payload.updates)?payload.updates:[]
        if(!updates.length)throw new Error('updates array is required')
        const allowed=new Set(['PENDING','VERIFIED','REJECTED'])
        if(updates.some((item)=>!item||!Number.isInteger(Number(item.id))||Number(item.id)<=0||!allowed.has(item.status)))throw new Error('Each update must include a positive integer id and a valid status')
        const db=await getDb()
        const updatedSignals=[]
        const affectedPlayerIds=new Set()
        await db.query('BEGIN')
        transactionStarted=true
        for(const item of updates){
          const result=await db.query('UPDATE "PlayerSignal" SET status=$1,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *',[item.status,Number(item.id)])
          if(!result.rows[0])throw new Error(`Signal ${item.id} not found`)
          updatedSignals.push(result.rows[0])
          affectedPlayerIds.add(result.rows[0].playerId)
        }
        await db.query('COMMIT')
        transactionStarted=false
        invalidateLiveDataCache()
        for(const playerId of affectedPlayerIds){
          await materializePlayerOutlook(playerId,{invalidate:false})
        }
        sendJson(res,200,{signals:updatedSignals,count:updatedSignals.length})
      }catch(error){
        if(transactionStarted)await getDb().query('ROLLBACK').catch(()=>{})
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
          await expirePriorRoleSignals(db, Number(player.id), 'EXPECTED_ROLE')
          const result=await db.query(
            'INSERT INTO "PlayerSignal" ("playerId","gameweekId",kind,value,"sourceType","sourceUrl","evidenceSummary",confidence,"observedAt","validUntil",status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
            [player.id,gameweek,'EXPECTED_ROLE',JSON.stringify({note:summary}),sourceType,sourceUrl,`[${player.name}] ${summary}`,payloadConfidence,observedAt,validUntil,status]
          )
          if(result.rows[0]){
            created.push({...result.rows[0],value:{note:summary},confidence:payloadConfidence,gameweek,autoApproved:false})
          }
        }
        invalidateLiveDataCache()
        sendJson(res,201,{created:created.length,signals:created,autoApproved:false})
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Ingest failed'})}
      return
    }

    if(request==='/api/creator-claims'&&req.method==='GET'){
      try{
        const db=await getDb(),params=new URL(req.url||'/',`http://${host}`).searchParams
        const matchStatus=params.get('matchStatus')||null,limit=Math.min(300,Math.max(1,Number(params.get('limit'))||100))
        const result=await db.query(`SELECT claim.*,content.creator,content.title AS "contentTitle",content.url AS "contentUrl",content.platform FROM "CreatorClaim" claim JOIN "CreatorContent" content ON content.id=claim."contentId" WHERE ($1 IS NULL OR claim."matchStatus"=$1) ORDER BY claim."createdAt" DESC LIMIT $2`,[matchStatus,limit])
        sendJson(res,200,{claims:result.rows.map(row=>({...row,numericClaims:parseJson(row.numericClaims,[]),relatedMentions:parseJson(row.relatedMentions,[]),signalValue:parseJson(row.signalValue,{}),matchCandidates:parseJson(row.matchCandidates,[])}))})
      }catch(error){sendJson(res,500,{error:error instanceof Error?error.message:'Unable to read creator claims'})}
      return
    }

    const creatorClaimMatch=request.match(/^\/api\/creator-claims\/(.+)$/)
    if(creatorClaimMatch&&req.method==='PATCH'){
      try{
        const claimId=decodeURIComponent(creatorClaimMatch[1]),payload=await readRequestBody(req),db=await getDb()
        const joined=(await db.query(`SELECT claim.*,content.platform,content."externalId",content.creator,content.title,content.url,content."publishedAt" FROM "CreatorClaim" claim JOIN "CreatorContent" content ON content.id=claim."contentId" WHERE claim.id=$1`,[claimId])).rows[0]
        if(!joined)return sendJson(res,404,{error:'Creator claim not found'})
        if(payload.dismiss===true){
          await db.query('UPDATE "CreatorClaim" SET "matchStatus"=$1,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$2',['DISMISSED',claimId])
          sendJson(res,200,{claim:{...joined,matchStatus:'DISMISSED'}});return
        }
        const playerId=Number(payload.playerId),data=await liveData(),player=data.players.find(candidate=>candidate.id===playerId)
        if(!player)throw new Error('A valid playerId is required')
        await db.query('UPDATE "CreatorClaim" SET "resolvedPlayerId"=$1,"matchStatus"=$2,"matchConfidence"=1,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$3',[playerId,'MATCHED',claimId])
        if(payload.rememberAlias!==false){
          const alias=normalizeEntityText(joined.rawPlayerName)
          await db.query(`INSERT INTO "PlayerAlias" (alias,"playerId","canonicalName") VALUES ($1,$2,$3) ON CONFLICT (alias) DO UPDATE SET "playerId"=EXCLUDED."playerId","canonicalName"=EXCLUDED."canonicalName","updatedAt"=CURRENT_TIMESTAMP`,[alias,playerId,player.name])
        }
        const updated={...joined,resolvedPlayerId:playerId,matchStatus:'MATCHED',matchConfidence:1}
        const source={platform:joined.platform,externalId:joined.externalId,creator:joined.creator,title:joined.title,url:joined.url,publishedAt:joined.publishedAt}
        const signalResult=await createSignalForCreatorClaim(db,updated,source,data.currentGameweek)
        sendJson(res,200,{claim:{...updated,signalId:signalResult.signal.id},signal:signalResult.signal,created:signalResult.created})
      }catch(error){sendJson(res,400,{error:error instanceof Error?error.message:'Unable to resolve creator claim'})}
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

    if (request === '/api/fpl-squad') {
      const urlParams = new URLSearchParams((req.url || '').split('?')[1] || '')
      const teamIdStr = urlParams.get('teamId')
      const teamId = teamIdStr ? Number(teamIdStr) : null
      if (!teamId || isNaN(teamId)) {
        res.writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'Valid numeric teamId parameter is required' }))
        return
      }

      try {
        let gw = urlParams.get('gameweek')
        if (!gw) {
          try {
            const entryRes = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/`, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
            })
            if (entryRes.ok) {
              const entryData = await entryRes.json()
              gw = entryData.current_event || entryData.summary_overall_event || 28
            } else {
              gw = 28
            }
          } catch {
            gw = 28
          }
        }

        const picksRes = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${gw}/picks/`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
        })
        if (!picksRes.ok) {
          throw new Error(`FPL squad fetch failed: HTTP ${picksRes.status}`)
        }
        const picksData = await picksRes.json()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ picks: picksData.picks, gameweek: Number(gw) }))
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: err instanceof Error ? err.message : 'Squad fetch failed' }))
        }
      }
      return
    }

    if (request === '/api/fpl-account') {
      const urlParams = new URLSearchParams((req.url || '').split('?')[1] || '')
      const teamIdStr = urlParams.get('teamId')
      const teamId = teamIdStr ? Number(teamIdStr) : null
      if (!teamId || isNaN(teamId)) {
        res.writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'Valid numeric teamId parameter is required' }))
        return
      }

      try {
        const entryRes = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
        })
        if (!entryRes.ok) {
          throw new Error(`FPL entry fetch failed: HTTP ${entryRes.status}`)
        }
        const entryData = await entryRes.json()

        const gw = urlParams.get('gameweek') || entryData.current_event || entryData.summary_overall_event || 1
        const picksRes = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${gw}/picks/`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
        })

        let picks = []
        let entryHistory = null
        if (picksRes.ok) {
          const picksData = await picksRes.json()
          picks = picksData.picks || []
          entryHistory = picksData.entry_history || null
        }

        const squadValue = entryHistory?.value ? entryHistory.value / 10 : (entryData.last_deadline_value ? entryData.last_deadline_value / 10 : 100)
        const bank = entryHistory?.bank ? entryHistory.bank / 10 : (entryData.last_deadline_bank ? entryData.last_deadline_bank / 10 : 0)

        const payload = {
          teamId: entryData.id || teamId,
          teamName: entryData.name || `Team #${teamId}`,
          managerName: `${entryData.player_first_name || ''} ${entryData.player_last_name || ''}`.trim(),
          totalPoints: Number(entryHistory?.total_points ?? entryData.summary_overall_points) || 0,
          gameweekPoints: Number(entryHistory?.points ?? entryData.summary_event_points) || 0,
          squadValue,
          bank,
          overallRank: entryData.summary_overall_rank || null,
          transfersCost: Number(entryHistory?.event_transfers_cost) || 0,
          eventTransfers: Number(entryHistory?.event_transfers) || 0,
          totalTransfers: Number(entryData.last_deadline_total_transfers) || 0,
          currentGameweek: Number(gw),
          picks,
          leagues: entryData.leagues || { classic: [], h2h: [] },
          lastSynced: new Date().toISOString()
        }

        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          .end(JSON.stringify(payload))
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: err instanceof Error ? err.message : 'FPL account fetch failed' }))
        }
      }
      return
    }

    if (request === '/api/fpl-league-details') {
      const urlParams = new URLSearchParams((req.url || '').split('?')[1] || '')
      const leagueIdStr = urlParams.get('leagueId')
      const leagueId = leagueIdStr ? Number(leagueIdStr) : null
      if (!leagueId || isNaN(leagueId)) {
        res.writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'Valid numeric leagueId parameter is required' }))
        return
      }

      try {
        const standingsRes = await fetch(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
        })
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
              const picksRes = await fetch(`https://fantasy.premierleague.com/api/entry/${rival.entry}/event/${defaultGw}/picks/`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
              })
              const historyRes = await fetch(`https://fantasy.premierleague.com/api/entry/${rival.entry}/history/`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
              })

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

        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({
            league: standingsData.league,
            standings: enrichedRivals,
            totalAnalyzed,
            isPreSeason: Boolean(isPreSeason),
            effectiveOwnership
          }))
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: err instanceof Error ? err.message : 'FPL league details fetch failed' }))
        }
      }
      return
    }

    if (request === '/api/user-profile') {
      if (req.method === 'GET') {
        try {
          const db = await getDb()
          const resDb = await db.query('SELECT * FROM "UserAccount" WHERE id=\'default\' LIMIT 1')
          const prefDb = await db.query('SELECT * FROM "UserPreference" WHERE id=\'default\' LIMIT 1').catch(() => ({ rows: [] }))
          const pref = prefDb.rows[0] || {}
          if (resDb.rows.length === 0) {
            let selectedIds = []
            try { selectedIds = JSON.parse(pref.selectedIds || '[]') } catch {}
            let challengeResult = null
            try { challengeResult = pref.challengeResult ? JSON.parse(pref.challengeResult) : null } catch {}
            let stagedReviews = {}
            try { stagedReviews = JSON.parse(pref.stagedReviews || '{}') } catch {}
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
              account: null,
              selectedIds: selectedIds.length ? selectedIds : null,
              preferences: {
                userName: pref.userName || '', selectedIds, lockedIds: JSON.parse(pref.lockedIds || '[]'),
                bank: pref.bank == null ? null : Number(pref.bank), freeTransfers: Number(pref.freeTransfers ?? 1),
                defaultLeagueId: pref.defaultLeagueId == null ? null : Number(pref.defaultLeagueId),
                onboardingCompleted: Boolean(pref.onboardingCompleted), challengeResult, stagedReviews,
              },
            }))
            return
          }
          const row = resDb.rows[0]
          let selectedIds = []
          try { selectedIds = JSON.parse(row.selectedIds) } catch {}
          const account = {
            teamId: Number(row.teamId),
            teamName: row.teamName,
            managerName: row.managerName,
            totalPoints: Number(row.totalPoints),
            gameweekPoints: Number(row.gameweekPoints),
            squadValue: Number(row.squadValue),
            bank: Number(row.bank),
            overallRank: row.overallRank ? Number(row.overallRank) : null,
            transfersCost: Number(row.transfersCost),
            eventTransfers: Number(row.eventTransfers),
            totalTransfers: Number(row.totalTransfers),
            currentGameweek: Number(row.currentGameweek),
            aiProvider: row.aiProvider || undefined,
            apiKey: row.apiKey || undefined,
            lastSynced: row.lastSynced ? new Date(row.lastSynced).toISOString() : new Date().toISOString()
          }
          let preferenceSelectedIds = selectedIds
          try { preferenceSelectedIds = JSON.parse(pref.selectedIds || JSON.stringify(selectedIds)) } catch {}
          let challengeResult = null
          try { challengeResult = pref.challengeResult ? JSON.parse(pref.challengeResult) : null } catch {}
          let stagedReviews = {}
          try { stagedReviews = JSON.parse(pref.stagedReviews || '{}') } catch {}
          let lockedIds = []
          try { lockedIds = JSON.parse(pref.lockedIds || '[]') } catch {}
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            account,
            selectedIds: preferenceSelectedIds,
            preferences: {
              userName: pref.userName || account.managerName || '', selectedIds: preferenceSelectedIds, lockedIds,
              bank: pref.bank == null ? account.bank : Number(pref.bank), freeTransfers: Number(pref.freeTransfers ?? 1),
              defaultLeagueId: pref.defaultLeagueId == null ? null : Number(pref.defaultLeagueId),
              onboardingCompleted: Boolean(pref.onboardingCompleted), challengeResult, stagedReviews,
            },
          }))
        } catch (err) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ account: null, selectedIds: null }))
        }
        return
      }

      if (req.method === 'POST') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
          try {
            const { account, selectedIds } = JSON.parse(body || '{}')
            if (!account || !account.teamId) {
              res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Account object with teamId required' }))
              return
            }
            const db = await getDb()
            const idsJson = JSON.stringify(Array.isArray(selectedIds) ? selectedIds : [])
            await db.query(
              `INSERT INTO "UserAccount" ("id", "teamId", "teamName", "managerName", "totalPoints", "gameweekPoints", "squadValue", "bank", "overallRank", "transfersCost", "eventTransfers", "totalTransfers", "currentGameweek", "selectedIds", "aiProvider", "apiKey", "lastSynced", "updatedAt")
               VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
               ON CONFLICT ("id") DO UPDATE SET
                 "teamId" = EXCLUDED."teamId",
                 "teamName" = EXCLUDED."teamName",
                 "managerName" = EXCLUDED."managerName",
                 "totalPoints" = EXCLUDED."totalPoints",
                 "gameweekPoints" = EXCLUDED."gameweekPoints",
                 "squadValue" = EXCLUDED."squadValue",
                 "bank" = EXCLUDED."bank",
                 "overallRank" = EXCLUDED."overallRank",
                 "transfersCost" = EXCLUDED."transfersCost",
                 "eventTransfers" = EXCLUDED."eventTransfers",
                 "totalTransfers" = EXCLUDED."totalTransfers",
                 "currentGameweek" = EXCLUDED."currentGameweek",
                 "selectedIds" = EXCLUDED."selectedIds",
                 "aiProvider" = COALESCE(EXCLUDED."aiProvider", "UserAccount"."aiProvider"),
                 "apiKey" = COALESCE(EXCLUDED."apiKey", "UserAccount"."apiKey"),
                 "lastSynced" = NOW(),
                 "updatedAt" = NOW()`,
              [
                account.teamId,
                account.teamName || '',
                account.managerName || '',
                account.totalPoints || 0,
                account.gameweekPoints || 0,
                account.squadValue || 100,
                account.bank || 0,
                account.overallRank || null,
                account.transfersCost || 0,
                account.eventTransfers || 0,
                account.totalTransfers || 0,
                account.currentGameweek || 1,
                idsJson,
                account.aiProvider || null,
                account.apiKey || null
              ]
            )
            await db.query(`INSERT INTO "UserPreference" ("id","userName","selectedIds","bank","updatedAt") VALUES ('default',$1,$2,$3,NOW()) ON CONFLICT ("id") DO UPDATE SET "userName"=EXCLUDED."userName","selectedIds"=EXCLUDED."selectedIds","bank"=EXCLUDED."bank","updatedAt"=NOW()`, [account.managerName || '', idsJson, account.bank ?? null])
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true }))
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : 'Save failed' }))
          }
        })
        return
      }

      if (req.method === 'DELETE') {
        try {
          const db = await getDb()
          await db.query('DELETE FROM "UserAccount" WHERE id=\'default\'')
          await db.query('DELETE FROM "UserPreference" WHERE id=\'default\'')
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true }))
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Delete failed' }))
        }
        return
      }
    }

    if (request === '/api/user-preferences' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req)
        const db = await getDb()
        await db.query(`INSERT INTO "UserPreference" ("id") VALUES ('default') ON CONFLICT ("id") DO NOTHING`)
        const sets = []
        const params = []
        const add = (column, value) => { sets.push(`"${column}"=$${params.length + 1}`); params.push(value) }
        if (Array.isArray(body.selectedIds)) add('selectedIds', JSON.stringify(body.selectedIds.filter(Number.isInteger)))
        if (Array.isArray(body.lockedIds)) add('lockedIds', JSON.stringify(body.lockedIds.filter(Number.isInteger)))
        if (Object.prototype.hasOwnProperty.call(body, 'challengeResult')) add('challengeResult', body.challengeResult == null ? null : JSON.stringify(body.challengeResult))
        if (Object.prototype.hasOwnProperty.call(body, 'stagedReviews')) add('stagedReviews', JSON.stringify(body.stagedReviews || {}))
        if (typeof body.userName === 'string') add('userName', body.userName.slice(0, 120))
        if (body.bank === null || Number.isFinite(Number(body.bank))) add('bank', body.bank === null ? null : Number(body.bank))
        if (Number.isFinite(Number(body.freeTransfers))) add('freeTransfers', Math.max(0, Math.min(5, Math.round(Number(body.freeTransfers)))))
        if (body.defaultLeagueId === null || Number.isInteger(Number(body.defaultLeagueId))) add('defaultLeagueId', body.defaultLeagueId == null ? null : Number(body.defaultLeagueId))
        if (Object.prototype.hasOwnProperty.call(body, 'onboardingCompleted')) add('onboardingCompleted', body.onboardingCompleted ? 1 : 0)
        if (sets.length) await db.query(`UPDATE "UserPreference" SET ${sets.join(',')},"updatedAt"=NOW() WHERE id='default'`, params)
        sendJson(res, 200, { success: true })
      } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : 'Could not save user preferences' }) }
      return
    }


    if (request === '/api/ask' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}')
          const { question, context, userApiKey, userProvider, userModel } = payload
          if (!question) {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Question is required' }))
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
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(llmResult))
          } else {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({
              answer: null,
              provider: 'Deterministic Engine (No API Key)'
            }))
          }
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: err instanceof Error ? err.message : 'LLM processing failed' }))
          }
        }
      })
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
      console.error(`❌ Dev server error: ${err.message}`)
      process.exit(1)
    }
  })

  server.listen(targetPort, host, () => {
    console.log(`Insomnia FPL running at http://${host}:${targetPort}`)
    performColdStartInitialization().catch(err => console.error('Cold-start initialization failed:', err))
  })
}

startServerOnAvailablePort(port)
