import { getBestLineup, getBestTransfers, getRecentMinutes, getUpgradeOpportunities, type Evidence, type Horizon, type ToolContext } from './intelligence.ts'
import { horizonProjection, type Transfer } from './domain.ts'
import { resolveMultiplePlayerMentions } from './integrations.ts'

export type ReviewLabel='BUY'|'SELL'|'KEEP'|'ROLL'|'CAUTION'
export type Confidence='LOW'|'MEDIUM'|'HIGH'
export type AgentRole='quant'|'skeptic'|'arbiter'
export type ReviewEvidence={claim:string;evidence:Evidence<unknown>[]}
export type QuantAnalysis={agent:'quant';recommendation:ReviewLabel;transfer:Transfer|null;expectedNetAdvantage:number;horizon:Horizon;arguments:string[];evidence:ReviewEvidence[]}
export type SkepticAnalysis={agent:'skeptic';stance:'SUPPORT'|'CAUTION'|'CHALLENGE';concerns:string[];evidence:ReviewEvidence[];projectionWarnings:string[]}
export type ArbiterDecision={agent:'arbiter';decision:ReviewLabel;transfer:Transfer|null;expectedNetAdvantage:number;horizon:Horizon;mainArgument:string;strongestCounterargument:string;confidence:Confidence;whatWouldChange:string[];disagreement:boolean}
export type DecisionReview={quant:QuantAnalysis;skeptic:SkepticAnalysis;arbiter:ArbiterDecision;rounds:number;toolTrace:string[]}

export type AgentProvider={quant?:(input:{question:string;facts:unknown})=>Promise<Partial<QuantAnalysis>>;skeptic?:(input:{question:string;facts:unknown;quant:QuantAnalysis})=>Promise<Partial<SkepticAnalysis>>;arbiter?:(input:{question:string;facts:unknown;quant:QuantAnalysis;skeptic:SkepticAnalysis})=>Promise<Partial<ArbiterDecision>>}

const evidence=(claim:string,...items:Evidence<unknown>[]):ReviewEvidence=>({claim,evidence:items})
const confidence=(gain:number,concerns:number):Confidence=>gain>=5&&concerns===0?'HIGH':gain>=2?'MEDIUM':'LOW'
const signedMoney=(value:number)=>value===0?'no price change':value>0?`costs £${value.toFixed(1)}m more`:`frees £${Math.abs(value).toFixed(1)}m`
const priceSignal=(value:'RISING_SOON'|'FALLING_SOON'|'STABLE'|undefined)=>value==='RISING_SOON'?'rising':value==='FALLING_SOON'?'falling':'stable'

export async function reviewDecision(question:string,horizon:Horizon,ctx:ToolContext,provider:AgentProvider={},preferredTransfer:Transfer|null=null):Promise<DecisionReview>{
  const transfers=getBestTransfers(horizon,10,ctx);const upgrades=getUpgradeOpportunities(horizon,ctx);const lineup=getBestLineup(ctx.currentGameweek||0,ctx);const best=preferredTransfer||transfers.data.transfers[0]||null;const toolTrace=[transfers.tool,upgrades.tool,lineup.tool]
  const mentioned=resolveMultiplePlayerMentions(question,ctx.players)
  const isComparisonQuery=/\b(vs|versus|or|compare|better|between|prefer|against)\b/i.test(question)
  const isLineupQuery=/starting|lineup|xi|team|starters/i.test(question)
  const lineupNames=lineup.data.lineup.map(p=>`${p.name} (${p.position})`).join(', ')

  let quantArgs: string[] = []
  let recommendation: ReviewLabel = best ? 'BUY' : 'ROLL'
  let mainArgumentOverride: string | null = null
  let counterweightOverride: string | null = null

  if (mentioned.length >= 2 || (mentioned.length === 1 && isComparisonQuery)) {
    const p1 = mentioned[0]
    const p2 = mentioned[1] || ctx.players.find(p => p.id !== p1.id && p.position === p1.position) || ctx.players[0]
    const p1Xpts = horizonProjection(p1, horizon)
    const p2Xpts = horizonProjection(p2, horizon)
    const winner = p1Xpts >= p2Xpts ? p1 : p2
    const loser = p1Xpts >= p2Xpts ? p2 : p1
    const winXpts = Math.max(p1Xpts, p2Xpts)
    const loseXpts = Math.min(p1Xpts, p2Xpts)
    const diff = (winXpts - loseXpts).toFixed(1)
    const isWinnerOwned = ctx.squad.some(s => s.id === winner.id)

    recommendation = isWinnerOwned ? 'KEEP' : 'BUY'
    mainArgumentOverride = `${winner.name} (${winner.club}) is projected for ${winXpts.toFixed(1)} pts over ${horizon} GWs versus ${loser.name}'s ${loseXpts.toFixed(1)} pts (+${diff} pts advantage).`
    counterweightOverride = `${loser.name} (£${loser.price.toFixed(1)}m) offers alternative fixture or price upside compared to ${winner.name} (£${winner.price.toFixed(1)}m).`
    quantArgs = [
      `Comparing ${winner.name} vs ${loser.name}: ${winner.name} projects ${winXpts.toFixed(1)} pts over ${horizon} GWs versus ${loseXpts.toFixed(1)} pts for ${loser.name} (+${diff} pts advantage).`,
      `${winner.name} costs £${winner.price.toFixed(1)}m (${winner.club}, ${winner.position}) with expected minutes of ${winner.expectedMinutes ?? 90}%.`,
      `${loser.name} costs £${loser.price.toFixed(1)}m (${loser.club}, ${loser.position}) with expected minutes of ${loser.expectedMinutes ?? 90}%.`
    ]
  } else if (mentioned.length === 1) {
    const p = mentioned[0]
    const pXpts = horizonProjection(p, horizon)
    const isOwned = ctx.squad.some(s => s.id === p.id)
    recommendation = isOwned ? 'KEEP' : 'BUY'
    mainArgumentOverride = `${p.name} (${p.club}, £${p.price.toFixed(1)}m) is projected for ${pXpts.toFixed(1)} pts over ${horizon} GWs.`
    counterweightOverride = `Monitor ${p.name}'s expected minutes (${p.expectedMinutes ?? 90}%) and upcoming fixture difficulty before locking in transfers.`
    quantArgs = [
      `${p.name} (${p.club}, £${p.price.toFixed(1)}m) is projected for ${pXpts.toFixed(1)} pts over the next ${horizon} GWs.`,
      `Expected minutes signal: ${p.expectedMinutes ?? 90}%. ${isOwned ? 'Currently owned in your squad.' : 'Not currently in your squad.'}`,
      `Upcoming fixture difficulty and role profile are factored into the horizon projection.`
    ]
  } else if (isLineupQuery) {
    quantArgs = [
      `Calculated optimal Starting XI: ${lineupNames}.`,
      best ? `Primary upgrade move considered: ${best.out.name} → ${best.in.name} (+${best.net} pts).` : 'No transfers recommended this week.'
    ]
  } else {
    quantArgs = best ? [
      `${best.in.name} projects ${best.inProjection.toFixed(1)} points over ${horizon} GWs versus ${best.outProjection.toFixed(1)} for ${best.out.name}: a ${best.gain.toFixed(1)}-point improvement.`,
      `The availability signal is ${best.in.minutes}% for ${best.in.name} versus ${best.out.minutes}% for ${best.out.name}; fixture difficulty is already included in the projection.`,
      `The move ${signedMoney(best.priceDelta)} and returns ${best.net.toFixed(1)} net points after the ${best.hitCost}-point hit cost.`
    ] : ['No legal move clears the marginal-gain threshold; roll the transfer.']
  }

  const quantBase:QuantAnalysis={agent:'quant',recommendation,transfer:best,expectedNetAdvantage:best?.net||0,horizon,arguments:quantArgs,evidence:[evidence('ranked legal transfer',...transfers.evidence),evidence('upgrade opportunities',...upgrades.evidence)]}
  const quant={...quantBase,...(provider.quant?await provider.quant({question,facts:{transfers:transfers.data,upgrades:upgrades.data,lineup:lineup.data}}):{}) ,agent:'quant' as const,horizon}
  let recent:ReturnType<typeof getRecentMinutes>|null=null;if(quant.transfer){recent=getRecentMinutes(quant.transfer.in.id,ctx);toolTrace.push(recent.tool)}
  const warnings:string[]=[];
  if(recent&&recent.data.minutes.value<75){warnings.push(`${quant.transfer?.in.name} has an aggregate minutes signal of ${recent.data.minutes.value}%, below the model's preferred certainty.`)}
  if(quant.transfer){
    const inNet = (quant.transfer.in.transfersIn||0) - (quant.transfer.in.transfersOut||0);
    const outNet = (quant.transfer.out.transfersIn||0) - (quant.transfer.out.transfersOut||0);
    if(outNet <= -20000) {
      warnings.push(`${quant.transfer.out.name} is under heavy sell-off pressure (-${Math.abs(outNet).toLocaleString()} net transfers), signaling price fall risk or unflagged rotation concerns.`);
    }
    if(inNet >= 25000) {
      warnings.push(`${quant.transfer.in.name} has high transfer momentum (+${inNet.toLocaleString()} net transfers in). Consider executing before a price rise.`);
    }
  }
  const skepticConcerns = warnings.length ? warnings : quant.transfer ? [
    `No immediate red flag is present: ${quant.transfer.in.name} carries a ${recent?.data.minutes.value ?? quant.transfer.in.minutes}% expected-minutes signal and a ${priceSignal(quant.transfer.priceAlert)} price signal.`,
    `The main risk is projection uncertainty: the move only pays off if ${quant.transfer.in.name} keeps that role and availability advantage over ${quant.transfer.out.name}.`
  ] : ['No legal transfer is available at the current marginal-gain threshold.']
  const skepticBase:SkepticAnalysis={agent:'skeptic',stance:warnings.length?'CAUTION':'SUPPORT',concerns:skepticConcerns,evidence:recent?[evidence('recent minutes evidence',...recent.evidence)]:[],projectionWarnings:warnings}
  const skeptic={...skepticBase,...(provider.skeptic?await provider.skeptic({question,facts:{recentMinutes:recent?.data,transfers:transfers.data},quant}):{}),agent:'skeptic' as const}
  const transferWhy = quant.transfer ? [
    `${quant.transfer.in.name} projects ${quant.transfer.inProjection.toFixed(1)} points over ${horizon} GWs versus ${quant.transfer.outProjection.toFixed(1)} for ${quant.transfer.out.name}: a ${quant.transfer.gain.toFixed(1)}-point improvement.`,
    `${quant.transfer.in.name} has ${recent?.data.minutes.value ?? quant.transfer.in.minutes}% expected minutes versus ${quant.transfer.out.minutes}% for ${quant.transfer.out.name}; this is the clearest availability edge in the move.`,
    `The move ${signedMoney(quant.transfer.priceDelta)} and is legal with £${ctx.bank.toFixed(1)}m in the bank and ${ctx.freeTransfers} free transfer${ctx.freeTransfers===1?'':'s'}.`
  ] : ['No legal transfer clears the model’s actionable-gain threshold.']
  const counterweight = counterweightOverride || (quant.transfer ? skeptic.concerns.find(concern=>!concern.startsWith('No immediate red flag')) || `The recommendation is most sensitive to ${quant.transfer.in.name} retaining the expected-minutes and fixture assumptions behind the projection.` : 'Wait for a clearer upgrade rather than spending the transfer.')
  const mainArg = mainArgumentOverride || transferWhy[0]
  const arbiterBase:ArbiterDecision={agent:'arbiter',decision:skeptic.stance==='CHALLENGE'?'CAUTION':quant.recommendation,transfer:quant.transfer,expectedNetAdvantage:quant.expectedNetAdvantage,horizon,mainArgument:mainArg,strongestCounterargument:counterweight,confidence:confidence(quant.expectedNetAdvantage,warnings.length),whatWouldChange:warnings.length?['A confirmed change to expected minutes, availability or price risk.']:quant.transfer?[`Re-evaluate if ${quant.transfer.in.name} loses the expected role, or if ${quant.transfer.out.name} regains a reliable starting role.`]:['A material change in player availability, role or fixture outlook.'],disagreement:skeptic.stance!=='SUPPORT'}
  const arbiter={...arbiterBase,...(provider.arbiter?await provider.arbiter({question,facts:{transfers:transfers.data,upgrades:upgrades.data,recentMinutes:recent?.data},quant,skeptic}):{}),agent:'arbiter' as const,horizon}
  return {quant,skeptic,arbiter,rounds:3,toolTrace}
}

