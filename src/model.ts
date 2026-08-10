import type { FixtureItem, Player, Position } from './domain'
import { expectedRoleMinutes, normalizeRoleProfile, type PlayerRoleProfile } from './player-signals.ts'

export const MODEL_VERSION = 'role-aware-v2.0'

export const scoringRules = {
  appearance: { played: 1, sixtyMinutes: 1 },
  goal: { GK: 10, DEF: 6, MID: 5, FWD: 4 },
  assist: 3,
  cleanSheet: { GK: 4, DEF: 4, MID: 1, FWD: 0 },
  goalsConcededPerTwo: { GK: -1, DEF: -1, MID: 0, FWD: 0 },
  savesPerThree: 1,
  penaltySave: 5,
  penaltyMiss: -2,
  ownGoal: -2,
  yellowCard: -1,
  redCard: -3,
  defensiveContribution: 2,
} as const

const positionPriors: Record<Position, { goals:number; assists:number; xgc:number; saves:number; bonus:number; cards:number; defensiveActions:number }> = {
  GK: { goals:.002, assists:.008, xgc:1.35, saves:3.2, bonus:.28, cards:.04, defensiveActions:0 },
  DEF:{ goals:.055, assists:.095, xgc:1.35, saves:0, bonus:.34, cards:.16, defensiveActions:8.2 },
  MID:{ goals:.205, assists:.185, xgc:1.35, saves:0, bonus:.42, cards:.15, defensiveActions:7.6 },
  FWD:{ goals:.37, assists:.15, xgc:1.35, saves:0, bonus:.52, cards:.13, defensiveActions:4.2 },
}

export type Projection = {
  playerId:number; gameweek:number; modelVersion:string; expectedMinutes:number
  expectedGoals:number; expectedAssists:number; cleanSheetProbability:number
  expectedBonus:number; expectedCardDeduction:number; expectedPoints:number
}

export type ProjectionBreakdown = {
  playerId:number; playerName:string; modelVersion:string; horizon:number
  baseline:number; fixtureAdjustment:number; expectedMinutesAdjustment:number
  appearance:number; attackingContribution:number; cleanSheetContribution:number
  goalsConcededDeduction:number; savePoints:number; penaltyPoints:number
  defensiveContribution:number; bonus:number; cardDeduction:number
  finalExpectedPoints:number; expectedMinutes:number
  minutesConfidence:'LOW'|'MEDIUM'|'HIGH'; warning?:string
}

export type MatchScoreInput = {
  position:Position; minutes:number; goals?:number; assists?:number; cleanSheet?:boolean
  goalsConceded?:number; saves?:number; penaltiesSaved?:number; penaltiesMissed?:number
  ownGoals?:number; yellowCards?:number; redCards?:number; bonus?:number
  clearancesBlocksInterceptions?:number; tackles?:number; recoveries?:number
}

export type MatchScoreBreakdown = {
  appearance:number; goals:number; assists:number; cleanSheet:number; goalsConceded:number
  saves:number; penalties:number; ownGoals:number; cards:number; defensiveContribution:number
  bonus:number; total:number
}

type FixtureProjection = {
  expectedMinutes:number; appearance:number; goals:number; assists:number; cleanSheet:number
  cleanSheetProbability:number; goalsConceded:number; saves:number; penalties:number
  defensiveContribution:number; bonus:number; cards:number; total:number
}

const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value))
const round=(value:number,digits=3)=>+value.toFixed(digits)
const per90=(total:number|undefined,minutes:number)=>minutes>0?(total||0)*90/minutes:0

function shrunkRate(observed:number, prior:number, minutes:number, priorMinutes=540) {
  return (observed*minutes+prior*priorMinutes)/(minutes+priorMinutes)
}

function poissonFloorExpectation(lambda:number, divisor:number) {
  if(lambda<=0)return 0
  let probability=Math.exp(-lambda), expected=0
  for(let n=0;n<40;n++) {
    if(n>0) probability*=lambda/n
    expected+=Math.floor(n/divisor)*probability
  }
  return expected
}

function poissonAtLeast(lambda:number, threshold:number) {
  if(lambda<=0)return 0
  let term=Math.exp(-lambda), cumulative=term
  for(let n=1;n<threshold;n++){term*=lambda/n;cumulative+=term}
  return clamp(1-cumulative,0,1)
}

export function playerRoleProfile(player:Player):PlayerRoleProfile {
  if(player.roleProfile)return normalizeRoleProfile(player.roleProfile)
  const targetMinutes=clamp(player.expectedMinutes ?? 90*(player.minutes/100),0,90)
  const goalkeeper=player.position==='GK'
  const minutesIfStarting=goalkeeper?90:86
  const substituteProbabilityWhenBenched=goalkeeper ? .005 : .2
  const minutesIfSubstitute=goalkeeper?5:18
  const cameoMinutes=substituteProbabilityWhenBenched*minutesIfSubstitute
  const startProbability=clamp((targetMinutes-cameoMinutes)/(minutesIfStarting-cameoMinutes),0,1)
  return normalizeRoleProfile({
    startProbability,
    minutesIfStarting,
    substituteProbabilityWhenBenched,
    minutesIfSubstitute,
    confidence:player.dataConfidence||'LOW',
    derivedFromSignalIds:[],
  })
}

function fixtureFactors(fixture:FixtureItem) {
  const difficultyAttack:Record<number,number>={1:1.30,2:1.15,3:1,4:.84,5:.70}
  const attack=(difficultyAttack[fixture.difficulty]||1)*(fixture.venue==='H'?1.05:.96)
  const defence=(2-attack)*.92+0.08
  return {attack:clamp(attack,.55,1.4), defence:clamp(defence,.65,1.45)}
}

function playerRates(player:Player) {
  const stats=player.stats
  const minutes=Math.max(0,stats?.minutes||0)
  const prior=positionPriors[player.position]
  const fallbackStrength=clamp(player.projection/(player.position==='GK'||player.position==='DEF'?4:player.position==='MID'?5.2:5.5),.65,1.65)
  const observedGoals=stats?.expectedGoalsPer90 ?? (per90(stats?.expectedGoals,minutes) || per90(stats?.goals,minutes))
  const observedAssists=stats?.expectedAssistsPer90 ?? (per90(stats?.expectedAssists,minutes) || per90(stats?.assists,minutes))
  const goalRate=minutes>0?shrunkRate(observedGoals,prior.goals,minutes):prior.goals*fallbackStrength
  const assistRate=minutes>0?shrunkRate(observedAssists,prior.assists,minutes):prior.assists*fallbackStrength
  const xgcObserved=stats?.expectedGoalsConcededPer90 ?? per90(stats?.expectedGoalsConceded,minutes)
  const xgcRate=minutes>0?shrunkRate(xgcObserved||prior.xgc,prior.xgc,minutes,720):prior.xgc
  const saveRate=minutes>0?shrunkRate(stats?.savesPer90??per90(stats?.saves,minutes),prior.saves,minutes):prior.saves
  const bonusRate=minutes>0?shrunkRate(per90(stats?.bonus,minutes),prior.bonus,minutes):prior.bonus*fallbackStrength
  const cardRate=minutes>0?shrunkRate(per90((stats?.yellowCards||0)+3*(stats?.redCards||0),minutes),prior.cards,minutes):prior.cards
  const rawDefensive=(stats?.clearancesBlocksInterceptions||0)+(stats?.tackles||0)+(player.position==='MID'||player.position==='FWD'?(stats?.recoveries||0):0)
  const defensiveRate=minutes>0?shrunkRate(per90(rawDefensive,minutes),prior.defensiveActions,minutes):prior.defensiveActions
  return {goalRate,assistRate,xgcRate,saveRate,bonusRate,cardRate,defensiveRate,minutes}
}

function oneFixtureAtMinutes(player:Player,fixture:FixtureItem,mins:number):FixtureProjection {
  const rates=playerRates(player)
  const minuteShare=mins/90
  const playProbability=mins>0?1:0
  const sixtyProbability=mins>=60?1:0
  const {attack,defence}=fixtureFactors(fixture)
  const goals=rates.goalRate*minuteShare*attack*scoringRules.goal[player.position]
  const assists=rates.assistRate*minuteShare*attack*scoringRules.assist
  const appearance=playProbability+sixtyProbability
  const cleanSheetProbability=Math.exp(-rates.xgcRate*defence)
  const cleanSheet=cleanSheetProbability*sixtyProbability*scoringRules.cleanSheet[player.position]
  const concededLambda=rates.xgcRate*defence*Math.max(0,mins-60)/30
  const goalsConceded=(player.position==='GK'||player.position==='DEF')?-poissonFloorExpectation(concededLambda,2)*sixtyProbability:0
  const saves=player.position==='GK'?poissonFloorExpectation(rates.saveRate*minuteShare/Math.max(defence,.75),3):0
  const penaltySaveRate=per90(player.stats?.penaltiesSaved,rates.minutes)
  const penaltyMissRate=per90(player.stats?.penaltiesMissed,rates.minutes)
  const ownGoalRate=per90(player.stats?.ownGoals,rates.minutes)
  const penalties=minuteShare*(penaltySaveRate*scoringRules.penaltySave+penaltyMissRate*scoringRules.penaltyMiss+ownGoalRate*scoringRules.ownGoal)
  const dcThreshold=player.position==='DEF'?10:12
  const defensiveContribution=player.position==='GK'?0:poissonAtLeast(rates.defensiveRate*minuteShare,dcThreshold)*scoringRules.defensiveContribution
  const bonus=clamp(rates.bonusRate*minuteShare*attack,0,3)
  const cards=-rates.cardRate*minuteShare
  const calibration=player.calibrationFactor??1
  const uncertaintyFactor=player.coldStart?.6:player.dataConfidence==='LOW'?.9:1
  const total=(appearance+goals+assists+cleanSheet+goalsConceded+saves+penalties+defensiveContribution+bonus+cards)*calibration*uncertaintyFactor
  return {expectedMinutes:mins,appearance,goals,assists,cleanSheet,cleanSheetProbability,goalsConceded,saves,penalties,defensiveContribution,bonus,cards,total}
}

function oneFixture(player:Player,fixture:FixtureItem):FixtureProjection {
  const role=playerRoleProfile(player)
  const startProbability=role.startProbability
  const cameoProbability=(1-startProbability)*role.substituteProbabilityWhenBenched
  const start=oneFixtureAtMinutes(player,fixture,role.minutesIfStarting)
  const cameo=oneFixtureAtMinutes(player,fixture,role.minutesIfSubstitute)
  const blend=(pick:(row:FixtureProjection)=>number)=>
    startProbability*pick(start)+cameoProbability*pick(cameo)
  return {
    expectedMinutes:expectedRoleMinutes(role),
    appearance:blend(row=>row.appearance), goals:blend(row=>row.goals), assists:blend(row=>row.assists),
    cleanSheet:blend(row=>row.cleanSheet), cleanSheetProbability:start.cleanSheetProbability,
    goalsConceded:blend(row=>row.goalsConceded), saves:blend(row=>row.saves), penalties:blend(row=>row.penalties),
    defensiveContribution:blend(row=>row.defensiveContribution), bonus:blend(row=>row.bonus), cards:blend(row=>row.cards), total:blend(row=>row.total)
  }
}

function fallbackFixtures(player:Player,horizon:number):FixtureItem[] {
  if(player.upcomingFixtures)return player.upcomingFixtures.filter(f=>f.gameweek>=1).slice(0,horizon)
  const opponent=player.fixture.split(' ')[0]||'OPP'
  const venue=player.fixture.includes('(A)')?'A':'H'
  return Array.from({length:horizon},(_,index)=>({gameweek:index+1,opponent,venue,difficulty:player.difficulty}))
}

export function projectionBreakdown(player:Player,horizon:number):ProjectionBreakdown {
  const fixtures=fallbackFixtures(player,horizon)
  const rows=fixtures.map(f=>oneFixture(player,f))
  const sum=(pick:(row:FixtureProjection)=>number)=>rows.reduce((total,row)=>total+pick(row),0)
  const appearance=sum(r=>r.appearance), goals=sum(r=>r.goals), assists=sum(r=>r.assists)
  const cleanSheetContribution=sum(r=>r.cleanSheet), goalsConcededDeduction=sum(r=>r.goalsConceded)
  const savePoints=sum(r=>r.saves), penaltyPoints=sum(r=>r.penalties), defensiveContribution=sum(r=>r.defensiveContribution)
  const bonus=sum(r=>r.bonus), cardDeduction=sum(r=>r.cards), finalExpectedPoints=sum(r=>r.total)
  const neutral=fixtures.map(f=>oneFixture(player,{...f,difficulty:3,venue:'H' as const})).reduce((n,r)=>n+r.total,0)
  const fullMinutesNeutral=fixtures.map(f=>oneFixture({...player,roleProfile:{startProbability:1,minutesIfStarting:90,substituteProbabilityWhenBenched:0,minutesIfSubstitute:0,confidence:'HIGH',derivedFromSignalIds:[]}},{...f,difficulty:3,venue:'H' as const})).reduce((n,r)=>n+r.total,0)
  const baseline=fullMinutesNeutral
  const role=playerRoleProfile(player), mins=expectedRoleMinutes(role)
  const minutesConfidence=player.coldStart?'LOW':role.confidence
  const warning=fixtures.length===0?'Blank gameweek: no scheduled fixture.':player.coldStart?'Cold-start projection: no Premier League minutes are available, so minutes and points are conservatively discounted.':minutesConfidence==='LOW'?'Expected minutes are fragile: current projection is below 50 minutes.':undefined
  return {
    playerId:player.id,playerName:player.name,modelVersion:MODEL_VERSION,horizon,
    baseline:round(baseline,1),fixtureAdjustment:round(finalExpectedPoints-neutral,1),expectedMinutesAdjustment:round(neutral-fullMinutesNeutral,1),
    appearance:round(appearance,1),attackingContribution:round(goals+assists,1),cleanSheetContribution:round(cleanSheetContribution,1),
    goalsConcededDeduction:round(goalsConcededDeduction,1),savePoints:round(savePoints,1),penaltyPoints:round(penaltyPoints,1),
    defensiveContribution:round(defensiveContribution,1),bonus:round(bonus,1),cardDeduction:round(cardDeduction,1),
    finalExpectedPoints:round(finalExpectedPoints,1),expectedMinutes:round(sum(r=>r.expectedMinutes),1),minutesConfidence,warning
  }
}

export function horizonProjection(player:Player,horizon:number) { return projectionBreakdown(player,horizon).finalExpectedPoints }

export function projectPlayer(player:Player,gameweek:number):Projection {
  const fixture=(player.upcomingFixtures||[]).find(f=>f.gameweek===gameweek)||(player.upcomingFixtures||[])[0]||fallbackFixtures(player,1)[0]
  if(!fixture)return {playerId:player.id,gameweek,modelVersion:MODEL_VERSION,expectedMinutes:0,expectedGoals:0,expectedAssists:0,cleanSheetProbability:0,expectedBonus:0,expectedCardDeduction:0,expectedPoints:0}
  const row=oneFixture(player,fixture), rates=playerRates(player), factors=fixtureFactors(fixture), share=row.expectedMinutes/90
  return {playerId:player.id,gameweek,modelVersion:MODEL_VERSION,expectedMinutes:round(row.expectedMinutes,1),expectedGoals:round(rates.goalRate*share*factors.attack),expectedAssists:round(rates.assistRate*share*factors.attack),cleanSheetProbability:round(row.cleanSheetProbability),expectedBonus:round(row.bonus),expectedCardDeduction:round(row.cards),expectedPoints:round(row.total)}
}

export function allocateBonusPoints(entries:Array<{playerId:number;bps:number}>):Record<number,number> {
  const sorted=[...entries].sort((a,b)=>b.bps-a.bps)
  const unique=[...new Set(sorted.map(row=>row.bps))]
  const result:Record<number,number>={}
  if(!unique.length)return result
  const first=sorted.filter(row=>row.bps===unique[0])
  first.forEach(row=>result[row.playerId]=3)
  if(first.length===1) {
    const second=sorted.filter(row=>row.bps===unique[1])
    second.forEach(row=>result[row.playerId]=2)
    if(second.length===1) sorted.filter(row=>row.bps===unique[2]).forEach(row=>result[row.playerId]=1)
  } else if(first.length===2) {
    sorted.filter(row=>row.bps===unique[1]).forEach(row=>result[row.playerId]=1)
  }
  return result
}

export function scorePlayerMatch(input:MatchScoreInput):MatchScoreBreakdown {
  const appearance=input.minutes<=0?0:input.minutes<60?1:2
  const goals=(input.goals||0)*scoringRules.goal[input.position]
  const assists=(input.assists||0)*scoringRules.assist
  const cleanSheet=input.cleanSheet&&input.minutes>=60?scoringRules.cleanSheet[input.position]:0
  const goalsConceded=input.position==='GK'||input.position==='DEF'?Math.floor((input.goalsConceded||0)/2)*-1:0
  const saves=input.position==='GK'?Math.floor((input.saves||0)/3):0
  const penalties=(input.penaltiesSaved||0)*scoringRules.penaltySave+(input.penaltiesMissed||0)*scoringRules.penaltyMiss
  const ownGoals=(input.ownGoals||0)*scoringRules.ownGoal
  const cards=(input.yellowCards||0)*scoringRules.yellowCard+(input.redCards||0)*scoringRules.redCard
  const actions=(input.clearancesBlocksInterceptions||0)+(input.tackles||0)+((input.position==='MID'||input.position==='FWD')?(input.recoveries||0):0)
  const threshold=input.position==='DEF'?10:12
  const defensiveContribution=input.position==='GK'||actions<threshold?0:scoringRules.defensiveContribution
  const bonus=clamp(input.bonus||0,0,3)
  const total=appearance+goals+assists+cleanSheet+goalsConceded+saves+penalties+ownGoals+cards+defensiveContribution+bonus
  return {appearance,goals,assists,cleanSheet,goalsConceded,saves,penalties,ownGoals,cards,defensiveContribution,bonus,total}
}
