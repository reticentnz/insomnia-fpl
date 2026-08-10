import { findTransferRoutesToTarget, horizonProjection, type Player, type Transfer } from './domain.ts'
import type { PlayerSignal } from './player-signals'

// Keep the public FPL response shape outside the domain layer. A server-side
// ingestion job can use the same normalizer and persist snapshots later.
export type RawFplBootstrap = { elements: Array<Record<string, unknown>>; teams: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; fixtures: Array<Record<string, unknown>> }
export type ExplanationContext = { modelVersion:string; horizon:number; squad:Player[]; catalog:Player[]; captain:Player|null; transfers:Transfer[]; decision: { roll: boolean; transfer: Transfer | null; freeTransfers: number; reason: string }; bank:number; freeTransfers:number; startingXI?: Player[]; currentGameweek?: number }

export function parseTeamId(input:string): number|null { const match=input.trim().match(/(?:entry\/|^)(\d+)/); return match?Number(match[1]):null }

function normalizeSearchText(value:string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim() }

function editDistance(left:string,right:string) {
  const row=Array.from({length:right.length+1},(_,index)=>index)
  for(let i=1;i<=left.length;i++){
    let previous=row[0]
    row[0]=i
    for(let j=1;j<=right.length;j++){
      const saved=row[j]
      row[j]=Math.min(row[j]+1,row[j-1]+1,previous+(left[i-1]===right[j-1]?0:1))
      previous=saved
    }
  }
  return row[right.length]
}

const STOP_WORDS = new Set([
  'vs', 'versus', 'or', 'and', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'for', 'to', 'in', 'out', 'my', 'the', 'a', 'an', 'should', 'i', 'we', 'you',
  'who', 'what', 'which', 'how', 'why', 'get', 'buy', 'sell', 'roll', 'start', 'bench',
  'captain', 'week', 'this', 'next', 'team', 'squad', 'transfer', 'transfers', 'player',
  'players', 'lineup', 'with', 'from', 'on', 'at', 'of', 'over', 'under', 'compare', 'better',
  'option', 'options', 'than', 'between', 'pick', 'choose', 'starting', 'starters', 'value', 'price',
  'tell', 'me', 'about', 'can', 'think', 'thoughts', 'opinion', 'recommend', 'recommendation',
  'suggestions', 'suggestion', 'give', 'info', 'information', 'detail', 'details', 'analyze',
  'analyse', 'analysis', 'stats', 'stat', 'show', 'view', 'will', 'would', 'could', 'does',
  'do', 'did', 'has', 'have', 'had'
])

const ALIASES: Record<string, string> = {
  'kdb': 'De Bruyne',
  'trent': 'Alexander-Arnold',
  'vvd': 'van Dijk',
  'bruno': 'Bruno Fernandes',
}

function findWordMatchPos(text: string, searchStr: string): { startPos: number; endPos: number } | null {
  let searchIdx = 0
  let pos = -1
  while ((pos = text.indexOf(searchStr, searchIdx)) !== -1) {
    const isStart = pos === 0 || text[pos - 1] === ' '
    const isEnd = pos + searchStr.length === text.length || text[pos + searchStr.length] === ' '
    if (isStart && isEnd) {
      return { startPos: pos, endPos: pos + searchStr.length }
    }
    searchIdx = pos + 1
  }
  return null
}

export function resolveMultiplePlayerMentions(question: string, catalog: Player[]): Player[] {
  const normalized = normalizeSearchText(question)
  if (!normalized) return []

  const rawQTokens = normalized.split(' ').filter(Boolean)
  const qTokens = rawQTokens.filter(t => !STOP_WORDS.has(t))

  const scored: Array<{ player: Player; score: number; startPos: number; endPos: number }> = []

  for (const player of catalog) {
    const pFull = normalizeSearchText(player.name)
    const pTokens = pFull.split(' ').filter(Boolean)
    let score = 0
    let startPos = Infinity
    let endPos = -1

    // 1. Exact full name match in question (requiring whole-word boundary)
    const exactMatch = findWordMatchPos(normalized, pFull)
    if (exactMatch) {
      score += 1000 + pFull.length
      startPos = Math.min(startPos, exactMatch.startPos)
      endPos = Math.max(endPos, exactMatch.endPos)
    }

    // 2. Token / alias matching
    for (const qToken of qTokens) {
      if (qToken.length < 3) continue
      const qTokenMatch = findWordMatchPos(normalized, qToken)
      if (!qTokenMatch) continue
      const tokenPos = qTokenMatch.startPos

      const aliasValue = ALIASES[qToken]
      if (aliasValue && pFull.includes(normalizeSearchText(aliasValue))) {
        score += 800
        startPos = Math.min(startPos, tokenPos)
        endPos = Math.max(endPos, tokenPos + qToken.length)
      }

      pTokens.forEach((pToken, idx) => {
        if (pToken.length < 3) return
        if (pToken === qToken) {
          const isLastName = idx === pTokens.length - 1
          score += isLastName ? 500 : 300
          startPos = Math.min(startPos, tokenPos)
          endPos = Math.max(endPos, tokenPos + qToken.length)
        } else if (qToken.length >= 4 && pToken.length >= 4) {
          const dist = editDistance(pToken, qToken)
          if (dist <= Math.max(1, Math.floor(pToken.length * 0.25))) {
            score += 200
            startPos = Math.min(startPos, tokenPos)
            endPos = Math.max(endPos, tokenPos + qToken.length)
          }
        }
      })
    }

    if (score >= 200 && startPos !== Infinity) {
      scored.push({ player, score, startPos, endPos })
    }
  }

  // Filter out candidates that overlap with a higher scoring match on the same query span
  const nonOverlapping = scored.filter(item => {
    return !scored.some(other =>
      other.player.id !== item.player.id &&
      other.score > item.score &&
      other.startPos < item.endPos &&
      other.endPos > item.startPos
    )
  })

  nonOverlapping.sort((a, b) => a.startPos - b.startPos || b.score - a.score)

  const result: Player[] = []
  const seenIds = new Set<number>()
  for (const item of nonOverlapping) {
    if (!seenIds.has(item.player.id)) {
      seenIds.add(item.player.id)
      result.push(item.player)
    }
  }
  return result
}

export function resolvePlayerMention(question: string, catalog: Player[]): Player | null {
  const players = resolveMultiplePlayerMentions(question, catalog)
  return players[0] || null
}

function compactPlayer(player:Player,horizon:number) {
  return {name:player.name,club:player.club,position:player.position,price:+player.price.toFixed(1),xPts:+horizonProjection(player,horizon).toFixed(1),fixture:player.fixture}
}

function compactTransfer(transfer:Transfer,horizon:number) {
  return {out:compactPlayer(transfer.out,horizon),in:compactPlayer(transfer.in,horizon),hitCost:transfer.hitCost,netGain:+transfer.net.toFixed(1),bankChange:+(-transfer.priceDelta).toFixed(1)}
}

export function buildExplanationContext(args:ExplanationContext,question='') {
  const catalog=args.catalog||args.squad
  const mentionedPlayers=resolveMultiplePlayerMentions(question,catalog)
  const primaryMentioned=mentionedPlayers[0]||null
  const normalized=normalizeSearchText(question)
  const isComparisonQuery=/\b(vs|versus|or|compare|better|between|prefer|against)\b/.test(normalized)
  const wantsCaptain=/\b(captain|captaincy|armband|vice captain)\b/.test(normalized)
  const wantsLineup=/\b(starting xi|lineup|line up|start|bench|team selection)\b/.test(normalized)
  const wantsTransfer=/\b(transfer|buy|sell|replace|swap|afford|get|bring|into the team|move)\b/.test(normalized)
  const base={currentGameweek:args.currentGameweek||1,horizonGameweeks:args.horizon,bank:args.bank,freeTransfers:args.freeTransfers,pricingBasis:'Current catalogue prices; verify official selling prices before acting.'}

  if(mentionedPlayers.length>=2 || (mentionedPlayers.length===1 && isComparisonQuery && !wantsTransfer && !wantsCaptain)){
    const playersToCompare=mentionedPlayers.slice(0,3)
    const summaryText = playersToCompare.map(p =>
      `${p.name} (${p.club}, ${p.position}, £${p.price.toFixed(1)}m, ${horizonProjection(p, args.horizon).toFixed(1)} xPts over ${args.horizon} GWs, next fixture: ${p.fixture})`
    ).join(' vs ')

    return {
      ...base,
      intent:'player_comparison',
      comparisonSummary:`Direct stats provided for: ${summaryText}`,
      players:playersToCompare.map(p=>({
        ...compactPlayer(p,args.horizon),
        owned:args.squad.some(s=>s.id===p.id),
        expectedMinutes:p.expectedMinutes??90,
        status:p.status||'AVAILABLE',
        upcomingFixtures:(p.upcomingFixtures||[]).slice(0,args.horizon).map(f=>`${f.opponent} (${f.venue})`)
      }))
    }
  }

  if(primaryMentioned&&wantsTransfer){
    const plan=findTransferRoutesToTarget(primaryMentioned,args.squad,catalog,args.horizon,args.bank,args.freeTransfers,5)
    return {...base,intent:'named_player_transfer',target:compactPlayer(plan.target,args.horizon),alreadyOwned:plan.alreadyOwned,directShortfall:plan.directShortfall,routes:plan.routes.map(route=>({moves:route.moves.map(move=>({out:compactPlayer(move.out,args.horizon),in:compactPlayer(move.in,args.horizon)})),rawGain:route.rawGain,hitCost:route.hitCost,netGain:route.netGain,bankAfter:route.bankAfter}))}
  }

  const captainRankings=args.squad.map(player=>compactPlayer(player,args.horizon)).sort((a,b)=>b.xPts-a.xPts).slice(0,3)
  if(wantsCaptain)return {...base,intent:'captaincy',captainOptions:captainRankings}

  const starters=args.startingXI||args.squad.slice(0,11)
  if(wantsLineup){
    const starterIds=new Set(starters.map(player=>player.id))
    return {...base,intent:'lineup',startingXI:starters.map(player=>compactPlayer(player,args.horizon)),bench:args.squad.filter(player=>!starterIds.has(player.id)).map(player=>compactPlayer(player,args.horizon)),captainOptions:captainRankings}
  }

  if(primaryMentioned)return {
    ...base,
    intent:'player_question',
    playerSummary:`Stats provided for ${primaryMentioned.name} (${primaryMentioned.club}, ${primaryMentioned.position}, £${primaryMentioned.price.toFixed(1)}m, ${horizonProjection(primaryMentioned, args.horizon).toFixed(1)} xPts over ${args.horizon} GWs, next fixture: ${primaryMentioned.fixture})`,
    player:{
      ...compactPlayer(primaryMentioned,args.horizon),
      owned:args.squad.some(player=>player.id===primaryMentioned.id),
      expectedMinutes:primaryMentioned.expectedMinutes??90,
      status:primaryMentioned.status||'AVAILABLE',
      upcomingFixtures:(primaryMentioned.upcomingFixtures||[]).slice(0,args.horizon).map(f=>`${f.opponent} (${f.venue})`)
    }
  }

  const wantsRanking = /\b(top|best|highest|leading|rank|ranking|ranked|options|picks|targets)\b/.test(normalized) || /\b(midfielders?|mids?|forwards?|fwds?|strikers?|defenders?|defs?|goalkeepers?|keepers?|gk|gkp)\b/.test(normalized)
  let posTarget: string | null = null
  if (/\b(midfielders?|mids?|midfield)\b/.test(normalized)) posTarget = 'MID'
  else if (/\b(forwards?|fwds?|strikers?|attackers?)\b/.test(normalized)) posTarget = 'FWD'
  else if (/\b(defenders?|defs?|backs?)\b/.test(normalized)) posTarget = 'DEF'
  else if (/\b(goalkeepers?|keepers?|gk|gkp)\b/.test(normalized)) posTarget = 'GKP'

  if ((posTarget || (wantsRanking && !wantsTransfer)) && !primaryMentioned) {
    const countMatch = normalized.match(/\b(top|best)\s+(\d{1,2})\b/)
    const limit = countMatch ? Math.min(10, Math.max(3, parseInt(countMatch[2], 10))) : 5
    const pool = posTarget ? catalog.filter(p => p.position === posTarget) : catalog
    const ranked = pool
      .slice()
      .sort((a, b) => horizonProjection(b, args.horizon) - horizonProjection(a, args.horizon))
      .slice(0, limit)

    const summaryText = ranked.map(p =>
      `${p.name} (${p.club}, £${p.price.toFixed(1)}m, ${horizonProjection(p, args.horizon).toFixed(1)} xPts)`
    ).join(', ')

    return {
      ...base,
      intent: 'position_ranking',
      positionTarget: posTarget || 'ALL',
      rankingSummary: `Top ${ranked.length} ${posTarget || 'overall'} players by xPts: ${summaryText}`,
      rankedPlayers: ranked.map(p => ({
        ...compactPlayer(p, args.horizon),
        owned: args.squad.some(s => s.id === p.id),
        expectedMinutes: p.expectedMinutes ?? 90,
        status: p.status || 'AVAILABLE',
        upcomingFixtures: (p.upcomingFixtures || []).slice(0, args.horizon).map(f => `${f.opponent} (${f.venue})`)
      }))
    }
  }

  const bestMove=args.decision.transfer
  return {...base,intent:wantsTransfer?'general_transfer':'weekly_advice',deterministicVerdict:args.decision.roll?'ROLL TRANSFER':bestMove?`${bestMove.out.name} -> ${bestMove.in.name}`:'NO MOVE',deterministicReason:args.decision.reason,topTransfers:args.transfers.slice(0,5).map(transfer=>compactTransfer(transfer,args.horizon)),captainOptions:captainRankings}
}
export interface FplLeagueSummary {
  id: number;
  name: string;
  short_name: string | null;
  created: string;
  closed: boolean;
  max_entries: number | null;
  league_type: string;
  scoring: string;
  start_event: number;
  entry_can_leave: boolean;
  entry_can_rejoin: boolean;
  entry_can_stop: boolean;
  entry_rank: number | null;
  entry_last_rank: number | null;
  active: boolean;
}

export interface FplAccount {
  teamId: number;
  teamName: string;
  managerName: string;
  totalPoints: number;
  gameweekPoints: number;
  squadValue: number;
  bank: number;
  overallRank: number | null;
  transfersCost: number;
  eventTransfers: number;
  totalTransfers: number;
  currentGameweek: number;
  lastSynced: string;
  leagues?: {
    classic: FplLeagueSummary[];
    h2h: FplLeagueSummary[];
  };
}

export interface LeagueRivalPick {
  element: number;
  position: number;
  multiplier: number;
  is_captain: boolean;
  is_vice_captain: boolean;
}

export interface LeagueRivalChip {
  name: string;
  time: string;
  event: number;
}

export interface LeagueRival {
  id: number;
  event_total: number;
  player_name: string;
  rank: number;
  last_rank: number;
  rank_sort: number;
  total: number;
  entry: number;
  entry_name: string;
  activeChip: string | null;
  eventTransfers: number;
  eventTransfersCost: number;
  picks: LeagueRivalPick[];
  chipsUsed: LeagueRivalChip[];
}

export interface LeaguePlayerEO {
  element: number;
  ownersCount: number;
  captainsCount: number;
  tripleCaptainsCount: number;
  ownershipPercent: number;
  captaincyPercent: number;
  effectiveOwnership: number;
}

export interface LeagueDetailsResponse {
  league: {
    id: number;
    name: string;
    created: string;
    admin_entry: number;
    start_event: number;
  };
  standings: LeagueRival[];
  totalAnalyzed: number;
  isPreSeason?: boolean;
  effectiveOwnership: LeaguePlayerEO[];
}

export async function fetchFplAccount(teamId: number, gameweek?: number): Promise<{
  account: FplAccount;
  picks: Array<{ element: number; position?: number; multiplier?: number; is_captain?: boolean; is_vice_captain?: boolean }>;
}> {
  try {
    const url = gameweek ? `/api/fpl-account?teamId=${teamId}&gameweek=${gameweek}` : `/api/fpl-account?teamId=${teamId}`
    const response = await fetch(url)
    if (response.ok) {
      const data = await response.json()
      return {
        account: {
          teamId: data.teamId || teamId,
          teamName: data.teamName || `Team #${teamId}`,
          managerName: data.managerName || '',
          totalPoints: Number(data.totalPoints) || 0,
          gameweekPoints: Number(data.gameweekPoints) || 0,
          squadValue: Number(data.squadValue) || 100,
          bank: Number(data.bank) || 0,
          overallRank: data.overallRank ? Number(data.overallRank) : null,
          transfersCost: Number(data.transfersCost) || 0,
          eventTransfers: Number(data.eventTransfers) || 0,
          totalTransfers: Number(data.totalTransfers) || 0,
          currentGameweek: Number(data.currentGameweek) || gameweek || 1,
          leagues: data.leagues || { classic: [], h2h: [] },
          lastSynced: data.lastSynced || new Date().toISOString()
        },
        picks: data.picks || []
      }
    }
  } catch {
    // Fallback to direct client fetch
  }

  const entryRes = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/`)
  if (!entryRes.ok) throw new Error(`FPL account fetch failed: HTTP ${entryRes.status}`)
  const entryData = await entryRes.json()

  const gw = gameweek || entryData.current_event || entryData.summary_overall_event || 1
  const picksRes = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${gw}/picks/`)
  let picks: Array<{ element: number }> = []
  let entryHistory: any = null
  if (picksRes.ok) {
    const picksData = await picksRes.json()
    picks = picksData.picks || []
    entryHistory = picksData.entry_history || null
  }

  const squadValue = entryHistory?.value ? entryHistory.value / 10 : (entryData.last_deadline_value ? entryData.last_deadline_value / 10 : 100)
  const bank = entryHistory?.bank ? entryHistory.bank / 10 : (entryData.last_deadline_bank ? entryData.last_deadline_bank / 10 : 0)

  return {
    account: {
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
      lastSynced: new Date().toISOString()
    },
    picks
  }
}

export async function getUserProfile(): Promise<{ account: FplAccount | null; selectedIds: number[] | null }> {
  try {
    const res = await fetch('/api/user-profile')
    if (res.ok) {
      return await res.json()
    }
  } catch {}
  return { account: null, selectedIds: null }
}

export async function saveUserProfile(account: FplAccount, selectedIds?: number[]): Promise<boolean> {
  try {
    const res = await fetch('/api/user-profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, selectedIds })
    })
    return res.ok
  } catch {
    return false
  }
}

export async function deleteUserProfile(): Promise<boolean> {
  try {
    const res = await fetch('/api/user-profile', { method: 'DELETE' })
    return res.ok
  } catch {
    return false
  }
}

export async function fetchPublicSquad(teamId:number, gameweek?:number):Promise<{picks:Array<{element:number}>; gameweek:number}> {
  try {
    const res = await fetchFplAccount(teamId, gameweek)
    return { picks: res.picks, gameweek: res.account.currentGameweek }
  } catch {
    const gw = gameweek || 1
    const response = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${gw}/picks/`)
    if (!response.ok) throw new Error(`FPL squad import failed: ${response.status}`)
    const data = await response.json() as {picks:Array<{element:number}>}
    return { picks: data.picks, gameweek: gw }
  }
}
export async function fetchLiveCatalog():Promise<{capturedAt:string;currentGameweek:number|null;deadline:string|null;players:Player[]}> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 4000)
  try {
    const response=await fetch('/api/fpl-data',{signal:controller.signal})
    if(!response.ok) throw new Error(`Live FPL data unavailable: ${response.status}`)
    return await response.json() as {capturedAt:string;currentGameweek:number|null;deadline:string|null;players:Player[]}
  } finally {
    window.clearTimeout(timeoutId)
  }
}
export async function fetchLLMExplanation(question:string, context:ExplanationContext, config?:{apiKey?:string; provider?:string; model?:string}):Promise<{answer:string|null; provider:string; error?:string}|null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  try {
    const formattedContext = buildExplanationContext(context, question)
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        question,
        context: formattedContext,
        userApiKey: config?.apiKey,
        userProvider: config?.provider,
        userModel: config?.model
      })
    })
    clearTimeout(timeoutId)
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      return { answer: null, provider: config?.provider || 'API Error', error: data?.error || `HTTP ${response.status} error` }
    }
    return data as { answer:string|null; provider:string; error?:string }
  } catch (err) {
    clearTimeout(timeoutId)
    const isAbort = (err as Error)?.name === 'AbortError'
    return { answer: null, provider: 'Network Error', error: isAbort ? 'Request timed out (15s limit)' : (err instanceof Error ? err.message : 'Network request failed') }
  }
}

export type SquadChallengeResult = {
  summary: string
  researchSummary?: string
  provider: string
  provenanceWarning?: string
  sources: Array<{ url: string; title?: string }>
  signals: PlayerSignal[]
  proposedSignalCount?: number
  rejectedSignalCount?: number
  audits?: Array<{
    playerId: number
    playerName: string
    outcome: 'MATERIAL_RISK' | 'NO_MATERIAL_RISK' | 'INSUFFICIENT_EVIDENCE'
    expectedRole: 'FIRST_CHOICE' | 'ROTATION' | 'BACKUP' | 'OUT' | 'UNKNOWN'
    evidenceSummary: string
    sourceUrl: string | null
  }>
  usage?: {
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
    totalTokens: number
    webSearchCalls: number
    estimatedCostUsd: number | null
  }
}

export class SquadChallengeError extends Error {
  rawOutput: string
  outputTypes: string[]
  constructor(message: string, rawOutput = '', outputTypes: string[] = []) {
    super(message)
    this.name = 'SquadChallengeError'
    this.rawOutput = rawOutput
    this.outputTypes = outputTypes
  }
}

export async function challengeSquad(
  playerIds: number[],
  horizon: number,
  config?: { apiKey?: string; provider?: string; model?: string; startingPlayerIds?: number[] },
): Promise<SquadChallengeResult> {
  const response = await fetch('/api/challenge-squad', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerIds,
      horizon,
      startingPlayerIds: config?.startingPlayerIds,
      userApiKey: config?.apiKey,
      userProvider: config?.provider,
      userModel: config?.model,
    }),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.error || `Squad challenge failed: HTTP ${response.status}`)
  // Backward-compatible with a server that still returns the completed result.
  if (!data?.jobId) return data as SquadChallengeResult
  const pollDeadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < pollDeadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 2500))
    const pollResponse = await fetch(`/api/challenge-squad/${encodeURIComponent(data.jobId)}`)
    const poll = await pollResponse.json().catch(() => null)
    if (!pollResponse.ok) throw new Error(poll?.error || `Unable to check research status: HTTP ${pollResponse.status}`)
    if (poll?.status === 'completed') return poll.result as SquadChallengeResult
    if (poll?.status === 'failed') throw new SquadChallengeError(poll.error || 'Squad challenge failed', poll.rawOutput || '', poll.outputTypes || [])
  }
  throw new Error('Squad challenge did not finish within 10 minutes. The server may still have the job result.')
}

export async function updatePlayerSignalStatus(
  signalId: string,
  status: 'VERIFIED' | 'REJECTED',
): Promise<PlayerSignal> {
  let response: Response
  try {
    response = await fetch(`/api/player-signals/${encodeURIComponent(signalId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    })
  } catch (error) {
    if ((error as Error)?.name === 'TypeError') {
      throw new Error('Insomnia FPL server is offline. Restart npm run dev, then retry this pending finding.')
    }
    throw error
  }
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.error || `Could not update evidence: HTTP ${response.status}`)
  return (data.signal || data) as PlayerSignal
}

export async function createManualPlayerSignal(
  playerId: number,
  startProbability: number,
  note?: string,
): Promise<PlayerSignal> {
  const response = await fetch('/api/player-signals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      kind: 'START_PROBABILITY',
      manualOverride: true,
      evidenceSummary: note || `Manual override: start chance set to ${Math.round(startProbability * 100)}%`,
      value: { startProbability },
    }),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.error || `Could not create manual override: HTTP ${response.status}`)
  return (data.signal || data) as PlayerSignal
}

export async function fetchPlayerSignals(playerId?: number, status?: string): Promise<PlayerSignal[]> {
  try {
    const params = new URLSearchParams()
    if (playerId) params.set('playerId', String(playerId))
    if (status) params.set('status', status)
    const response = await fetch(`/api/player-signals?${params.toString()}`)
    if (!response.ok) return []
    const data = await response.json().catch(() => null)
    return (data?.signals || []) as PlayerSignal[]
  } catch {
    return []
  }
}

export async function fetchAllSignals(filters?: {
  playerId?: number;
  status?: string;
  sourceType?: string;
  limit?: number;
}): Promise<PlayerSignal[]> {
  try {
    const params = new URLSearchParams()
    if (filters?.playerId) params.set('playerId', String(filters.playerId))
    if (filters?.status) params.set('status', filters.status)
    if (filters?.sourceType) params.set('sourceType', filters.sourceType)
    if (filters?.limit) params.set('limit', String(filters.limit))
    const response = await fetch(`/api/player-signals?${params.toString()}`)
    if (!response.ok) return []
    const data = await response.json().catch(() => null)
    return (data?.signals || []) as PlayerSignal[]
  } catch {
    return []
  }
}

export async function ingestSignalText(payload: {
  text: string;
  sourceUrl?: string;
  sourceType?: string;
  playerHints?: string[];
  gameweek?: number;
}): Promise<{ created: number; signals: PlayerSignal[] }> {
  const response = await fetch('/api/signals/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.error || `Ingest failed: HTTP ${response.status}`)
  return data as { created: number; signals: PlayerSignal[] }
}

export async function fetchLeagueDetails(leagueId: number, gameweek?: number): Promise<LeagueDetailsResponse> {
  const url = gameweek ? `/api/fpl-league-details?leagueId=${leagueId}&gameweek=${gameweek}` : `/api/fpl-league-details?leagueId=${leagueId}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`League fetch failed: HTTP ${res.status}`)
  return await res.json()
}

export type SignalSourceEntry = {
  autoApprove: boolean;
  confidenceThreshold: number; // 0–1
};

export type SignalSourceConfig = Record<string, SignalSourceEntry>;

export const DEFAULT_SIGNAL_SOURCE_CONFIG: SignalSourceConfig = {
  OFFICIAL_FPL:       { autoApprove: true,  confidenceThreshold: 0.5 },
  OFFICIAL_CLUB:      { autoApprove: true,  confidenceThreshold: 0.5 },
  OFFICIAL_PL:        { autoApprove: true,  confidenceThreshold: 0.5 },
  YOUTUBE_TRANSCRIPT: { autoApprove: false, confidenceThreshold: 0.6 },
  JOURNALIST:         { autoApprove: false, confidenceThreshold: 0.6 },
  LLM_RESEARCH:       { autoApprove: false, confidenceThreshold: 0.7 },
  SCRAPE:             { autoApprove: false, confidenceThreshold: 0.6 },
  PREDICTED_LINEUP:   { autoApprove: false, confidenceThreshold: 0.65 },
  USER_FEEDBACK:      { autoApprove: false, confidenceThreshold: 0.4 },
  MANUAL_OVERRIDE:    { autoApprove: true,  confidenceThreshold: 0.0 },
};

export async function fetchSignalConfig(): Promise<SignalSourceConfig> {
  try {
    const res = await fetch('/api/signal-config')
    if (!res.ok) return { ...DEFAULT_SIGNAL_SOURCE_CONFIG }
    return await res.json()
  } catch {
    return { ...DEFAULT_SIGNAL_SOURCE_CONFIG }
  }
}

export async function saveSignalConfig(config: SignalSourceConfig): Promise<SignalSourceConfig> {
  const res = await fetch('/api/signal-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) throw new Error('Could not save signal config')
  return await res.json()
}

export type SystemStatus = {
  status: 'initializing' | 'seeding' | 'ready' | 'error';
  isSeeding: boolean;
  message: string;
  playerCount: number;
};

export async function fetchSystemStatus(): Promise<SystemStatus> {
  try {
    const res = await fetch('/api/system-status')
    if (!res.ok) return { status: 'ready', isSeeding: false, message: 'Server online', playerCount: 0 }
    return await res.json()
  } catch {
    return { status: 'ready', isSeeding: false, message: 'Offline mode', playerCount: 0 }
  }
}

const ONBOARDING_STORAGE_KEY = 'fplgod-onboarding-completed'

export function hasCompletedOnboarding(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function completeOnboarding(): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true')
  } catch {}
}

export function resetOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY)
  } catch {}
}

export type ServerAiConfig = {
  provider?: string;
  apiKey?: string;
};

export async function fetchServerAiConfig(): Promise<ServerAiConfig> {
  try {
    const res = await fetch('/api/ai-config')
    if (!res.ok) return {}
    return await res.json()
  } catch {
    return {}
  }
}

export async function saveServerAiConfig(provider: string, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch('/api/ai-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, apiKey }),
    })
    return res.ok
  } catch {
    return false
  }
}

