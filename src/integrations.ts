import { findTransferRoutesToTarget, getTeamColor, horizonProjection, type Player, type Transfer } from './domain.ts'
import type { PlayerSignal } from './player-signals'
import type { ProjectionInputCatalog } from './core/types'

// Keep the public FPL response shape outside the domain layer. A server-side
// ingestion job can use the same normalizer and persist snapshots later.
export type RawFplBootstrap = { elements: Array<Record<string, unknown>>; teams: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; fixtures: Array<Record<string, unknown>> }
export type ExplanationContext = { modelVersion:string; horizon:number; squad:Player[]; catalog:Player[]; captain:Player|null; transfers:Transfer[]; decision: { roll: boolean; transfer: Transfer | null; freeTransfers: number; reason: string }; bank:number; freeTransfers:number; startingXI?: Player[]; currentGameweek?: number }
export type TeamMarketSnapshot = {
  id: number;
  source: string;
  externalEventId: string;
  capturedAt: string;
  kickoff: string | null;
  homeTeam: string;
  awayTeam: string;
  homeWinProb: number | null;
  drawProb: number | null;
  awayWinProb: number | null;
  homeCleanSheetProb: number | null;
  awayCleanSheetProb: number | null;
};

function apiErrorMessage(data: any, fallback: string) {
  if (typeof data?.error === 'string') return data.error
  if (typeof data?.error?.message === 'string') return data.error.message
  return fallback
}

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
  const base={currentGameweek:args.currentGameweek||1,horizonGameweeks:args.horizon,bank:args.bank,freeTransfers:args.freeTransfers,pricingBasis:'Current catalogue prices; affordability requires an imported or user-confirmed selling price.'}

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
  id?: string;
  managerAccountId?: string | null;
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
  aiProvider?: string;
  apiKey?: string;
  lastSynced: string;
  leagues?: {
    classic: FplLeagueSummary[];
    h2h: FplLeagueSummary[];
  };
}

export type UserPreferences = {
  userName: string;
  selectedIds: number[];
  lockedIds: number[];
  bank: number | null;
  freeTransfers: number;
  defaultLeagueId: number | null;
  onboardingCompleted: boolean;
  challengeResult: unknown | null;
  stagedReviews: Record<number, 'VERIFIED' | 'REJECTED'>;
  draftSeason?: string | null;
  draftPlayerIds?: number[];
  draftLockedPlayerIds?: number[];
  draftRevision?: string;
  draftUpdatedAt?: string | null;
  seasonModeManagerAccountId?: string | null;
  seasonModeSeason?: string | null;
};

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
  value: number | null;
  bank: number | null;
  seasonHits: number;
  templateCount: number;
  starterCount: number;
  picks: LeagueRivalPick[];
  chipsUsed: LeagueRivalChip[];
  overlapPct?: number;
  sharedElements?: number[];
  myDifferentialIds?: number[];
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
  sampledManagerCount: number;
  totalManagerCount: number;
  pagination: { policy: 'FIRST_PAGE_SAMPLE' | 'AROUND_RANK'; fetchedPages: number; complete: boolean };
  yourRank?: number | null;
  sampledAroundYou?: boolean;
  isPreSeason?: boolean;
  effectiveOwnership: LeaguePlayerEO[];
}

export async function fetchFplAccount(teamId: number, gameweek?: number): Promise<{
  account: FplAccount;
  picks: Array<{ element: number; position?: number; multiplier?: number; is_captain?: boolean; is_vice_captain?: boolean; purchase_price?: number | null; selling_price?: number | null }>;
  planId?: string | null;
  parentPlanId?: string | null;
  sellingPrices: Record<number, number | null>;
  selectedIds: number[];
  lockedIds: number[];
  planBank: number | null;
  planFreeTransfers: number;
  squadAvailable: boolean;
  notice?: string;
}> {
  const response = await fetch('/api/manager/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ teamId, gameweek }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(apiErrorMessage(data, `FPL account import failed: HTTP ${response.status}`))
  const account = data.account || {}
  return {
    account: {
      id: account.id || data.snapshotMetadata?.managerAccountId || undefined,
      managerAccountId: account.id || data.snapshotMetadata?.managerAccountId || null,
      teamId: Number(account.teamId || teamId),
      teamName: account.teamName || `Team #${teamId}`,
      managerName: account.managerName || '',
      totalPoints: Number(account.totalPoints) || 0,
      gameweekPoints: Number(account.gameweekPoints) || 0,
      squadValue: Number(account.squadValue) || 0,
      bank: Number(account.bank) || 0,
      overallRank: account.overallRank == null ? null : Number(account.overallRank),
      transfersCost: Number(account.transfersCost) || 0,
      eventTransfers: Number(account.eventTransfers) || 0,
      totalTransfers: Number(account.totalTransfers) || 0,
      currentGameweek: Number(account.currentGameweek) || gameweek || 1,
      leagues: {
        classic: Array.isArray(account.leagues?.classic) ? account.leagues.classic : [],
        h2h: Array.isArray(account.leagues?.h2h) ? account.leagues.h2h : [],
      },
      lastSynced: account.lastSynced || new Date().toISOString(),
    },
    picks: (Array.isArray(data.squad) ? data.squad : []).map((player: any) => ({
      element: Number(player.fplId),
      position: Number(player.squadOrder),
      multiplier: Number(player.multiplier),
      is_captain: Boolean(player.isCaptain),
      is_vice_captain: Boolean(player.isViceCaptain),
      purchase_price: player.purchasePriceTenths,
      selling_price: player.sellingPriceTenths,
    })),
    planId: data.activePlan?.id || null,
    parentPlanId: data.activePlan?.parentPlanId || null,
    sellingPrices: Object.fromEntries((Array.isArray(data.squad) ? data.squad : []).map((player: any) => [Number(player.fplId), player.sellingPriceTenths == null ? null : Number(player.sellingPriceTenths)])),
    selectedIds: Array.isArray(data.activePlan?.players)
      ? data.activePlan.players.map((player: any) => Number(player.fplId)).filter(Number.isInteger)
      : (Array.isArray(data.squad) ? data.squad : []).map((player: any) => Number(player.fplId)).filter(Number.isInteger),
    lockedIds: Array.isArray(data.activePlan?.players)
      ? data.activePlan.players.filter((player: any) => player.locked).map((player: any) => Number(player.fplId)).filter(Number.isInteger)
      : [],
    planBank: data.activePlan?.bankTenths == null ? null : Number(data.activePlan.bankTenths) / 10,
    planFreeTransfers: Number(data.activePlan?.freeTransfers ?? 0),
    squadAvailable: data.importStatus?.squadAvailable !== false,
    notice: typeof data.importStatus?.message === 'string' ? data.importStatus.message : undefined,
  }
}

export async function getUserProfile(): Promise<{ account: FplAccount | null; selectedIds: number[] | null; planId?: string | null; parentPlanId?: string | null; sellingPrices?: Record<number, number | null>; preferences?: UserPreferences; snapshotMetadata?: { officialSnapshotId: string; snapshotSeason: string; officialPlayerCount: number; managerAccountId: string } | null }> {
  try {
    const [res, preferenceRes] = await Promise.all([fetch('/api/manager/current'), fetch('/api/user-preferences')])
    const storedPreferences = preferenceRes.ok ? await preferenceRes.json() : null
    if (res.ok) {
      const data = await res.json()
      const activePlanIds = Array.isArray(data.activePlan?.players)
        ? data.activePlan.players.map((player: { fplId?: number }) => Number(player.fplId)).filter(Number.isInteger)
        : []
      const officialIds = Array.isArray(data.squad)
        ? data.squad.map((player: { fplId?: number }) => Number(player.fplId)).filter(Number.isInteger)
        : []
      const selectedIds = activePlanIds.length ? activePlanIds : officialIds
      return {
        account: data.account ? { ...data.account, managerAccountId: data.account.id || data.snapshotMetadata?.managerAccountId || null } : null,
        selectedIds: selectedIds.length ? selectedIds : null,
        planId: data.activePlan?.id || null,
        parentPlanId: data.activePlan?.parentPlanId || null,
        sellingPrices: Object.fromEntries((Array.isArray(data.squad) ? data.squad : []).map((player: any) => [Number(player.fplId), player.sellingPriceTenths == null ? null : Number(player.sellingPriceTenths)])),
        snapshotMetadata: data.snapshotMetadata || null,
        preferences: {
          userName: storedPreferences?.userName || data.account?.managerName || '',
          selectedIds,
          lockedIds: Array.isArray(data.activePlan?.players)
            ? data.activePlan.players.filter((player: { locked?: boolean }) => player.locked).map((player: { fplId?: number }) => Number(player.fplId)).filter(Number.isInteger)
            : [],
          bank: data.activePlan?.bankTenths == null ? (data.account?.bank == null ? null : Number(data.account.bank)) : Number(data.activePlan.bankTenths) / 10,
          freeTransfers: data.activePlan?.freeTransfers == null ? (storedPreferences?.freeTransfers ?? 0) : Number(data.activePlan.freeTransfers),
          defaultLeagueId: storedPreferences?.defaultLeagueId ?? null,
          onboardingCompleted: storedPreferences?.onboardingCompleted ?? Boolean(data.account),
          challengeResult: storedPreferences?.challengeResult ?? null,
          stagedReviews: storedPreferences?.stagedReviews || {},
          draftSeason: storedPreferences?.draftSeason ?? null,
          draftPlayerIds: storedPreferences?.draftPlayerIds || [],
          draftLockedPlayerIds: storedPreferences?.draftLockedPlayerIds || [],
          draftRevision: storedPreferences?.draftRevision ?? '',
          draftUpdatedAt: storedPreferences?.draftUpdatedAt ?? null,
          seasonModeManagerAccountId: storedPreferences?.seasonModeManagerAccountId ?? null,
          seasonModeSeason: storedPreferences?.seasonModeSeason ?? null,
        },
      }
    }
    if (storedPreferences) return { account: null, selectedIds: null, preferences: { ...storedPreferences, selectedIds: [], lockedIds: [] } }
  } catch (error) {
    if (error instanceof Error && error.name !== 'TypeError') throw error
  }
  return { account: null, selectedIds: null }
}

export async function saveUserProfile(account: FplAccount, selectedIds?: number[], parentPlanId?: string | null, lockedPlayerIds: number[] = []): Promise<{ ok: boolean; planId?: string; parentPlanId?: string | null; bankTenths?: number | null; freeTransfers?: number; error?: string }> {
  try {
    if (!Array.isArray(selectedIds) || !selectedIds.length) return { ok: true }
    const res = await fetch('/api/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teamId: account.teamId, parentPlanId: parentPlanId || undefined, playerIds: selectedIds, lockedPlayerIds, name: 'Active plan', status: 'ACTIVE' })
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, planId: data.id, parentPlanId: data.parentPlanId, bankTenths: data.bankTenths, freeTransfers: data.freeTransfers, error: res.ok ? undefined : apiErrorMessage(data, 'Plan could not be saved') }
  } catch {
    return { ok: false, error: 'Plan save request failed' }
  }
}

export async function deleteUserProfile(): Promise<boolean> {
  try {
    const res = await fetch('/api/manager/current', { method: 'DELETE' })
    return res.ok
  } catch { return false }
}

export async function saveUserPreferences(update: Partial<UserPreferences>): Promise<boolean> {
  try {
    const { selectedIds: _selectedIds, lockedIds: _lockedIds, ...preferenceUpdate } = update
    if (!Object.keys(preferenceUpdate).length) return true
    const res = await fetch('/api/user-preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(preferenceUpdate),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function selectPlanRevision(planId: string): Promise<{ ok: boolean; plan?: any }> {
  try {
    const res = await fetch(`/api/plans/${encodeURIComponent(planId)}/select`, { method: 'POST' })
    const plan = await res.json().catch(() => null)
    return { ok: res.ok, plan }
  } catch { return { ok: false } }
}

export async function saveManagerAssumptions(teamId: number, update: { bank?: number; freeTransfers?: number }): Promise<boolean> {
  try {
    const body: Record<string, unknown> = { teamId }
    if (Number.isInteger(update.freeTransfers)) body.freeTransfers = update.freeTransfers
    if (!Object.prototype.hasOwnProperty.call(body, 'freeTransfers')) return true
    const res = await fetch('/api/manager/assumptions', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return res.ok
  } catch { return false }
}

export async function fetchPublicSquad(teamId:number, gameweek?:number):Promise<{picks:Array<{element:number}>; gameweek:number}> {
  const res = await fetchFplAccount(teamId, gameweek)
  return { picks: res.picks, gameweek: res.account.currentGameweek }
}
export async function fetchProjectionCatalog(asOf?: string): Promise<ProjectionInputCatalog> {
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''
  const response = await fetch(`/api/catalog${query}`)
  if (!response.ok) throw new Error(`Catalogue unavailable: ${response.status}`)
  return await response.json() as ProjectionInputCatalog
}

type ClientCatalogResponse = {
  capturedAt: string
  currentGameweek: number | null
  deadline: string | null
  season?: string
  currentSeason?: string
  players: Array<Omit<Player, 'colour'> & { colour?: string }>
}

export async function fetchLiveCatalog(retries = 3): Promise<{capturedAt:string;currentGameweek:number|null;deadline:string|null;season:string|null;players:Player[]}> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 12000)
    try {
      const response = await fetch('/api/client-catalog?fixtureHorizon=5', { signal: controller.signal })
      if (response.ok) {
        const catalogue = await response.json() as ClientCatalogResponse
        const players = catalogue.players.map(player => ({
          ...player,
          colour: player.colour || getTeamColor(player.club),
          expectedMinutes: player.expectedMinutes ?? Math.min(90, 90 * (player.minutes / 100)),
          dataConfidence: player.dataConfidence ?? player.roleProfile?.confidence ?? 'MEDIUM',
        }))
        return { capturedAt: catalogue.capturedAt, currentGameweek: catalogue.currentGameweek, deadline: catalogue.deadline, season: catalogue.season || catalogue.currentSeason || null, players }
      }
      lastError = new Error(`Live FPL data unavailable: ${response.status}`)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('Fetch failed')
    } finally {
      window.clearTimeout(timeoutId)
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  throw lastError || new Error('Live FPL data unavailable')
}

export type ForecastSummary = {
  id: string; modelVersion: string; asOf: string; createdAt: string; horizon: number; gameweeks: number[];
  players: Array<{ playerId: number; meanPoints: number; standardDeviation: number; p10Points: number; p50Points: number; p90Points: number; fixtureCount: number }>;
  quality: { fallbackFixtureRatio: number; lowMinutesFixtureRatio: number; underlyingPlayerRatio: number; marketFixtureRatio: number };
}

export async function fetchLatestForecast(horizon: 1 | 3 | 5): Promise<ForecastSummary | null> {
  const response = await fetch(`/api/forecast-runs/latest?horizon=${horizon}`)
  if (response.status === 404) return null
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(apiErrorMessage(data, `Forecast unavailable: HTTP ${response.status}`))
  return data.forecast as ForecastSummary
}

export async function fetchBacktest(modelVersion?: string): Promise<any> {
  const query = modelVersion ? `?modelVersion=${encodeURIComponent(modelVersion)}` : ''
  const response = await fetch(`/api/backtests${query}`)
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(apiErrorMessage(data, `Backtest unavailable: HTTP ${response.status}`))
  return data
}

export async function fetchDecisionHistory(limit = 50): Promise<any[]> {
  const response = await fetch(`/api/decisions?limit=${encodeURIComponent(String(limit))}`)
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(apiErrorMessage(data, `Decision history unavailable: HTTP ${response.status}`))
  return data.decisions || []
}

export type CanonicalRecommendationCandidate = { id: string; rank: number; action: string; apiMoves: Array<{ outId: number; inId: number }>; netExpectedGain: number; rawGain: number; hitCost: number; uncertaintyPenalty: number; probabilityBeatsRoll: number | null; affordabilityStatus: string; bankAfterTenths: number | null; p10Points: number | null; p50Points: number | null; p90Points: number | null; leagueDifferential?: number | null; chip?: string; chipReason?: string };

export type CanonicalRecommendation = {
  id: string; planId: string; forecastRunId: string; horizon: number; status: string; primaryCandidateId: string; cacheStatus: 'HIT' | 'MISS';
  league?: { leagueId: number; leagueName: string | null; coverageByFplId?: Record<string, number> } | null;
  candidates: CanonicalRecommendationCandidate[];
}

export async function createPlanRecommendation(planId: string, options: { horizon: 1 | 3 | 5; maxTransfers?: number; chip?: 'TRIPLE_CAPTAIN' | 'BENCH_BOOST' | 'FREE_HIT' | 'WILDCARD' | null }): Promise<CanonicalRecommendation> {
  const response = await fetch(`/api/plans/${encodeURIComponent(planId)}/recommendations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ horizon: options.horizon, maxTransfers: options.maxTransfers ?? 5, chip: options.chip || null }) })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(apiErrorMessage(data, `Recommendation unavailable: HTTP ${response.status}`))
  return data as CanonicalRecommendation
}

export async function recordRecommendationDecision(input: { recommendationSetId: string; candidateId?: string | null; decision: 'ACCEPTED' | 'REJECTED' | 'IGNORED' | 'CUSTOM'; selectedPlanId?: string | null; reason?: string | null }) {
  const response = await fetch('/api/decisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(apiErrorMessage(data, `Decision could not be recorded: HTTP ${response.status}`))
  return data
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
      return { answer: null, provider: config?.provider || 'API Error', error: apiErrorMessage(data, `HTTP ${response.status} error`) }
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
  if (!response.ok) throw new Error(apiErrorMessage(data, `Squad challenge failed: HTTP ${response.status}`))
  // Backward-compatible with a server that still returns the completed result.
  if (!data?.jobId) return data as SquadChallengeResult
  const pollDeadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < pollDeadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 2500))
    const pollResponse = await fetch(`/api/challenge-squad/${encodeURIComponent(data.jobId)}`)
    const poll = await pollResponse.json().catch(() => null)
    if (!pollResponse.ok) throw new Error(apiErrorMessage(poll, `Unable to check research status: HTTP ${pollResponse.status}`))
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
  if (!response.ok) throw new Error(apiErrorMessage(data, `Could not update evidence: HTTP ${response.status}`))
  return (data.signal || data) as PlayerSignal
}

export async function updatePlayerSignalStatusesBatch(
  updates: Array<{ id: string | number; status: 'VERIFIED' | 'REJECTED' }>,
): Promise<PlayerSignal[]> {
  if (!updates.length) return []
  try {
    const response = await fetch('/api/player-signals/batch-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ updates }),
    })
    if (response.ok) {
      const data = await response.json().catch(() => null)
      if (Array.isArray(data?.signals)) return data.signals as PlayerSignal[]
    }
    // A validation/data error from the current endpoint should reach the UI.
    // Only fall back when the endpoint itself is unavailable on an older server.
    if (response.status !== 404 && response.status !== 405) {
      const data = await response.clone().json().catch(() => null)
      throw new Error(apiErrorMessage(data, `Could not apply evidence changes: HTTP ${response.status}`))
    }
  } catch (error) {
    if (error instanceof Error && error.name !== 'TypeError') throw error
  }

  // Fallback to sequential/parallel individual updates if batch endpoint fails or server is older build
  const results = await Promise.all(
    updates.map((item) => updatePlayerSignalStatus(String(item.id), item.status)),
  )
  return results
}

export async function revisePlayerSignalInterpretation(
  signalId: string | number,
  input: {
    claimClass?: PlayerSignal['claimClass'];
    modelImpact?: 'ROLE' | 'NONE';
    value?: PlayerSignal['value'];
    rationale?: string;
    confidence?: number;
    finalizeContext?: boolean;
  },
): Promise<PlayerSignal> {
  const response = await fetch(`/api/player-signals/${encodeURIComponent(String(signalId))}/interpretation`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(apiErrorMessage(data, `Could not revise interpretation: HTTP ${response.status}`))
  return (data.signal || data) as PlayerSignal
}

export type ManualPlayerSignalInput = {
  kind: PlayerSignal['kind'];
  value: PlayerSignal['value'];
  evidenceSummary: string;
  claimClass?: PlayerSignal['claimClass'];
  validUntil?: string;
};

export async function createManualPlayerSignal(
  playerId: number,
  input: ManualPlayerSignalInput,
): Promise<PlayerSignal> {
  const response = await fetch('/api/player-signals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      kind: input.kind,
      manualOverride: true,
      evidenceSummary: input.evidenceSummary,
      value: input.value,
      claimClass: input.claimClass,
      validUntil: input.validUntil,
    }),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(apiErrorMessage(data, `Could not create manual override: HTTP ${response.status}`))
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

export async function fetchTeamMarketSnapshots(limit = 12): Promise<TeamMarketSnapshot[]> {
  try {
    const response = await fetch(`/api/team-market-snapshots?limit=${encodeURIComponent(String(limit))}`)
    if (!response.ok) return []
    const data = await response.json().catch(() => null)
    return (data?.snapshots || []) as TeamMarketSnapshot[]
  } catch {
    return []
  }
}

export async function ingestSignalText(payload: {
  text: string;
  sourceUrl?: string;
  playerHints?: string[];
  gameweek?: number;
}): Promise<{ created: number; signals: PlayerSignal[] }> {
  const response = await fetch('/api/signals/manual', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(apiErrorMessage(data, `Ingest failed: HTTP ${response.status}`))
  return data as { created: number; signals: PlayerSignal[] }
}

export type CreatorClaimCandidate = {
  playerId: number;
  name: string;
  club: string;
  position: string;
  price: number;
  confidence: number;
  reasons: string[];
};

export type CreatorClaim = {
  id: string;
  rawPlayerName: string;
  clubHint?: string | null;
  positionHint?: string | null;
  category: string;
  sentiment: string;
  summary: string;
  matchStatus: 'MATCHED' | 'AMBIGUOUS' | 'UNRESOLVED' | 'DISMISSED';
  matchConfidence: number;
  matchCandidates: CreatorClaimCandidate[];
  creator: string;
  contentTitle: string;
  contentUrl: string;
  timestampSeconds?: number | null;
  signalId?: string | number | null;
};

export async function fetchCreatorClaims(): Promise<CreatorClaim[]> {
  const response=await fetch('/api/creator-claims?limit=200')
  const data=await response.json().catch(()=>null)
  if(!response.ok)throw new Error(data?.error||`Could not load creator claims: HTTP ${response.status}`)
  return (data?.claims||[]) as CreatorClaim[]
}

export async function resolveCreatorClaim(claimId:string,playerId:number,rememberAlias=true){
  const response=await fetch(`/api/creator-claims/${encodeURIComponent(claimId)}`,{
    method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({playerId,rememberAlias}),
  })
  const data=await response.json().catch(()=>null)
  if(!response.ok)throw new Error(data?.error||`Could not resolve creator claim: HTTP ${response.status}`)
  return data
}

export async function dismissCreatorClaim(claimId:string){
  const response=await fetch(`/api/creator-claims/${encodeURIComponent(claimId)}`,{
    method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({dismiss:true}),
  })
  const data=await response.json().catch(()=>null)
  if(!response.ok)throw new Error(data?.error||`Could not dismiss creator claim: HTTP ${response.status}`)
  return data
}

export async function fetchLeagueDetails(leagueId: number, gameweek?: number, youEntry?: number): Promise<LeagueDetailsResponse> {
  const params = new URLSearchParams({ leagueId: String(leagueId) })
  if (gameweek) params.set('gameweek', String(gameweek))
  if (youEntry) params.set('youEntry', String(youEntry))
  const res = await fetch(`/api/fpl-league-details?${params.toString()}`)
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
  reachable?: boolean;
  status: 'initializing' | 'seeding' | 'ready' | 'error';
  isSeeding: boolean;
  isIngesting?: boolean;
  isRecalculating?: boolean;
  recomputeMessage?: string | null;
  recomputeError?: string | null;
  lastForecastRunId?: string | null;
  message: string;
  playerCount: number;
  lastIngestedAt?: string | null;
  nextIngestAt?: string | null;
  ingestIntervalHours?: number;
};

export async function fetchSystemStatus(): Promise<SystemStatus> {
  try {
    const res = await fetch('/api/system-status')
    if (!res.ok) return { reachable: false, status: 'error', isSeeding: false, isIngesting: false, isRecalculating: false, message: `Status unavailable: HTTP ${res.status}`, playerCount: 0 }
    return { ...(await res.json()), reachable: true }
  } catch {
    return { reachable: false, status: 'error', isSeeding: false, isIngesting: false, isRecalculating: false, message: 'Server status unavailable', playerCount: 0 }
  }
}

export type ForecastRecomputeResult = { status: 'blocked' | 'queued' | 'started'; message?: string };

export async function triggerForecastRecompute(): Promise<ForecastRecomputeResult> {
  const response = await fetch('/api/forecast-runs/recompute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error((data?.error) || `Forecast recompute unavailable: HTTP ${response.status}`)
  return data as ForecastRecomputeResult
}

export type AdminOperation = { id: string; status: 'IDLE' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'; startedAt: string | null; finishedAt: string | null; message: string | null; error: string | null };
export type AdminFeedRun = { id: string; source: string; status: string; startedAt: string; finishedAt: string | null; insertedCount: number; updatedCount: number; unmatchedCount: number; usedCache: boolean; error: string | null };
export type AdminStatus = {
  authenticationRequired: boolean;
  operations: AdminOperation[];
  feedRuns: AdminFeedRun[];
  unresolved: { players: number; fixtures: number };
  manager: { teamId: number; teamName: string; lastSynced: string | null; playerCount: number } | null;
  oddsConfigured: boolean;
  season: string;
};

export async function fetchAdminStatus(): Promise<AdminStatus> {
  const response = await fetch('/api/admin/status')
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error?.message || 'Admin status unavailable')
  return data
}

export async function runAdminOperation(action: string, token = ''): Promise<AdminOperation> {
  const response = await fetch(`/api/admin/actions/${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: '{}',
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error?.message || 'Could not start admin operation')
  return data.operation
}

export type ServerAiConfig = {
  provider?: string;
  configured?: boolean;
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
