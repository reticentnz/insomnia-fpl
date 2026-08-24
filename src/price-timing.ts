/**
 * Conservative timing guidance for a transfer recommendation.
 *
 * FPL does not publish price-change thresholds, and transfer counts alone are
 * not a price-change prediction.  This module consequently describes
 * *pressure* only.  A timing verdict can accelerate an independently robust
 * move where a one-step adverse move removes affordability; it cannot turn a
 * marginal (or roll) recommendation into a transfer.
 */

export type PricePressure = 'UNKNOWN' | 'LOW' | 'MODERATE' | 'HIGH'
export type PricePressureDirection = 'UPWARD' | 'DOWNWARD' | 'NEUTRAL' | 'UNKNOWN'
export type PriceTimingVerdict = 'WAIT' | 'CHECK_AGAIN' | 'ACT_SOON' | 'DEADLINE_PASSED'
export type RecommendationRobustness = 'ROBUST' | 'MARGINAL' | 'SENSITIVE' | 'UNKNOWN'
export type ScenarioAffordability = 'AFFORDABLE' | 'UNAFFORDABLE' | 'UNKNOWN'

export type TransferActivity = {
  transfersIn?: number | null
  transfersOut?: number | null
  /** Whether counts describe the current event/window, rather than a season total. */
  window?: 'EVENT' | 'OBSERVED_PERIOD' | 'UNKNOWN'
}

export type IncomingPrice = TransferActivity & {
  /** The exact acquisition price now, in FPL tenths of a million. */
  buyPriceTenths?: number | null
}

export type OutgoingPrice = TransferActivity & {
  /** The owned player's exact selling price now, in FPL tenths of a million. */
  sellingPriceTenths?: number | null
  /** Current public player price, required to project a future selling price. */
  currentPriceTenths?: number | null
  /** Original purchase price, required for FPL's half-profit selling rule. */
  purchasePriceTenths?: number | null
}

export type TimingRecommendation = {
  action: 'TRANSFER' | 'ROLL'
  netExpectedGain?: number | null
  probabilityBeatsRoll?: number | null
  actionable?: boolean
  /** Role-evidence sensitivity can be high even when the rate sample is not. */
  latestMatchSensitive?: boolean
  latestMatchSensitivity?: 'LOW' | 'MEDIUM' | 'HIGH'
}

export type PriceTimingInput = {
  incoming: IncomingPrice
  outgoing: OutgoingPrice
  bankBeforeTenths: number
  deadlineAt?: string | null
  now?: number
  recommendation: TimingRecommendation
}

/** A move in a multi-transfer route. The input is deliberately economics-only. */
export type PriceTimingMove = { incoming: IncomingPrice; outgoing: OutgoingPrice }
export type PlanPriceTimingInput = Omit<PriceTimingInput, 'incoming' | 'outgoing'> & { moves: PriceTimingMove[] }

export type PricePressureAssessment = {
  direction: PricePressureDirection
  level: PricePressure
  confidence: 'LOW' | 'MEDIUM'
  netTransfers: number | null
  transfersIn: number | null
  transfersOut: number | null
  window: TransferActivity['window']
  description: string
}

export type AdversePriceScenario = {
  adverseSteps: 1 | 2
  adverseSwingTenths: number
  status: ScenarioAffordability
  bankAfterTenths: number | null
  incomingBuyPriceTenths: number | null
  outgoingSellingPriceTenths: number | null
}

export type PriceTimingAssessment = {
  incomingPressure: PricePressureAssessment
  outgoingPressure: PricePressureAssessment
  robustness: RecommendationRobustness
  adverseScenarios: AdversePriceScenario[]
  verdict: PriceTimingVerdict
  deadlineAt: string | null
  deadlineStatus: 'OPEN' | 'PASSED' | 'UNKNOWN'
  reasons: string[]
}

export type PlanPriceTimingAssessment = PriceTimingAssessment & {
  moveCount: number
  /** Pressure for each route move, retained so a multi-move warning is auditable. */
  movePressure: Array<{ moveIndex: number; incoming: PricePressureAssessment; outgoing: PricePressureAssessment }>
}

const isTenths = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const isCount = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

function pressureLevel(net: number, gross: number) {
  if (net >= 50_000 || gross >= 75_000) return 'HIGH' as const
  if (net >= 25_000 || gross >= 35_000) return 'MODERATE' as const
  return 'LOW' as const
}

/** Assess current activity without claiming a published FPL price threshold. */
export function assessPricePressure(activity: TransferActivity, adverseDirection: 'UPWARD' | 'DOWNWARD'): PricePressureAssessment {
  const transfersIn = isCount(activity.transfersIn) ? activity.transfersIn : null
  const transfersOut = isCount(activity.transfersOut) ? activity.transfersOut : null
  const window = activity.window ?? 'UNKNOWN'
  if (transfersIn === null || transfersOut === null) {
    return { direction: 'UNKNOWN', level: 'UNKNOWN', confidence: 'LOW', netTransfers: null, transfersIn, transfersOut, window, description: 'Transfer activity is incomplete, so price pressure is unknown.' }
  }
  const netTransfers = transfersIn - transfersOut
  const supportingFlow = adverseDirection === 'UPWARD' ? transfersIn : transfersOut
  const directedNet = adverseDirection === 'UPWARD' ? netTransfers : -netTransfers
  const level = directedNet > 0 ? pressureLevel(directedNet, supportingFlow) : 'LOW'
  const direction: PricePressureDirection = directedNet > 0 ? adverseDirection : netTransfers === 0 ? 'NEUTRAL' : adverseDirection === 'UPWARD' ? 'DOWNWARD' : 'UPWARD'
  const confidence = window === 'EVENT' || window === 'OBSERVED_PERIOD' ? 'MEDIUM' : 'LOW'
  const qualifier = confidence === 'LOW' ? ' The count window is unknown.' : ''
  const flow = `${transfersIn.toLocaleString()} in, ${transfersOut.toLocaleString()} out (${netTransfers >= 0 ? '+' : ''}${netTransfers.toLocaleString()} net)`
  const description = direction === adverseDirection && level !== 'LOW'
    ? `${level[0]}${level.slice(1).toLowerCase()} ${adverseDirection.toLowerCase()} price pressure from ${flow}; this is not a price-rise/fall prediction.${qualifier}`
    : `No material ${adverseDirection.toLowerCase()} price pressure from ${flow}.${qualifier}`
  return { direction, level, confidence, netTransfers, transfersIn, transfersOut, window, description }
}

/**
 * FPL's published-sale convention: half of a rise is retained, while falls
 * below purchase price are fully reflected.  Returns null if we cannot model
 * the owned player's future sale price from exact current economics.
 */
export function sellingPriceAfterMarketFall(outgoing: OutgoingPrice, steps: number): number | null {
  if (!Number.isInteger(steps) || steps < 0) throw new Error('steps must be a non-negative integer')
  if (!isTenths(outgoing.sellingPriceTenths) || !isTenths(outgoing.currentPriceTenths) || !isTenths(outgoing.purchasePriceTenths)) return null
  const currentAfterFall = Math.max(0, outgoing.currentPriceTenths - steps)
  const projected = currentAfterFall <= outgoing.purchasePriceTenths
    ? currentAfterFall
    : outgoing.purchasePriceTenths + Math.floor((currentAfterFall - outgoing.purchasePriceTenths) / 2)
  // Exact current selling prices are authoritative. An incompatible set of
  // prices means we should not invent a future value.
  const expectedCurrent = outgoing.currentPriceTenths <= outgoing.purchasePriceTenths
    ? outgoing.currentPriceTenths
    : outgoing.purchasePriceTenths + Math.floor((outgoing.currentPriceTenths - outgoing.purchasePriceTenths) / 2)
  return expectedCurrent === outgoing.sellingPriceTenths ? projected : null
}

/**
 * A £0.1m scenario is an incoming rise. A £0.2m scenario combines that rise
 * with a £0.1m outgoing fall, which is the usual adverse two-player path.
 * The reported nominal swing may not equal the cash loss because the outgoing
 * sale value follows FPL's half-profit rule.
 */
function scenario(input: PriceTimingInput, swingTenths: 1 | 2): AdversePriceScenario {
  const outgoingFallSteps = swingTenths === 2 ? 1 : 0
  if (!isTenths(input.bankBeforeTenths) || !isTenths(input.incoming.buyPriceTenths)) {
    return { adverseSteps: swingTenths, adverseSwingTenths: swingTenths, status: 'UNKNOWN', bankAfterTenths: null, incomingBuyPriceTenths: null, outgoingSellingPriceTenths: null }
  }
  const outgoingSellingPriceTenths = outgoingFallSteps === 0
    ? (isTenths(input.outgoing.sellingPriceTenths) ? input.outgoing.sellingPriceTenths : null)
    : sellingPriceAfterMarketFall(input.outgoing, outgoingFallSteps)
  if (outgoingSellingPriceTenths === null) {
    return { adverseSteps: swingTenths, adverseSwingTenths: swingTenths, status: 'UNKNOWN', bankAfterTenths: null, incomingBuyPriceTenths: input.incoming.buyPriceTenths + 1, outgoingSellingPriceTenths: null }
  }
  const incomingBuyPriceTenths = input.incoming.buyPriceTenths + 1
  const bankAfterTenths = input.bankBeforeTenths + outgoingSellingPriceTenths - incomingBuyPriceTenths
  return { adverseSteps: swingTenths, adverseSwingTenths: swingTenths, status: bankAfterTenths >= 0 ? 'AFFORDABLE' : 'UNAFFORDABLE', bankAfterTenths, incomingBuyPriceTenths, outgoingSellingPriceTenths }
}

export function deriveRecommendationRobustness(recommendation: TimingRecommendation): RecommendationRobustness {
  if (recommendation.action !== 'TRANSFER' || recommendation.actionable === false) return 'MARGINAL'
  if (recommendation.latestMatchSensitive || recommendation.latestMatchSensitivity === 'HIGH') return 'SENSITIVE'
  const gain = recommendation.netExpectedGain
  const probability = recommendation.probabilityBeatsRoll
  if (typeof gain !== 'number' || !Number.isFinite(gain) || typeof probability !== 'number' || !Number.isFinite(probability)) return 'UNKNOWN'
  if (gain >= 2 && probability >= .75) return 'ROBUST'
  return 'MARGINAL'
}

function deadlineStatus(deadlineAt: string | null | undefined, now: number): PriceTimingAssessment['deadlineStatus'] {
  if (!deadlineAt) return 'UNKNOWN'
  const deadline = Date.parse(deadlineAt)
  if (!Number.isFinite(deadline)) return 'UNKNOWN'
  return deadline > now ? 'OPEN' : 'PASSED'
}

const pressureRank: Record<PricePressure, number> = { UNKNOWN: -1, LOW: 0, MODERATE: 1, HIGH: 2 }

function mostExposedMove(moves: PriceTimingMove[], side: 'incoming' | 'outgoing') {
  const direction = side === 'incoming' ? 'UPWARD' : 'DOWNWARD'
  return moves.map((move, moveIndex) => ({
    moveIndex,
    player: move[side],
    pressure: assessPricePressure(move[side], direction),
  })).sort((a, b) => pressureRank[b.pressure.level] - pressureRank[a.pressure.level] || Math.abs(b.pressure.netTransfers || 0) - Math.abs(a.pressure.netTransfers || 0))[0] || null
}

function verdictFor(input: {
  deadlineStatus: PriceTimingAssessment['deadlineStatus']
  robustness: RecommendationRobustness
  incomingPressure: PricePressureAssessment
  outgoingPressure: PricePressureAssessment
  oneStep: AdversePriceScenario
  reasons: string[]
}) {
  const pricePressure = input.incomingPressure.level === 'HIGH' || input.outgoingPressure.level === 'HIGH'
  if (input.deadlineStatus === 'PASSED') {
    input.reasons.push('The deadline has passed; do not use price pressure to time this transfer.')
    return 'DEADLINE_PASSED' as const
  }
  if (input.robustness !== 'ROBUST') {
    input.reasons.push('Price pressure cannot create urgency because this recommendation is not independently robust.')
    return 'WAIT' as const
  }
  if (pricePressure && input.oneStep.status === 'UNAFFORDABLE') {
    input.reasons.push('The transfer is independently robust and becomes unaffordable after the £0.1m adverse scenario.')
    return 'ACT_SOON' as const
  }
  if (pricePressure) {
    input.reasons.push(input.oneStep.status === 'AFFORDABLE'
      ? 'The transfer is independently robust and remains affordable after £0.1m; recheck price, news and lineups before the deadline.'
      : 'The transfer is independently robust, but exact adverse affordability is unavailable; recheck price and selling values before the deadline.')
    return 'CHECK_AGAIN' as const
  }
  input.reasons.push('No material adverse price pressure is visible; waiting preserves flexibility for new information.')
  return 'WAIT' as const
}

/**
 * Produces wording-ready price pressure and exact affordability scenarios for
 * a £0.1m/£0.2m adverse swing.  ACT_SOON is intentionally narrow: a robust
 * recommendation plus high pressure plus loss of affordability after £0.1m.
 */
export function assessPriceTiming(input: PriceTimingInput): PriceTimingAssessment {
  const now = input.now ?? Date.now()
  const incomingPressure = assessPricePressure(input.incoming, 'UPWARD')
  const outgoingPressure = assessPricePressure(input.outgoing, 'DOWNWARD')
  const robustness = deriveRecommendationRobustness(input.recommendation)
  const adverseScenarios = [scenario(input, 1), scenario(input, 2)]
  const deadlineAt = input.deadlineAt ?? null
  const status = deadlineStatus(deadlineAt, now)
  const oneStep = adverseScenarios[0]
  const reasons = [incomingPressure.description, outgoingPressure.description]
  const verdict = verdictFor({ deadlineStatus: status, robustness, incomingPressure, outgoingPressure, oneStep, reasons })
  return { incomingPressure, outgoingPressure, robustness, adverseScenarios, verdict, deadlineAt, deadlineStatus: status, reasons }
}

function planScenario(input: PlanPriceTimingInput, swingTenths: 1 | 2, incomingMoveIndex: number | null, outgoingMoveIndex: number | null): AdversePriceScenario {
  if (!isTenths(input.bankBeforeTenths)) return { adverseSteps: swingTenths, adverseSwingTenths: swingTenths, status: 'UNKNOWN', bankAfterTenths: null, incomingBuyPriceTenths: null, outgoingSellingPriceTenths: null }
  let incomingCost = 0
  let outgoingValue = 0
  for (const move of input.moves) {
    if (!isTenths(move.incoming.buyPriceTenths) || !isTenths(move.outgoing.sellingPriceTenths)) {
      return { adverseSteps: swingTenths, adverseSwingTenths: swingTenths, status: 'UNKNOWN', bankAfterTenths: null, incomingBuyPriceTenths: null, outgoingSellingPriceTenths: null }
    }
    incomingCost += move.incoming.buyPriceTenths
    outgoingValue += move.outgoing.sellingPriceTenths
  }
  if (incomingMoveIndex !== null) incomingCost += 1
  let selectedOutgoingSellingPrice: number | null = null
  if (swingTenths === 2 && outgoingMoveIndex !== null) {
    selectedOutgoingSellingPrice = sellingPriceAfterMarketFall(input.moves[outgoingMoveIndex].outgoing, 1)
    if (selectedOutgoingSellingPrice === null) return { adverseSteps: swingTenths, adverseSwingTenths: swingTenths, status: 'UNKNOWN', bankAfterTenths: null, incomingBuyPriceTenths: null, outgoingSellingPriceTenths: null }
    outgoingValue += selectedOutgoingSellingPrice - input.moves[outgoingMoveIndex].outgoing.sellingPriceTenths!
  }
  const bankAfterTenths = input.bankBeforeTenths + outgoingValue - incomingCost
  const selectedIncoming = incomingMoveIndex === null ? null : input.moves[incomingMoveIndex].incoming.buyPriceTenths! + 1
  return { adverseSteps: swingTenths, adverseSwingTenths: swingTenths, status: bankAfterTenths >= 0 ? 'AFFORDABLE' : 'UNAFFORDABLE', bankAfterTenths, incomingBuyPriceTenths: selectedIncoming, outgoingSellingPriceTenths: selectedOutgoingSellingPrice }
}

/**
 * Route-level timing. £0.1m is applied to the most exposed incoming player;
 * £0.2m adds a £0.1m fall to the most exposed outgoing player. This keeps
 * multi-transfer affordability simultaneous rather than pretending each move
 * has its own bank balance.
 */
export function assessPlanPriceTiming(input: PlanPriceTimingInput): PlanPriceTimingAssessment {
  const now = input.now ?? Date.now()
  const status = deadlineStatus(input.deadlineAt, now)
  const robustness = deriveRecommendationRobustness(input.recommendation)
  if (!input.moves.length) {
    const unknown: PricePressureAssessment = { direction: 'UNKNOWN', level: 'UNKNOWN', confidence: 'LOW', netTransfers: null, transfersIn: null, transfersOut: null, window: 'UNKNOWN', description: 'No transfer is proposed, so there is no price pressure to act on.' }
    const reasons = ['Rolling keeps the transfer; price pressure cannot create a transfer recommendation.']
    const adverseScenarios = [planScenario(input, 1, null, null), planScenario(input, 2, null, null)]
    const verdict = status === 'PASSED' ? 'DEADLINE_PASSED' : 'WAIT'
    if (status === 'PASSED') reasons.push('The deadline has passed; do not use price pressure to time this transfer.')
    return { incomingPressure: unknown, outgoingPressure: unknown, robustness: 'MARGINAL', adverseScenarios, verdict, deadlineAt: input.deadlineAt ?? null, deadlineStatus: status, reasons, moveCount: 0, movePressure: [] }
  }
  const movePressure = input.moves.map((move, moveIndex) => ({ moveIndex, incoming: assessPricePressure(move.incoming, 'UPWARD'), outgoing: assessPricePressure(move.outgoing, 'DOWNWARD') }))
  const incoming = mostExposedMove(input.moves, 'incoming')!
  const outgoing = mostExposedMove(input.moves, 'outgoing')!
  const adverseScenarios = [planScenario(input, 1, incoming.moveIndex, null), planScenario(input, 2, incoming.moveIndex, outgoing.moveIndex)]
  const reasons = [incoming.pressure.description, outgoing.pressure.description]
  const verdict = verdictFor({ deadlineStatus: status, robustness, incomingPressure: incoming.pressure, outgoingPressure: outgoing.pressure, oneStep: adverseScenarios[0], reasons })
  return { incomingPressure: incoming.pressure, outgoingPressure: outgoing.pressure, robustness, adverseScenarios, verdict, deadlineAt: input.deadlineAt ?? null, deadlineStatus: status, reasons, moveCount: input.moves.length, movePressure }
}
