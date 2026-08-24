import { describe, expect, it } from 'vitest'
import { deriveRecommendationRepairActions, deriveRecommendationSafety } from './decision-safety.ts'

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

  it('shows only actions for blockers that are still unresolved', () => {
    expect(deriveRecommendationRepairActions('DEGRADED', { freeTransfersConfirmed: true, exactSellingPrices: true }))
      .toEqual(['REVIEW_FORECAST_QUALITY'])
    expect(deriveRecommendationRepairActions('READY', { freeTransfersConfirmed: false, exactSellingPrices: true }))
      .toEqual(['CONFIRM_FREE_TRANSFERS'])
    expect(deriveRecommendationRepairActions('READY', { freeTransfersConfirmed: true, exactSellingPrices: false }))
      .toEqual(['REFRESH_TEAM_PRICES'])
  })
})
