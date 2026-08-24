import { describe, expect, it } from 'vitest'
import { assessPlanPriceTiming, assessPricePressure, assessPriceTiming, deriveRecommendationRobustness, sellingPriceAfterMarketFall } from './price-timing.ts'

const robust = { action: 'TRANSFER' as const, actionable: true, netExpectedGain: 3, probabilityBeatsRoll: .8, latestMatchSensitivity: 'LOW' as const }
const base = {
  incoming: { transfersIn: 82_000, transfersOut: 400, window: 'EVENT' as const, buyPriceTenths: 65 },
  outgoing: { transfersIn: 1_000, transfersOut: 28_000, window: 'EVENT' as const, sellingPriceTenths: 60, currentPriceTenths: 60, purchasePriceTenths: 60 },
  bankBeforeTenths: 5,
  deadlineAt: '2026-08-28T17:30:00.000Z',
  now: Date.parse('2026-08-24T00:00:00.000Z'),
  recommendation: robust,
}

describe('price timing', () => {
  it('calls transfer activity pressure, not a deterministic price prediction', () => {
    const pressure = assessPricePressure({ transfersIn: 81_602, transfersOut: 1_000, window: 'EVENT' }, 'UPWARD')
    expect(pressure).toMatchObject({ direction: 'UPWARD', level: 'HIGH', confidence: 'MEDIUM', netTransfers: 80_602 })
    expect(pressure.description).toContain('not a price-rise/fall prediction')
  })

  it('downgrades unknown count windows and does not manufacture velocity', () => {
    const pressure = assessPricePressure({ transfersIn: 60_000, transfersOut: 0 }, 'UPWARD')
    expect(pressure.confidence).toBe('LOW')
    expect(pressure.description).toContain('count window is unknown')
  })

  it('calculates exact adverse affordability using buy, current and selling prices', () => {
    const result = assessPriceTiming(base)
    expect(result.adverseScenarios).toEqual([
      { adverseSteps: 1, adverseSwingTenths: 1, status: 'UNAFFORDABLE', bankAfterTenths: -1, incomingBuyPriceTenths: 66, outgoingSellingPriceTenths: 60 },
      { adverseSteps: 2, adverseSwingTenths: 2, status: 'UNAFFORDABLE', bankAfterTenths: -2, incomingBuyPriceTenths: 66, outgoingSellingPriceTenths: 59 },
    ])
    expect(result.verdict).toBe('ACT_SOON')
  })

  it('applies the half-profit sale rule to future falls', () => {
    expect(sellingPriceAfterMarketFall({ sellingPriceTenths: 56, currentPriceTenths: 62, purchasePriceTenths: 50 }, 1)).toBe(55)
    expect(sellingPriceAfterMarketFall({ sellingPriceTenths: 56, currentPriceTenths: 62, purchasePriceTenths: 50 }, 2)).toBe(55)
  })

  it('does not make a marginal or latest-match-sensitive move urgent for price reasons', () => {
    const marginal = assessPriceTiming({ ...base, recommendation: { ...robust, netExpectedGain: .8, probabilityBeatsRoll: .61 } })
    expect(marginal.robustness).toBe('MARGINAL')
    expect(marginal.verdict).toBe('WAIT')
    const sensitive = assessPriceTiming({ ...base, recommendation: { ...robust, latestMatchSensitivity: 'HIGH' } })
    expect(sensitive.robustness).toBe('SENSITIVE')
    expect(sensitive.verdict).toBe('WAIT')
    const roleSensitive = assessPriceTiming({ ...base, recommendation: { ...robust, latestMatchSensitive: true } })
    expect(roleSensitive.robustness).toBe('SENSITIVE')
    expect(roleSensitive.verdict).toBe('WAIT')
  })

  it('asks to check again when a robust pressured move remains affordable', () => {
    const result = assessPriceTiming({ ...base, bankBeforeTenths: 20 })
    expect(result.adverseScenarios[0].status).toBe('AFFORDABLE')
    expect(result.verdict).toBe('CHECK_AGAIN')
  })

  it('refuses an action verdict after deadline and exposes unknown economics', () => {
    const past = assessPriceTiming({ ...base, now: Date.parse('2026-08-29T00:00:00.000Z') })
    expect(past.verdict).toBe('DEADLINE_PASSED')
    const unknown = assessPriceTiming({ ...base, outgoing: { ...base.outgoing, purchasePriceTenths: null } })
    expect(unknown.adverseScenarios[0].status).toBe('UNAFFORDABLE')
    expect(unknown.adverseScenarios[1].status).toBe('UNKNOWN')
    // £0.1 affordability remains exact using the authoritative sale price, so
    // the missing historical purchase price only limits the £0.2 scenario.
    expect(unknown.verdict).toBe('ACT_SOON')
  })

  it('defines robustness independently of price pressure', () => {
    expect(deriveRecommendationRobustness({ action: 'ROLL' })).toBe('MARGINAL')
    expect(deriveRecommendationRobustness({ action: 'TRANSFER', actionable: true, netExpectedGain: 3, probabilityBeatsRoll: .8, latestMatchSensitivity: 'LOW' })).toBe('ROBUST')
  })

  it('assesses multi-move routes against the simultaneous route budget', () => {
    const result = assessPlanPriceTiming({
      bankBeforeTenths: 0,
      deadlineAt: base.deadlineAt,
      now: base.now,
      recommendation: robust,
      moves: [
        { incoming: base.incoming, outgoing: base.outgoing },
        { incoming: { transfersIn: 100, transfersOut: 0, window: 'EVENT', buyPriceTenths: 55 }, outgoing: { transfersIn: 0, transfersOut: 100, window: 'EVENT', sellingPriceTenths: 60, currentPriceTenths: 60, purchasePriceTenths: 60 } },
      ],
    })
    expect(result.moveCount).toBe(2)
    // Current route funds £12.0m of purchases with £12.0m of sales; the
    // highest-pressure incoming rise is therefore enough to break it.
    expect(result.adverseScenarios[0]).toMatchObject({ adverseSwingTenths: 1, status: 'UNAFFORDABLE', bankAfterTenths: -1 })
    expect(result.verdict).toBe('ACT_SOON')
  })

  it('keeps a roll as WAIT even when a caller supplies a robust-looking score', () => {
    const result = assessPlanPriceTiming({ bankBeforeTenths: 0, deadlineAt: base.deadlineAt, now: base.now, recommendation: { ...robust, action: 'ROLL' }, moves: [] })
    expect(result.verdict).toBe('WAIT')
    expect(result.reasons[0]).toContain('Rolling keeps the transfer')
  })
})
