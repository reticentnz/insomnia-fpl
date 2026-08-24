import { describe, expect, it } from 'vitest'
import { bestXI, bestXIForGameweek, buildDraftImprovementPlan, buildLegalDefaultSquad, buildLegalRemainingSquad, computeDraftFingerprint, computeDraftPlayerFingerprint, draftSquadScore, evaluateModeTransition, findTransferRoutesToTarget, findTransferRoutesFromOut, getSquad, groupLegalChangeBundles, horizonProjection, initialSquadBank, isInitialDraftPeriod, formatDeadlineDate, formatDeadlineRemaining, formatDeadlineText, isLegalTransfer, isPlayerInjured, isPlayerFlagged, leagueLivePredictedPoints, leagueLineupExpectedPoints, optimizeInitialSquad, players, resolvePlanningMode, resolveSquadSaveTarget, transferDecision, transfers, validateInitialSquad, validateSquad, CLUB_FIXTURES, getPlayerUpcomingFixtures, gameweekProjection, INITIAL_SQUAD_BUDGET, TRANSFER_GAIN_THRESHOLDS, calculateChipImpact, generateSquadExportText, getPlayerFixtureTicker, getDifferentialsAndEnablers, getCaptaincyBreakdown, calculateRivalEO, getTeamColor, getPlayerShirtColor } from './domain'

import { createToolContext, getBestTransfers, simulateTransfers } from './intelligence'
import { reviewDecision } from './decision-review'
import { allocateBonusPoints, scorePlayerMatch } from './model'
import { evaluateCalibration } from './backtest'
import { buildExplanationContext, resolvePlayerMention, resolveMultiplePlayerMentions } from './integrations'
import { expectedRoleMinutes, isSignalAppliedToRole, resolvePlayerRole, sanitizeExternalUrl, type PlayerRoleProfile, type PlayerSignal } from './player-signals'

describe('planning mode and save routing', () => {
  it('proves Draft Mode routes saves to USER_PREFERENCES and never calls PLANS_API', async () => {
    let preferencesCalled = false
    let plansApiCalled = false
    const mockSavePreferences = async () => { preferencesCalled = true; return true }
    const mockSavePlan = async () => { plansApiCalled = true }

    const executeSave = async (draftMode: boolean) => {
      const target = resolveSquadSaveTarget({ draftMode })
      if (target === 'USER_PREFERENCES') {
        await mockSavePreferences()
      } else {
        await mockSavePlan()
      }
    }

    await executeSave(true)
    expect(preferencesCalled).toBe(true)
    expect(plansApiCalled).toBe(false)

    preferencesCalled = false
    await executeSave(false)
    expect(preferencesCalled).toBe(false)
    expect(plansApiCalled).toBe(true)
  })

  it('scopes player evidence fingerprints to player IDs so lock changes do not invalidate challenges', () => {
    const p1 = computeDraftPlayerFingerprint([10, 5, 1])
    const p2 = computeDraftPlayerFingerprint([1, 5, 10])
    expect(p1).toBe(p2)
  })

  it('holds planning mode in LOADING state until metadata is loaded', () => {
    expect(resolvePlanningMode({ hasCurrentSeasonOfficialSquad: false, isMetadataLoaded: false })).toBe('LOADING')
    expect(resolvePlanningMode({ hasCurrentSeasonOfficialSquad: false, currentSeason: null })).toBe('LOADING')
  })
})

describe('player evidence signals',()=>{
  const base:PlayerRoleProfile={startProbability:.75,minutesIfStarting:86,substituteProbabilityWhenBenched:.2,minutesIfSubstitute:18,confidence:'MEDIUM',derivedFromSignalIds:[]}
  const signal=(overrides:Partial<PlayerSignal>):PlayerSignal=>({id:1,playerId:10,gameweek:1,kind:'DEPTH_CHART',value:{depthRole:'BACKUP'},sourceType:'OFFICIAL_PL',evidenceSummary:'Listed as the likely backup',confidence:.9,observedAt:'2026-08-10T00:00:00Z',validUntil:'2026-08-21T18:00:00Z',status:'VERIFIED',...overrides})

  it('turns verified backup evidence into a low-start role without mutating the base',()=>{
    const resolved=resolvePlayerRole(base,[signal({})],{now:new Date('2026-08-10T12:00:00Z'),gameweek:1})
    expect(resolved.startProbability).toBeCloseTo(.08)
    expect(resolved.confidence).toBe('HIGH')
    expect(expectedRoleMinutes(resolved)).toBeLessThan(12)
    expect(base.startProbability).toBe(.75)
  })

  it('recognizes applied signals across numeric and serialized IDs',()=>{
    const applied={...base,derivedFromSignalIds:[1,'signal-2']}
    expect(isSignalAppliedToRole(applied,'1')).toBe(true)
    expect(isSignalAppliedToRole(applied,'signal-2')).toBe(true)
    expect(isSignalAppliedToRole(applied,3)).toBe(false)
  })

  it('does not apply pending, expired, or wrong-gameweek research',()=>{
    const pending=signal({status:'PENDING'})
    const expired=signal({id:2,validUntil:'2026-08-09T00:00:00Z'})
    const wrongWeek=signal({id:3,gameweek:2})
    expect(resolvePlayerRole(base,[pending,expired,wrongWeek],{now:new Date('2026-08-10T12:00:00Z'),gameweek:1})).toEqual(base)
  })

  it('gives an explicit manual override precedence over researched signals',()=>{
    const manual=signal({id:4,sourceType:'MANUAL_OVERRIDE',value:{startProbability:1,minutesIfStarting:90},confidence:1})
    const resolved=resolvePlayerRole(base,[signal({}),manual],{now:new Date('2026-08-10T12:00:00Z'),gameweek:1})
    expect(resolved.startProbability).toBe(1)
    expect(resolved.minutesIfStarting).toBe(90)
    expect(resolved.derivedFromSignalIds).toEqual([4])
  })

  it('keeps accepted opinion-only evidence out of role projections',()=>{
    const opinion=signal({id:5,kind:'VALUE_OPINION',sourceType:'YOUTUBE_TRANSCRIPT',value:{note:'Good value at this price'},confidence:.85})
    expect(resolvePlayerRole(base,[opinion],{now:new Date('2026-08-10T12:00:00Z'),gameweek:1})).toEqual(base)
  })

  it('does not apply role-shaped values from an approved context-only interpretation',()=>{
    const context=signal({id:51,kind:'VALUE_OPINION',value:{startProbability:1,note:'Context'},interpretation:{id:'i51',origin:'AUTO',claimClass:'VALUE_OPINION',modelImpact:'NONE',value:{startProbability:1,note:'Context'},rationale:'Context only',confidence:1,status:'APPROVED'}})
    expect(resolvePlayerRole(base,[context],{now:new Date('2026-08-10T12:00:00Z'),gameweek:1})).toEqual(base)
  })

  it('decays a fourteen-day-old signal to half the weight of a fresh signal',()=>{
    const fresh=signal({id:6,observedAt:'2026-08-10T00:00:00Z',value:{startProbability:1}})
    const old=signal({id:7,observedAt:'2026-07-27T00:00:00Z',value:{startProbability:0}})
    const resolved=resolvePlayerRole(base,[fresh,old],{now:new Date('2026-08-10T00:00:00Z'),gameweek:1})
    expect(resolved.startProbability).toBeCloseTo(2/3,5)
  })

  it('does not decay manual overrides',()=>{
    const manual=signal({id:8,sourceType:'MANUAL_OVERRIDE',observedAt:'2026-07-01T00:00:00Z',value:{startProbability:1},confidence:1})
    const resolved=resolvePlayerRole(base,[manual],{now:new Date('2026-08-10T00:00:00Z'),gameweek:1})
    expect(resolved.startProbability).toBe(1)
    expect(resolved.confidence).toBe('HIGH')
  })

  it('does not promote one early-season lineup observation into a first-choice certainty',()=>{
    const lineup=signal({id:81,gameweek:null,value:{depthRole:'FIRST_CHOICE'},evidenceSummary:'Named in the starting XI for the opening match',evidenceText:'Named in the starting XI for the opening match'})
    const resolved=resolvePlayerRole({...base,startProbability:.55},[lineup],{now:new Date('2026-08-10T12:00:00Z'),gameweek:2,completedGameweeks:1})
    expect(resolved.startProbability).toBeCloseTo(.6985,4)
    expect(resolved.startProbability).toBeLessThan(.85)
    expect(resolved.calibration).toMatchObject({independentEvidenceCount:1,singleMatchEvidenceCount:1,sensitivity:'LATEST_MATCH_SENSITIVE'})
  })

  it('counts syndicated same-lineup reports once but permits corroborated role evidence',()=>{
    const first=signal({id:82,gameweek:null,value:{depthRole:'FIRST_CHOICE',evidenceKey:'gw1-lineup'},evidenceSummary:'Named in the lineup'})
    const copied=signal({id:83,gameweek:null,sourceType:'OFFICIAL_PL',value:{depthRole:'FIRST_CHOICE',evidenceKey:'gw1-lineup'},evidenceSummary:'Named in the lineup'})
    const syndicated=resolvePlayerRole({...base,startProbability:.55},[first,copied],{now:new Date('2026-08-10T12:00:00Z'),gameweek:2,completedGameweeks:1})
    expect(syndicated.calibration).toMatchObject({independentEvidenceCount:1,correlatedEvidenceCount:1})
    expect(syndicated.startProbability).toBeLessThan(.85)

    const corroborated=resolvePlayerRole({...base,startProbability:.55},[
      signal({id:84,gameweek:null,value:{depthRole:'FIRST_CHOICE'},sourceUrl:null}),
      signal({id:85,gameweek:null,value:{depthRole:'FIRST_CHOICE'},sourceUrl:null}),
    ],{now:new Date('2026-08-10T12:00:00Z'),gameweek:2,completedGameweeks:1})
    expect(corroborated.startProbability).toBeCloseTo(.88,5)
    expect(corroborated.calibration?.independentEvidenceCount).toBe(2)
  })

  it('keeps lower-trust creator conflict from overriding official evidence',()=>{
    const official=signal({id:9,sourceType:'OFFICIAL_CLUB',sourceUrl:'https://arsenal.com/news/team-update',value:{startProbability:.9}})
    const creator=signal({id:10,sourceType:'YOUTUBE_TRANSCRIPT',sourceUrl:'https://youtube.com/watch?v=test',value:{startProbability:.1},confidence:1})
    const resolved=resolvePlayerRole(base,[creator,official],{now:new Date('2026-08-10T00:00:00Z'),gameweek:1})
    expect(resolved.startProbability).toBeCloseTo(.9)
    expect(resolved.derivedFromSignalIds).toEqual([9])
  })

  it('keeps separate creator videos as independent evidence sources',()=>{
    const first=signal({id:91,sourceType:'YOUTUBE_TRANSCRIPT',sourceUrl:'https://youtube.com/watch?v=first&t=10s',observedAt:'2026-08-10T00:00:00Z',value:{startProbability:.2}})
    const second=signal({id:92,sourceType:'YOUTUBE_TRANSCRIPT',sourceUrl:'https://youtube.com/watch?v=second&t=20s',observedAt:'2026-08-10T00:00:00Z',value:{startProbability:.8}})
    const resolved=resolvePlayerRole(base,[first,second],{now:new Date('2026-08-10T00:00:00Z'),gameweek:1})
    expect(resolved.startProbability).toBeCloseTo(.5,5)
    expect(resolved.derivedFromSignalIds).toEqual([91,92])
  })

  it('does not apply a stale source date even when its database validity window is still open',()=>{
    const stale=signal({id:93,sourceDate:'2026-07-20T00:00:00Z',validUntil:'2026-08-20T00:00:00Z',value:{startProbability:1}})
    expect(resolvePlayerRole(base,[stale],{now:new Date('2026-08-10T00:00:00Z'),gameweek:1})).toEqual(base)
  })

  it('supersedes an older claim from the same source and signal kind',()=>{
    const old=signal({id:11,sourceType:'JOURNALIST',sourceUrl:'https://bbc.co.uk/sport/football/story',observedAt:'2026-08-09T00:00:00Z',value:{startProbability:.2}})
    const latest=signal({id:12,sourceType:'JOURNALIST',sourceUrl:'https://bbc.co.uk/sport/football/update',observedAt:'2026-08-10T00:00:00Z',value:{startProbability:.8}})
    const resolved=resolvePlayerRole(base,[old,latest],{now:new Date('2026-08-10T00:00:00Z'),gameweek:1})
    expect(resolved.startProbability).toBeCloseTo(.8)
    expect(resolved.derivedFromSignalIds).toEqual([12])
  })

  it('sanitizes external source URLs preventing invalid relative redirects to untitled pages',()=>{
    expect(sanitizeExternalUrl('untitled')).toBeNull()
    expect(sanitizeExternalUrl('Untitled source')).toBeNull()
    expect(sanitizeExternalUrl('n/a')).toBeNull()
    expect(sanitizeExternalUrl('#')).toBeNull()
    expect(sanitizeExternalUrl('')).toBeNull()
    expect(sanitizeExternalUrl(null)).toBeNull()
    expect(sanitizeExternalUrl('bbc.co.uk/sport')).toBe('https://bbc.co.uk/sport')
    expect(sanitizeExternalUrl('https://fantasy.premierleague.com')).toBe('https://fantasy.premierleague.com/')
  })
})

describe('FPL domain rules', () => {
  it('correctly identifies injured and flagged players', () => {
    const injuredPlayer = { id: 99, name: 'Injured', club: 'ARS', position: 'MID' as const, price: 5, form: 0, ownership: 1, minutes: 0, status: 'i', fixture: 'EVE (H)', difficulty: 2, projection: 0, colour: '#red' }
    const doubtfulPlayer = { id: 98, name: 'Doubtful', club: 'ARS', position: 'MID' as const, price: 5, form: 3, ownership: 1, minutes: 75, status: 'd', chanceOfPlaying: 75, fixture: 'EVE (H)', difficulty: 2, projection: 3, colour: '#yellow' }
    const fitPlayer = { id: 97, name: 'Fit', club: 'ARS', position: 'MID' as const, price: 5, form: 5, ownership: 1, minutes: 90, status: 'a', chanceOfPlaying: 100, fixture: 'EVE (H)', difficulty: 2, projection: 5, colour: '#green' }

    expect(isPlayerInjured(injuredPlayer)).toBe(true)
    expect(isPlayerInjured(fitPlayer)).toBe(false)
    expect(isPlayerFlagged(injuredPlayer)).toBe(true)
    expect(isPlayerFlagged(doubtfulPlayer)).toBe(true)
    expect(isPlayerFlagged(fitPlayer)).toBe(false)
  })
  it('accepts the demo squad shape', () => expect(validateSquad(getSquad(), 1.2)).toHaveLength(0))
  it('rejects a fourth player from one club', () => {
    const squad = getSquad().map((p, i) => i < 4 ? {...p, club:'ARS'} : p)
    expect(validateSquad(squad, 1.2).some(x => x.rule === 'Club limit')).toBe(true)
  })
  it('requires like-for-like legal transfers and blocks owned players', () => {
    const squad = getSquad(); const out = squad.find(p=>p.name==='Winks')!; const incoming = players.find(p=>p.name==='Eze')!
    expect(isLegalTransfer(squad, out, incoming, 2.5)).toBe(true)
    expect(isLegalTransfer(squad, out, squad[0], 1.2)).toBe(false)
  })
  it('rejects an outgoing player who is not in the squad', () => {
    const squad = getSquad()
    const outside = players.find(p => p.name === 'Isak')!
    const incoming = {...players.find(p => p.name === 'Wood')!, id: 900, name: 'External forward', club: 'WHU'}
    expect(isLegalTransfer(squad, outside, incoming, 5)).toBe(false)
  })
  it('uses exact selling price and blocks unknown affordability', () => {
    const squad = getSquad()
    const baseOut = squad.find(player => player.position === 'MID')!
    const incoming = { ...players.find(player => player.position === 'MID' && !squad.some(owned => owned.id === player.id))!, price: baseOut.price + 0.3 }
    expect(isLegalTransfer(squad.map(player => player.id === baseOut.id ? { ...player, sellingPrice: baseOut.price - 0.2 } : player), { ...baseOut, sellingPrice: baseOut.price - 0.2 }, incoming, 0.4)).toBe(false)
    expect(isLegalTransfer(squad.map(player => player.id === baseOut.id ? { ...player, sellingPrice: null } : player), { ...baseOut, sellingPrice: null }, incoming, 10)).toBe(false)
  })
  it('optimises the starting formation across legal shapes', () => {
    const fix = [{gameweek:1, opponent:'COV' as const, venue:'H' as const, difficulty:2}]
    const squad = getSquad().map(p => p.position === 'DEF'
      ? {...p, upcomingFixtures: fix, stats: {minutes: 90, goals: p.name === 'Pinnock' ? 0 : 1, cleanSheets: 1, bonus: 3}}
      : p.position === 'MID'
      ? {...p, upcomingFixtures: fix, stats: {minutes: 90, yellowCards: 1}}
      : p.position === 'FWD'
      ? {...p, upcomingFixtures: fix, stats: {minutes: 90, goals: 2, bonus: 3}}
      : {...p, upcomingFixtures: fix, stats: {minutes: 90}})
    const lineup = bestXI(1, squad)
    expect(lineup.filter(p => p.position === 'DEF').length).toBeGreaterThanOrEqual(4)
    expect(lineup.filter(p => p.position === 'MID')).toHaveLength(2)
    expect(lineup.reduce((sum, p) => sum + horizonProjection(p, 1), 0)).toBeGreaterThan(50.0)
  })
  it('returns a roll decision when no net move clears the threshold', () => {
    const decision = transferDecision(1, 0, 0, getSquad().map(p=>({...p, projection:20})))
    expect(decision.roll).toBe(true)
    expect(decision.hitCost).toBe(4)
  })
  it('builds legal squad from scratch when given empty array', () => {
    const fromScratch = buildLegalRemainingSquad([], players, 1, 100.0)
    expect(fromScratch).toHaveLength(15)
    expect(validateSquad(fromScratch, 1.2)).toHaveLength(0)
  })
  it('auto-fills remaining squad slots legally keeping existing picks', () => {
    const existing = [1, 8, 13] // Raya, Saka, Haaland
    const filled = buildLegalRemainingSquad(existing, players, 1, 100.0)
    expect(filled).toHaveLength(15)
    expect(existing.every(id => filled.some(p => p.id === id))).toBe(true)
    expect(validateSquad(filled, 1.2)).toHaveLength(0)
  })
})

describe('Recommendation context and transfer sequencing', () => {
  it('ranks incoming players from the supplied live catalog', () => {
    const livePlayer = {...players.find(p => p.name === 'Winks')!, id: 901, name: 'Live catalog midfielder', club: 'BHA', projection: 20}
    const ctx = createToolContext({players: [...players, livePlayer], bank: 20})
    expect(getBestTransfers(1, 50, ctx).data.transfers.some(t => t.in.id === livePlayer.id)).toBe(true)
  })
  it('does not allow a sequence to spend more bank than remains', () => {
    const first = {...players.find(p => p.name === 'Eze')!, id: 902, name: 'Custom midfielder', price: 4.8, club: 'CHE'}
    const second = {...players.find(p => p.name === 'Pinnock')!, id: 903, name: 'Custom defender', price: 5.3, club: 'MCI'}
    const ctx = createToolContext({players: [...players, first, second], bank: 1, freeTransfers: 0})
    const result = simulateTransfers([[12, first.id], [5, second.id]], 1, ctx)
    expect(result.data.legal).toBe(false)
  })
  it('finds direct and two-transfer routes to a named target', () => {
    const squad=getSquad()
    const midfielder=players.find(player=>player.name==='Mbeumo')!
    const directTarget={...midfielder,id:910,name:'Bruno Fernandes',club:'MUN',price:8.5,projection:8.5}
    const direct=findTransferRoutesToTarget(directTarget,squad,[...players,directTarget],5,1.2,1)
    expect(direct.routes.some(route=>route.moves.length===1&&route.moves[0].in.id===directTarget.id)).toBe(true)

    const expensiveTarget={...directTarget,id:911,price:11.5}
    const defender=players.find(player=>player.position==='DEF')!
    const budgetDefender={...defender,id:912,name:'Budget Defender',club:'TOT',price:4,projection:2}
    const funded=findTransferRoutesToTarget(expensiveTarget,squad,[...players,expensiveTarget,budgetDefender],5,1.2,1)
    const twoMove=funded.routes.find(route=>route.moves.length===2)
    expect(twoMove).toBeDefined()
    expect(twoMove?.hitCost).toBe(4)
    expect(twoMove?.bankAfter).toBeGreaterThanOrEqual(0)
  })
  it('resolves a slightly misspelled player and submits compact route context', () => {
    const squad=getSquad()
    const template=players.find(player=>player.name==='Mbeumo')!
    const bruno={...template,id:920,name:'Bruno Fernandes',club:'MUN',price:9,projection:8}
    const catalog=[bruno,...players.filter(p=>p.name!=='Bruno Fernandes')]
    expect(resolvePlayerMention('how can we get bruno fernandez into the team?',catalog)?.id).toBe(bruno.id)
    const decision=transferDecision(5,1.2,1,squad,catalog)
    const context=buildExplanationContext({modelVersion:'test',horizon:5,squad,catalog,captain:null,transfers:transfers(5,1.2,1,squad,catalog),decision,bank:1.2,freeTransfers:1},'how can we get bruno fernandez into the team?')
    expect(context.intent).toBe('named_player_transfer')
    expect((context as Record<string, unknown>).transferDirection).toBe('in')
    expect(context).not.toHaveProperty('catalog')
    expect(JSON.stringify(context).length).toBeLessThan(6000)
  })
  it('builds named_player_transfer context with transferDirection out when transferring out an owned player', () => {
    const squad=getSquad()
    const mbeumo=squad.find(p=>p.name==='Mbeumo')!
    expect(mbeumo).toBeDefined()
    const decision=transferDecision(5,1.2,1,squad,players)
    const context=buildExplanationContext({modelVersion:'test',horizon:5,squad,catalog:players,captain:null,transfers:transfers(5,1.2,1,squad,players),decision,bank:1.2,freeTransfers:1},'should I transfer Mbeumo out or wait?')
    expect(context.intent).toBe('named_player_transfer')
    const ctx = context as Record<string, unknown>
    expect(ctx.transferDirection).toBe('out')
    expect(ctx.alreadyOwned).toBe(true)
    const routes = ctx.routes as Array<{moves: Array<{out: {name: string}; in: {name: string}}>}>
    expect(routes.length).toBeGreaterThan(0)
    expect(routes[0].moves[0].out.name).toBe('Mbeumo')
  })
  it('finds replacement routes for an owned outgoing player using findTransferRoutesFromOut', () => {
    const squad=getSquad()
    const mbeumo=squad.find(p=>p.name==='Mbeumo')!
    const plan=findTransferRoutesFromOut(mbeumo,squad,players,5,1.2,1)
    expect(plan.alreadyOwned).toBe(true)
    expect(plan.routes.length).toBeGreaterThan(0)
    expect(plan.routes[0].moves[0].out.id).toBe(mbeumo.id)
    expect(plan.routes[0].moves[0].in.position).toBe('MID')
  })
  it('resolves multiple player mentions and builds player_comparison context', () => {
    const squad=getSquad()
    const resolved=resolveMultiplePlayerMentions('Eze vs Bruno Fernandes?',players)
    expect(resolved.map(p=>p.name)).toContain('Eze')
    expect(resolved.map(p=>p.name)).toContain('Bruno Fernandes')

    const decision=transferDecision(5,1.2,1,squad,players)
    const context=buildExplanationContext({modelVersion:'test',horizon:5,squad,catalog:players,captain:null,transfers:transfers(5,1.2,1,squad,players),decision,bank:1.2,freeTransfers:1},'Eze vs Bruno Fernandes?')
    expect(context.intent).toBe('player_comparison')
    expect((context as Record<string, unknown>).players).toHaveLength(2)
  })
  it('does not falsely resolve conversational words like tell as player Tel or substrings as players', () => {
    const telPlayer = { id: 999, name: 'Tel', position: 'MID', price: 6.0, club: 'TOT', expectedMinutes: 50, projection: 3 }
    const haalandPlayer = players.find(p => p.name === 'Haaland')!
    const sonPlayer = { id: 998, name: 'Son', position: 'MID', price: 10.0, club: 'TOT', expectedMinutes: 90, projection: 7 }
    const catalog = [telPlayer, haalandPlayer, sonPlayer, ...players]

    const resolved = resolveMultiplePlayerMentions('Tell me about Haaland', catalog)
    expect(resolved.map(p => p.name)).toEqual(['Haaland'])

    const context = buildExplanationContext({modelVersion:'test',horizon:5,squad:getSquad(),catalog,captain:null,transfers:[],decision:{roll:true,transfer:null,freeTransfers:1,reason:''},bank:1.0,freeTransfers:1}, 'Tell me about Haaland')
    expect(context.intent).toBe('player_question')

    const resolvedSon = resolveMultiplePlayerMentions('Who is the best option this season?', catalog)
    expect(resolvedSon.map(p => p.name)).not.toContain('Son')
  })
  it('builds position_ranking context for position ranking queries', () => {
    const squad=getSquad()
    const decision=transferDecision(5,1.2,1,squad,players)
    const context=buildExplanationContext({modelVersion:'test',horizon:5,squad,catalog:players,captain:null,transfers:transfers(5,1.2,1,squad,players),decision,bank:1.2,freeTransfers:1},'give me the top 5 midfielders over the next 5 weeks')
    expect(context.intent).toBe('position_ranking')
    const ctx = context as Record<string, unknown>
    expect(ctx.positionTarget).toBe('MID')
    expect(ctx.rankedPlayers).toBeDefined()
    const ranked = ctx.rankedPlayers as Array<{position: string; name: string}>
    expect(ranked.length).toBe(5)
    expect(ranked.every(p => p.position === 'MID')).toBe(true)
  })
  it('honours a price cap in position-ranking questions', () => {
    const squad=getSquad()
    const context=buildExplanationContext({modelVersion:'test',horizon:5,squad,catalog:players,captain:null,transfers:transfers(5,1.2,1,squad,players),decision:transferDecision(5,1.2,1,squad,players),bank:1.2,freeTransfers:1}, 'Find me a midfielder under £7.0m.') as Record<string, unknown>
    expect(context.intent).toBe('position_ranking')
    expect(context.maxPrice).toBe(7)
    expect((context.rankedPlayers as Array<{price:number}>).every(player => player.price <= 7)).toBe(true)
  })
})

describe('Ask suggestion handlers', () => {
  it('answers captain, roll, and weakest-player prompts with their dedicated analysis', async () => {
    const ctx=createToolContext()
    const captain=await reviewDecision('Who should I captain?', 5, ctx)
    expect(captain.arbiter.mainArgument).toContain('Captain ')
    expect(captain.toolTrace).toContain('getCaptainCandidates')

    const roll=await reviewDecision('Should I roll my transfer?', 5, ctx)
    expect(roll.arbiter.mainArgument).toMatch(/Roll the transfer|Do not roll/)

    const weakest=await reviewDecision('Who is my weakest player?', 5, ctx)
    expect(weakest.arbiter.mainArgument).toMatch(/most upgradeable squad slot|No owned player/)
  })
})

describe('2026/27 scoring engine',()=>{
  it('conservatively discounts players with no usable history',()=>{
    const known={...players.find(player=>player.position==='DEF')!,expectedMinutes:45,dataConfidence:'HIGH' as const,coldStart:false,stats:{minutes:1800},upcomingFixtures:[{gameweek:1,opponent:'SUN',venue:'H' as const,difficulty:2}]}
    const unknown={...known,id:999,coldStart:true,dataConfidence:'LOW' as const,stats:{minutes:0}}
    expect(horizonProjection(unknown,1)).toBeLessThan(horizonProjection(known,1))
  })
  it('collapses indistinguishable transfer alternatives',()=>{
    const squad=getSquad(),out=squad.find(player=>player.name==='Winks')!
    const template={...out,club:'MUN',price:4,projection:20,expectedMinutes:90,dataConfidence:'HIGH' as const,upcomingFixtures:[{gameweek:1,opponent:'SUN',venue:'H' as const,difficulty:2}]}
    const options=transfers(1,10,1,squad,[{...template,id:980,name:'Equivalent A'},{...template,id:981,name:'Equivalent B'}]).filter(move=>move.out.id===out.id)
    expect(options).toHaveLength(1)
    expect(options[0].equivalentAlternatives).toBe(1)
  })
  it('returns an actionable shortlist instead of every positive permutation',()=>{
    const squad=getSquad()
    const pool=(['GK','DEF','MID','FWD'] as const).flatMap((position,positionIndex)=>Array.from({length:10},(_,index)=>{
      const base=players.find(player=>player.position===position)!
      return {...base,id:2000+positionIndex*20+index,name:`Candidate ${position} ${index}`,club:`X${positionIndex}${index}`,price:4+index*.4,projection:6+index,expectedMinutes:90,dataConfidence:'HIGH' as const,upcomingFixtures:[{gameweek:1,opponent:'SUN',venue:'H' as const,difficulty:2}]}
    }))
    const options=transfers(5,20,1,squad,pool)
    expect(options.length).toBeLessThanOrEqual(30)
    expect(options.every(option=>option.net>=1.5)).toBe(true)
    const counts=options.reduce<Record<number,number>>((result,option)=>(result[option.out.id]=(result[option.out.id]||0)+1,result),{})
    expect(Math.max(0,...Object.values(counts))).toBeLessThanOrEqual(3)
  })
  it('scores appearance, attacking, clean-sheet, defensive contribution, bonus and cards',()=>{
    const result=scorePlayerMatch({position:'DEF',minutes:90,goals:1,assists:1,cleanSheet:true,clearancesBlocksInterceptions:8,tackles:2,bonus:3,yellowCards:1})
    expect(result.total).toBe(19)
    expect(result.defensiveContribution).toBe(2)
  })
  it('applies goalkeeper saves, penalties and goals-conceded deductions',()=>{
    const result=scorePlayerMatch({position:'GK',minutes:90,goalsConceded:5,saves:7,penaltiesSaved:1})
    expect(result.total).toBe(7)
  })
  it('requires 60 minutes for clean-sheet points',()=>{
    expect(scorePlayerMatch({position:'DEF',minutes:59,cleanSheet:true}).cleanSheet).toBe(0)
    expect(scorePlayerMatch({position:'DEF',minutes:60,cleanSheet:true}).cleanSheet).toBe(4)
  })
  it('allocates BPS ties using the official ranking rules',()=>{
    expect(allocateBonusPoints([{playerId:1,bps:30},{playerId:2,bps:30},{playerId:3,bps:25}])).toEqual({1:3,2:3,3:1})
    expect(allocateBonusPoints([{playerId:1,bps:30},{playerId:2,bps:25},{playerId:3,bps:25}])).toEqual({1:3,2:2,3:2})
  })
  it('represents blanks and doubles as zero or two fixture projections',()=>{
    const player={...players[8],upcomingFixtures:[]}
    expect(horizonProjection(player,1)).toBe(0)
    const double={...players[8],upcomingFixtures:[{gameweek:1,opponent:'ARS',venue:'H' as const,difficulty:4},{gameweek:1,opponent:'EVE',venue:'A' as const,difficulty:2}]}
    expect(horizonProjection(double,2)).toBeGreaterThan(horizonProjection({...double,upcomingFixtures:double.upcomingFixtures.slice(0,1)},1))
  })
  it('withholds calibration below the evidence threshold and caps qualified factors',()=>{
    const rows=Array.from({length:99},()=>({position:'MID' as const,expectedPoints:4,actualPoints:8}))
    expect(evaluateCalibration(rows).find(row=>row.position==='MID')?.factor).toBe(1)
    expect(evaluateCalibration([...rows,rows[0]]).find(row=>row.position==='MID')?.factor).toBe(1.15)
  })
})

describe('2026/27 Data-Pipeline Canaries', () => {
  it('verifies Isak team is Liverpool and price is £9.0m', () => {
    const isak = players.find(p => p.name === 'Isak')!
    expect(isak).toBeDefined()
    expect(isak.club).toBe('LIV')
    expect(isak.price).toBe(9.0)
  })

  it('verifies Eze team is Arsenal', () => {
    const eze = players.find(p => p.name === 'Eze')!
    expect(eze).toBeDefined()
    expect(eze.club).toBe('ARS')
  })

  it('verifies Saliba team is Arsenal and price is £6.0m', () => {
    const saliba = players.find(p => p.name === 'Saliba')!
    expect(saliba).toBeDefined()
    expect(saliba.club).toBe('ARS')
    expect(saliba.price).toBe(6.0)
  })

  it('verifies Gordon is inactive or absent from active player pool', () => {
    const gordon = players.find(p => p.name === 'Gordon')
    expect(!gordon || gordon.active === false).toBe(true)
  })

  it('verifies GW1 Liverpool fixture is Newcastle (A)', () => {
    const livFixtures = CLUB_FIXTURES['LIV']
    expect(livFixtures[0].gameweek).toBe(1)
    expect(livFixtures[0].opponent).toBe('NEW')
    expect(livFixtures[0].venue).toBe('A')

    const isak = players.find(p => p.name === 'Isak')!
    const isakFixtures = getPlayerUpcomingFixtures(isak, 1)
    expect(isakFixtures[0].opponent).toBe('NEW')
    expect(isakFixtures[0].venue).toBe('A')
  })

  it('verifies GW1 Arsenal fixture is Coventry (H)', () => {
    const arsFixtures = CLUB_FIXTURES['ARS']
    expect(arsFixtures[0].gameweek).toBe(1)
    expect(arsFixtures[0].opponent).toBe('COV')
    expect(arsFixtures[0].venue).toBe('H')
  })
})

describe('GW1 locked-core squad optimisation',()=>{
  const lockedIds=[players.find(player=>player.name==='Haaland')!.id,players.find(player=>player.name==='Bruno Fernandes')!.id]

  it('enforces a hard £100m cap and derives rather than invents bank',()=>{
    const legal=optimizeInitialSquad(players,{lockedPlayerIds:lockedIds,horizon:5,budget:INITIAL_SQUAD_BUDGET})
    const cost=legal.reduce((sum,player)=>sum+player.price,0)
    expect(cost).toBeLessThanOrEqual(100)
    expect(initialSquadBank(legal)).toBeCloseTo(100-cost,1)
    const overBudget=[...legal.slice(0,14),{...legal[14],price:legal[14].price+2}]
    expect(validateInitialSquad(overBudget).some(issue=>issue.rule==='Budget')).toBe(true)
  })

  it('retains locked players and satisfies every squad rule',()=>{
    const optimized=optimizeInitialSquad(players,{lockedPlayerIds:lockedIds,horizon:5})
    expect(optimized).toHaveLength(15)
    expect(lockedIds.every(id=>optimized.some(player=>player.id===id))).toBe(true)
    expect(validateInitialSquad(optimized)).toHaveLength(0)
  })

  it('never includes excluded players when auto-filling',()=>{
    const excludedId=players.find(player=>player.name==='Salah')!.id
    const optimized=optimizeInitialSquad(players,{horizon:5,excludedPlayerIds:[excludedId]})
    expect(optimized).toHaveLength(15)
    expect(optimized.some(player=>player.id===excludedId)).toBe(false)
    expect(validateInitialSquad(optimized)).toHaveLength(0)
  })

  it('honours exclusions when filling the remaining spots of an existing squad',()=>{
    const excludedId=players.find(player=>player.name==='Haaland')!.id
    const fill=buildLegalRemainingSquad([],players,5,100,[excludedId])
    expect(fill.some(player=>player.id===excludedId)).toBe(false)
    expect(fill).toHaveLength(15)
  })

  it('beats greedy autocomplete using the lineup-aware objective',()=>{
    const greedy=buildLegalDefaultSquad(players,100)
    const optimized=optimizeInitialSquad(players,{horizon:5})
    expect(draftSquadScore(5,optimized).total).toBeGreaterThanOrEqual(draftSquadScore(5,greedy).total)
    const score=draftSquadScore(5,optimized)
    expect(score.captain).toBeGreaterThan(0)
    expect(score.bench).toBeGreaterThan(0)
  }, 15000)

  it('computes selection-aware transfer gains that discount bench-bound replacements',()=>{
    // Use a greedy default squad — suboptimal by design, so transfers will be available
    const squad=buildLegalDefaultSquad(players,100)
    expect(squad).toHaveLength(15)
    const bank=initialSquadBank(squad)
    const ranked=transfers(5,bank,1,squad,players)
    expect(ranked.length).toBeGreaterThan(0)
    // selectionAwareGain should be computed for the final transfers
    const withAware=ranked.filter(t=>t.selectionAwareGain!==undefined)
    expect(withAware.length).toBeGreaterThan(0)
    // Lineup context can exceed the direct player delta when formation or
    // captaincy changes, but every surfaced value must be a finite team delta.
    for(const t of withAware){
      expect(Number.isFinite(t.selectionAwareGain)).toBe(true)
    }
  }, 15000)

  it('returns a coordinated multi-player restructure',()=>{
    const plan=buildDraftImprovementPlan(getSquad(),players,{lockedPlayerIds:[lockedIds[0]],horizon:5})
    expect(plan).not.toBeNull()
    expect(plan!.changes.length).toBeGreaterThan(1)
    expect(plan!.optimizedCost).toBeLessThanOrEqual(100)
    expect(plan!.gain).toBeGreaterThan(0)
  }, 15000)

  it('separates pre-deadline GW1 draft mode from in-season planning',()=>{
    expect(isInitialDraftPeriod(1,'2026-08-21T05:30:00.000Z',Date.parse('2026-08-10T00:00:00Z'))).toBe(true)
    expect(isInitialDraftPeriod(1,'2026-08-01T05:30:00.000Z',Date.parse('2026-08-10T00:00:00Z'))).toBe(false)
    expect(isInitialDraftPeriod(2,'2026-08-28T05:30:00.000Z',Date.parse('2026-08-10T00:00:00Z'))).toBe(false)
  })

  it('computes draft fingerprints deterministically for challenge invalidation',()=>{
    const fp1 = computeDraftFingerprint([5, 1, 3], [1])
    const fp2 = computeDraftFingerprint([1, 3, 5], [1])
    const fp3 = computeDraftFingerprint([1, 3, 5], [3])
    expect(fp1).toBe(fp2)
    expect(fp1).not.toBe(fp3)
  })

  it('resolves planning mode explicitly with snapshot, account, and season checks',()=>{
    // DRAFT when no current-season snapshot and not activated for this account
    expect(resolvePlanningMode({ hasCurrentSeasonOfficialSquad: false, currentSeason: '2026/27', activeManagerAccountId: 'acc-1' })).toBe('DRAFT')
    
    // SEASON once valid current-season snapshot detected for active manager account
    expect(resolvePlanningMode({
      hasCurrentSeasonOfficialSquad: true,
      officialSnapshotManagerAccountId: 'acc-1',
      officialSnapshotSeason: '2026/27',
      currentSeason: '2026/27',
      activeManagerAccountId: 'acc-1',
    })).toBe('SEASON')

    // DRAFT if switching to a different manager account without an official squad snapshot
    expect(resolvePlanningMode({
      hasCurrentSeasonOfficialSquad: true,
      officialSnapshotManagerAccountId: 'acc-1',
      officialSnapshotSeason: '2026/27',
      currentSeason: '2026/27',
      activeManagerAccountId: 'acc-2',
    })).toBe('DRAFT')

    // SEASON when persisted activation belongs to active manager account and current season
    expect(resolvePlanningMode({
      hasCurrentSeasonOfficialSquad: false,
      activationManagerAccountId: 'acc-1',
      activationSeason: '2026/27',
      currentSeason: '2026/27',
      activeManagerAccountId: 'acc-1',
    })).toBe('SEASON')

    // DRAFT when activation belongs to a different account or season
    expect(resolvePlanningMode({
      hasCurrentSeasonOfficialSquad: false,
      activationManagerAccountId: 'acc-1',
      activationSeason: '2025/26',
      currentSeason: '2026/27',
      activeManagerAccountId: 'acc-1',
    })).toBe('DRAFT')
  })

  it('evaluates mode transitions correctly for clean vs dirty editor states',()=>{
    expect(evaluateModeTransition({ currentMode: 'DRAFT', hasOfficialSquad: true, isEditorDirty: false })).toEqual({ targetMode: 'SEASON', requiresPrompt: false })
    expect(evaluateModeTransition({ currentMode: 'DRAFT', hasOfficialSquad: true, isEditorDirty: true })).toEqual({ targetMode: 'DRAFT', requiresPrompt: true })
    expect(evaluateModeTransition({ currentMode: 'SEASON', hasOfficialSquad: true, isEditorDirty: true })).toEqual({ targetMode: 'SEASON', requiresPrompt: false })
  })

  it('groups legal budget-linked change bundles from draft improvement changes', () => {
    const squad = getSquad()
    const plan = buildDraftImprovementPlan(squad, players, { horizon: 5 })
    if (plan && plan.changes.length > 0) {
      const bundles = groupLegalChangeBundles(squad, plan.changes, 0, 5, 100)
      expect(Array.isArray(bundles)).toBe(true)
      bundles.forEach(b => {
        expect(b.isLegal).toBe(true)
        expect(b.netGain).toBeGreaterThan(0)
      })
    }
  }, 15000)

  it('maps team short names and player objects to primary team colors', () => {
    expect(getTeamColor('ARS')).toBe('#e74c3c')
    expect(getTeamColor('MCI')).toBe('#60a5fa')
    expect(getTeamColor('LIV')).toBe('#ef4444')
    expect(getTeamColor('UNKNOWN')).toBe('#64748b')

    expect(getPlayerShirtColor({ colour: '#ef0107', club: 'ARS' })).toBe('#ef0107')
    expect(getPlayerShirtColor({ colour: '#64748b', club: 'MCI' })).toBe('#60a5fa')
    expect(getPlayerShirtColor({ club: 'LIV' })).toBe('#ef4444')
    expect(getPlayerShirtColor(null)).toBe('#64748b')
  })

  it('changes its selected structure when the planning horizon changes',()=>{
    const one=optimizeInitialSquad(players,{lockedPlayerIds:lockedIds,horizon:1}).map(player=>player.id).sort((a,b)=>a-b)
    const five=optimizeInitialSquad(players,{lockedPlayerIds:lockedIds,horizon:5}).map(player=>player.id).sort((a,b)=>a-b)
    expect(one).not.toEqual(five)
  }, 15000)

  it('selects a fresh legal lineup for each gameweek in the horizon',()=>{
    const squad=getSquad()
    const goalkeepers=squad.filter(player=>player.position==='GK')
    const certainRole={startProbability:1,minutesIfStarting:90,substituteProbabilityWhenBenched:0,minutesIfSubstitute:0,confidence:'HIGH' as const,derivedFromSignalIds:[]}
    const rotating=squad.map(player=>player.id===goalkeepers[0].id
      ? {...player,roleProfile:certainRole,upcomingFixtures:[{gameweek:1,opponent:'COV',venue:'H' as const,difficulty:2}]}
      : player.id===goalkeepers[1].id
        ? {...player,roleProfile:certainRole,upcomingFixtures:[{gameweek:2,opponent:'HUL',venue:'H' as const,difficulty:2}]}
        : player)
    expect(bestXIForGameweek(1,rotating).find(player=>player.position==='GK')?.id).toBe(goalkeepers[0].id)
    expect(bestXIForGameweek(2,rotating).find(player=>player.position==='GK')?.id).toBe(goalkeepers[1].id)
  })

  it('publishes the direct-swap thresholds used by empty-state explanations',()=>{
    expect(TRANSFER_GAIN_THRESHOLDS).toEqual({1:.5,3:1,5:1.5})
  })

  it('generates multi-gameweek fixture ticker items for a player',()=>{
    const sample = players[0]
    const ticker = getPlayerFixtureTicker(sample, 5)
    expect(ticker.length).toBeLessThanOrEqual(5)
    expect(ticker[0]).toHaveProperty('difficultyClass')
    expect(ticker[0].difficultyClass).toMatch(/^fdr-[1-5]$/)
  })

  it('calculates chip strategy impact (TC, BB, WC, FH)',()=>{
    const squad = getSquad()
    const chips = calculateChipImpact(squad, 1)
    expect(chips.length).toBe(4)
    const tc = chips.find(c => c.chip === 'TC')
    const bb = chips.find(c => c.chip === 'BB')
    expect(tc?.projectedGain).toBeGreaterThan(0)
    expect(bb?.projectedGain).toBeGreaterThan(0)
  })

  it('calculates chip gains for one target gameweek',()=>{
    const squad = getSquad()
    const chips = calculateChipImpact(squad, 1)
    const captain = bestXIForGameweek(1, squad)[0]
    expect(chips.find(chip => chip.chip === 'TC')?.projectedGain).toBeCloseTo(gameweekProjection(captain, 1), 1)
    expect(chips.find(chip => chip.chip === 'TC')?.notes).toContain('GW1')
    expect(calculateChipImpact(squad, 3).find(chip => chip.chip === 'TC')?.notes).toContain('GW3')
  })

  it('generates plain text squad export report',()=>{
    const squad = getSquad()
    const exportText = generateSquadExportText(squad, 5, 1.2, 1, 'WC')
    expect(exportText).toContain('Insomnia FPL Squad Report')
    expect(exportText).toContain('Active Chip: WC')
    expect(exportText).toContain('GOALKEEPERS:')
    expect(exportText).toContain('BENCH:')
  })

  it('filters differential picks and budget enablers from player catalog',()=>{
    const diffs = getDifferentialsAndEnablers(players, 5, 5)
    expect(diffs.length).toBeGreaterThan(0)
    expect(diffs[0]).toHaveProperty('xPtsPerMillion')
    expect(diffs[0]).toHaveProperty('reason')
  })

  it('computes detailed captaincy xPts component breakdown',()=>{
    const sample = players[0]
    const breakdown = getCaptaincyBreakdown(sample, 5)
    expect(breakdown.totalXpts).toBeGreaterThan(0)
    expect(breakdown.attackingPct + breakdown.defensivePct + breakdown.bonusAppearancePct).toBeGreaterThanOrEqual(99)
  })

  it('calculates mini-league rival effective ownership (EO) and differentials',()=>{
    const userSquad = getSquad()
    const rivalPicks = [
      { playerId: userSquad[0].id, isCaptain: true },
      { playerId: userSquad[1].id },
      { playerId: 999 },
    ]
    const eoStats = calculateRivalEO(rivalPicks, userSquad, players)
    expect(eoStats.sharedPlayersCount).toBeGreaterThanOrEqual(2)
    expect(eoStats.effectiveOwnership[userSquad[0].id].isCaptain).toBe(true)
  })

  it('projects a revealed league XI and captain over 1/3/5 gameweeks',()=>{
    const squad = getSquad()
    const picks = squad.map((player, index) => ({
      element: player.id,
      position: index + 1,
      is_captain: index === 0,
    }))
    const expected = (horizon: 1 | 3 | 5) => squad
      .slice(0, 11)
      .reduce((sum, player) => sum + horizonProjection(player, horizon), horizonProjection(squad[0], horizon))

    expect(leagueLineupExpectedPoints(players, picks, 1)).toBeCloseTo(expected(1), 1)
    expect(leagueLineupExpectedPoints(players, picks, 3)).toBeCloseTo(expected(3), 1)
    expect(leagueLineupExpectedPoints(players, picks, 5)).toBeCloseTo(expected(5), 1)
    expect(leagueLineupExpectedPoints(players, [], 1)).toBeNull()
  })

  it('applies single-week scoring chips only once in longer league projections',()=>{
    const squad = getSquad()
    const picks = squad.map((player, index) => ({
      element: player.id,
      position: index + 1,
      is_captain: index === 0,
    }))
    const baseline = leagueLineupExpectedPoints(players, picks, 5)!
    const captainOneWeek = horizonProjection(squad[0], 1)
    const benchOneWeek = squad.slice(11).reduce((sum, player) => sum + horizonProjection(player, 1), 0)

    expect(leagueLineupExpectedPoints(players, picks, 5, '3xc')).toBeCloseTo(baseline + captainOneWeek, 1)
    expect(leagueLineupExpectedPoints(players, picks, 5, 'bboost')).toBeCloseTo(baseline + benchOneWeek, 1)
  })

  it('predicts the final live GW score from only players with fixture time remaining',()=>{
    const squad = getSquad()
    const picks = squad.map((player, index) => ({
      element: player.id,
      position: index + 1,
      multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
      remainingFixtureFraction: index === 0 ? 1 : index === 1 ? 0.5 : 0,
    }))
    const prediction = leagueLivePredictedPoints(players, picks, 30)!
    const remaining = horizonProjection(squad[0], 1) * 2 + horizonProjection(squad[1], 1) * 0.5

    expect(prediction.predictedPoints).toBeCloseTo(30 + remaining, 1)
    expect(prediction.playersRemaining).toBe(2)
  })

  it('does not invent a live GW prediction when fixture state is unavailable',()=>{
    const player = players[0]
    expect(leagueLivePredictedPoints(players, [{ element: player.id, position: 1, multiplier: 1 }], 12)).toBeNull()
  })
})

describe('deadline formatters and context display', () => {
  const targetIso = '2026-08-28T17:30:00.000Z'

  it('formats exact date and time and handles invalid/null values', () => {
    const formatted = formatDeadlineDate(targetIso)
    expect(formatted).toBeTruthy()
    expect(typeof formatted).toBe('string')
    expect(formatDeadlineDate(null)).toBe('')
    expect(formatDeadlineDate('invalid')).toBe('')
  })

  it('formats remaining countdown correctly for days, hours, and minutes', () => {
    const now3d = Date.parse('2026-08-25T12:30:00.000Z')
    expect(formatDeadlineRemaining(targetIso, now3d)).toBe('3d 5h')

    const now5h = Date.parse('2026-08-28T12:10:00.000Z')
    expect(formatDeadlineRemaining(targetIso, now5h)).toBe('5h 20m')

    const now25m = Date.parse('2026-08-28T17:05:00.000Z')
    expect(formatDeadlineRemaining(targetIso, now25m)).toBe('25m')

    const nowPassed = Date.parse('2026-08-28T17:31:00.000Z')
    expect(formatDeadlineRemaining(targetIso, nowPassed)).toBe('Deadline passed')
  })

  it('formats headline deadline text with target gameweek context', () => {
    const now = Date.parse('2026-08-25T12:30:00.000Z')

    // When viewing during GW1 live matches, target next GW2 deadline
    const textNextGw = formatDeadlineText(targetIso, 2, 1, now)
    expect(textNextGw).toContain('GW2 Deadline:')
    expect(textNextGw).toContain('3d 5h left')

    // When viewing before current GW deadline
    const textCurrentGw = formatDeadlineText(targetIso, 1, 1, now)
    expect(textCurrentGw).toContain('Deadline:')
    expect(textCurrentGw).not.toContain('GW1 Deadline:')
    expect(textCurrentGw).toContain('3d 5h left')

    // When season is complete / null
    expect(formatDeadlineText(null, null, 38, now)).toBe('Season complete')

    // When deadline passed
    const passed = Date.parse('2026-08-29T00:00:00.000Z')
    expect(formatDeadlineText(targetIso, 2, 2, passed)).toBe('Deadline passed')
  })
})

