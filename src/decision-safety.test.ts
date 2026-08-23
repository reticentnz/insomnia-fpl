import { describe, expect, it } from 'vitest'
import { deriveRecommendationSafety } from './decision-safety.ts'

describe('recommendation safety', () => {
  it('allows a ready recommendation with confirmed economics', () => {
    expect(deriveRecommendationSafety('READY', { freeTransfersConfirmed: true, exactSellingPrices: true }, .81)).toEqual({ actionable: true, confidence: 'HIGH', reasons: [] })
  })

  it('never labels degraded or assumption-unknown advice high confidence', () => {
    const degraded = deriveRecommendationSafety('DEGRADED', { freeTransfersConfirmed: true, exactSellingPrices: true }, .95)
    expect(degraded.actionable).toBe(false)
    expect(degraded.confidence).toBe('PROVISIONAL')
    const unknown = deriveRecommendationSafety('READY', { freeTransfersConfirmed: false, exactSellingPrices: false }, .95)
    expect(unknown.actionable).toBe(false)
    expect(unknown.confidence).toBe('BLOCKED')
    expect(unknown.reasons).toHaveLength(2)
  })
})
