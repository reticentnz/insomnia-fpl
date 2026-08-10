const { getSquad, players, validateSquad, validateInitialSquad, initialSquadBank, optimizeInitialSquad, draftSquadScore, buildLegalDefaultSquad, buildDraftImprovementPlan, isInitialDraftPeriod, isLegalTransfer, transferDecision, transfers, findTransferRoutesToTarget, CLUB_FIXTURES } = await import('../src/domain.ts')
const { allocateBonusPoints, scorePlayerMatch } = await import('../src/model.ts')
const { evaluateCalibration } = await import('../src/backtest.ts')
const squad = getSquad()
if (squad.length !== 15) throw new Error('demo squad must contain 15 players')
if (validateSquad(squad, 1.2).length) throw new Error('demo squad must be legal')
const clubViolation = squad.map((player, index) => index < 4 ? { ...player, club: 'ARS' } : player)
if (!validateSquad(clubViolation, 1.2).some(issue => issue.rule === 'Club limit')) throw new Error('club limit is not enforced')
const out = squad.find(player => player.name === 'Winks')
const incoming = players.find(player => player.name === 'Eze')
if (!isLegalTransfer(squad, out, incoming, 2.5)) throw new Error('legal like-for-like transfer was rejected')
if (isLegalTransfer(squad, out, squad[0], 2.5)) throw new Error('owned-player transfer was accepted')
const hitDecision = transferDecision(1, 0, 0, squad.map(player => ({ ...player, projection: 20 })))
if (!hitDecision.roll || hitDecision.hitCost !== 4) throw new Error('hit/roll logic is incorrect')

// 2026/27 Data-Pipeline Canary Checks
const isak = players.find(p => p.name === 'Isak')
if (!isak || isak.club !== 'LIV' || isak.price !== 9.0) throw new Error('Canary failed: Isak must be Liverpool (£9.0m)')
const eze = players.find(p => p.name === 'Eze')
if (!eze || eze.club !== 'ARS') throw new Error('Canary failed: Eze must be Arsenal')
const saliba = players.find(p => p.name === 'Saliba')
if (!saliba || saliba.club !== 'ARS' || saliba.price !== 6.0) throw new Error('Canary failed: Saliba must be Arsenal (£6.0m)')
const gordon = players.find(p => p.name === 'Gordon')
if (gordon && gordon.active !== false) throw new Error('Canary failed: Gordon must be inactive/absent')
const livGw1 = CLUB_FIXTURES['LIV']?.[0]
if (!livGw1 || livGw1.opponent !== 'NEW' || livGw1.venue !== 'A') throw new Error('Canary failed: GW1 Liverpool fixture must be NEW (A)')
const arsGw1 = CLUB_FIXTURES['ARS']?.[0]
if (!arsGw1 || arsGw1.opponent !== 'COV' || arsGw1.venue !== 'H') throw new Error('Canary failed: GW1 Arsenal fixture must be COV (H)')

const defenderHaul=scorePlayerMatch({position:'DEF',minutes:90,goals:1,assists:1,cleanSheet:true,clearancesBlocksInterceptions:8,tackles:2,bonus:3,yellowCards:1})
if(defenderHaul.total!==19||defenderHaul.defensiveContribution!==2)throw new Error('rules-aware defender scoring failed')
const goalkeeperReturn=scorePlayerMatch({position:'GK',minutes:90,goalsConceded:5,saves:7,penaltiesSaved:1})
if(goalkeeperReturn.total!==7)throw new Error('goalkeeper scoring failed')
if(scorePlayerMatch({position:'DEF',minutes:59,cleanSheet:true}).cleanSheet!==0)throw new Error('60-minute clean-sheet threshold failed')
const tiedBonus=allocateBonusPoints([{playerId:1,bps:30},{playerId:2,bps:30},{playerId:3,bps:25}])
if(tiedBonus[1]!==3||tiedBonus[2]!==3||tiedBonus[3]!==1)throw new Error('BPS tie allocation failed')
const calibration=evaluateCalibration(Array.from({length:20},()=>({position:'MID',expectedPoints:4,actualPoints:8}))).find(row=>row.position==='MID')
if(calibration?.factor!==1.25)throw new Error('calibration bounds failed')
const knownDefender={...players.find(player=>player.position==='DEF'),expectedMinutes:45,dataConfidence:'HIGH',coldStart:false,stats:{minutes:1800},upcomingFixtures:[{gameweek:1,opponent:'SUN',venue:'H',difficulty:2}]}
const coldStartDefender={...knownDefender,id:999,coldStart:true,dataConfidence:'LOW',stats:{minutes:0}}
const { horizonProjection } = await import('../src/domain.ts')
if(horizonProjection(coldStartDefender,1)>=horizonProjection(knownDefender,1))throw new Error('cold-start uncertainty discount failed')
const shortlistPool=['GK','DEF','MID','FWD'].flatMap((position,positionIndex)=>Array.from({length:10},(_,index)=>{const base=players.find(player=>player.position===position);return {...base,id:2000+positionIndex*20+index,name:`Candidate ${position} ${index}`,club:`X${positionIndex}${index}`,price:4+index*.4,projection:6+index,expectedMinutes:90,dataConfidence:'HIGH',upcomingFixtures:[{gameweek:1,opponent:'SUN',venue:'H',difficulty:2}]}}))
const shortlist=transfers(5,20,1,squad,shortlistPool)
if(shortlist.length>30||shortlist.some(option=>option.net<1.5))throw new Error('transfer shortlist threshold/cap failed')
const shortlistCounts=shortlist.reduce((result,option)=>(result[option.out.id]=(result[option.out.id]||0)+1,result),{})
if(Math.max(0,...Object.values(shortlistCounts))>3)throw new Error('per-outgoing transfer shortlist cap failed')

const lockedCore=[players.find(player=>player.name==='Haaland').id,players.find(player=>player.name==='Bruno Fernandes').id]
const optimizedDraft=optimizeInitialSquad(players,{lockedPlayerIds:lockedCore,horizon:5,budget:100})
if(optimizedDraft.length!==15||validateInitialSquad(optimizedDraft).length)throw new Error('GW1 optimizer did not return a legal £100m squad')
if(!lockedCore.every(id=>optimizedDraft.some(player=>player.id===id)))throw new Error('GW1 optimizer did not preserve locked players')
const optimizedCost=optimizedDraft.reduce((sum,player)=>sum+player.price,0)
if(optimizedCost>100.0001||initialSquadBank(optimizedDraft)!==+(100-optimizedCost).toFixed(1))throw new Error('GW1 hard budget/derived bank failed')
const greedyDraft=buildLegalDefaultSquad(players,100)
if(draftSquadScore(5,optimizedDraft).total<draftSquadScore(5,greedyDraft).total)throw new Error('GW1 optimizer regressed behind greedy autocomplete')
const restructure=buildDraftImprovementPlan(getSquad(),players,{lockedPlayerIds:[lockedCore[0]],horizon:5})
if(!restructure||restructure.changes.length<2||restructure.optimizedCost>100)throw new Error('coordinated GW1 restructure was not produced')
if(!isInitialDraftPeriod(1,'2026-08-21T05:30:00Z',Date.parse('2026-08-10T00:00:00Z'))||isInitialDraftPeriod(2,'2026-08-28T05:30:00Z',Date.parse('2026-08-10T00:00:00Z')))throw new Error('draft/in-season mode boundary failed')

const targetTemplate=players.find(player=>player.name==='Mbeumo')
const routeTarget={...targetTemplate,id:4001,name:'Bruno Fernandes',club:'MUN',price:8.5,projection:8.5}
const directRoutes=findTransferRoutesToTarget(routeTarget,squad,[...players,routeTarget],5,1.2,1)
if(!directRoutes.routes.some(route=>route.moves.length===1&&route.moves[0].in.id===routeTarget.id))throw new Error('direct named-player route was not found')
const budgetTemplate=players.find(player=>player.position==='DEF')
const expensiveTarget={...routeTarget,id:4002,price:11.5}
const budgetDefender={...budgetTemplate,id:4003,name:'Budget Defender',club:'TOT',price:4,projection:2}
const fundedRoutes=findTransferRoutesToTarget(expensiveTarget,squad,[...players,expensiveTarget,budgetDefender],5,1.2,1)
if(!fundedRoutes.routes.some(route=>route.moves.length===2&&route.hitCost===4&&route.bankAfter>=0))throw new Error('two-transfer funding route was not found')

console.log('domain verification passed (rules-aware scoring, calibration and 2026/27 canaries)')
