import { describe, expect, it } from 'vitest'
import { bestXI, bestXIForGameweek, buildDraftImprovementPlan, buildLegalDefaultSquad, buildLegalRemainingSquad, draftSquadScore, findTransferRoutesToTarget, getSquad, horizonProjection, initialSquadBank, isInitialDraftPeriod, isLegalTransfer, isPlayerInjured, isPlayerFlagged, optimizeInitialSquad, players, transferDecision, transfers, validateInitialSquad, validateSquad, CLUB_FIXTURES, getPlayerUpcomingFixtures, INITIAL_SQUAD_BUDGET, TRANSFER_GAIN_THRESHOLDS, calculateChipImpact, generateSquadExportText, getPlayerFixtureTicker, getDifferentialsAndEnablers, getCaptaincyBreakdown, calculateRivalEO } from './domain'
import { createToolContext, getBestTransfers, simulateTransfers } from './intelligence'
import { allocateBonusPoints, scorePlayerMatch } from './model'
import { evaluateCalibration } from './backtest'
import { buildExplanationContext, resolvePlayerMention, resolveMultiplePlayerMentions } from './integrations'
import { expectedRoleMinutes, resolvePlayerRole, type PlayerRoleProfile, type PlayerSignal } from './player-signals'

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
    expect(context).not.toHaveProperty('catalog')
    expect(JSON.stringify(context).length).toBeLessThan(6000)
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
  it('produces bounded position calibration factors',()=>{
    const rows=Array.from({length:20},()=>({position:'MID' as const,expectedPoints:4,actualPoints:8}))
    expect(evaluateCalibration(rows).find(row=>row.position==='MID')?.factor).toBe(1.25)
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

  it('beats greedy autocomplete using the lineup-aware objective',()=>{
    const greedy=buildLegalDefaultSquad(players,100)
    const optimized=optimizeInitialSquad(players,{horizon:5})
    expect(draftSquadScore(5,optimized).total).toBeGreaterThanOrEqual(draftSquadScore(5,greedy).total)
    const score=draftSquadScore(5,optimized)
    expect(score.captain).toBeGreaterThan(0)
    expect(score.bench).toBeGreaterThan(0)
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
    const chips = calculateChipImpact(squad, 5)
    expect(chips.length).toBe(4)
    const tc = chips.find(c => c.chip === 'TC')
    const bb = chips.find(c => c.chip === 'BB')
    expect(tc?.projectedGain).toBeGreaterThan(0)
    expect(bb?.projectedGain).toBeGreaterThan(0)
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
})
