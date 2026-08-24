import { describe, expect, it } from 'vitest'
import { classifyRecommendation, ACTION_PROBABILITY, MIN_ACTION_NET_GAIN, WATCHLIST_PROBABILITY } from './recommendation-policy.ts'

describe('recommendation policy classification', () => {
  it('keeps a 60% early-season-sensitive transfer off primary', () => {
    expect(classifyRecommendation({
      action: 'TRANSFER',
      actionable: true,
      affordabilityStatus: 'EXACT',
      netExpectedGain: 4.4,
      probabilityBeatsRoll: .60,
      latestMatchSensitivity: 'HIGH',
    })).toBe('SENSITIVE')
  })

  it('calls a stable 74% transfer marginal', () => {
    expect(classifyRecommendation({
      action: 'TRANSFER',
      actionable: true,
      affordabilityStatus: 'EXACT',
      netExpectedGain: 4,
      probabilityBeatsRoll: .74,
      latestMatchSensitivity: 'LOW',
    })).toBe('MARGINAL')
  })

  it('calls a stable 75% two-point transfer robust', () => {
    expect(classifyRecommendation({
      action: 'TRANSFER',
      actionable: true,
      affordabilityStatus: 'EXACT',
      netExpectedGain: 2,
      probabilityBeatsRoll: .75,
      latestMatchSensitivity: 'LOW',
    })).toBe('ROBUST')
  })

  it('marks non-transfers or unconfirmed assumptions ineligible', () => {
    expect(classifyRecommendation({
      action: 'ROLL',
      actionable: true,
      affordabilityStatus: 'EXACT',
      netExpectedGain: 0,
      probabilityBeatsRoll: 0,
    })).toBe('INELIGIBLE')

    expect(classifyRecommendation({
      action: 'TRANSFER',
      actionable: false,
      affordabilityStatus: 'EXACT',
      netExpectedGain: 3,
      probabilityBeatsRoll: .8,
    })).toBe('INELIGIBLE')

    expect(classifyRecommendation({
      action: 'TRANSFER',
      actionable: true,
      affordabilityStatus: 'AFFORDABILITY_UNKNOWN',
      netExpectedGain: 3,
      probabilityBeatsRoll: .8,
    })).toBe('INELIGIBLE')

    expect(classifyRecommendation({
      action: 'TRANSFER',
      actionable: true,
      affordabilityStatus: 'EXACT',
      netExpectedGain: 3,
      probabilityBeatsRoll: null,
    })).toBe('INELIGIBLE')
  })

  it('identifies role latest-match sensitivity as SENSITIVE', () => {
    expect(classifyRecommendation({
      action: 'TRANSFER',
      actionable: true,
      affordabilityStatus: 'EXACT',
      netExpectedGain: 5,
      probabilityBeatsRoll: .9,
      roleLatestMatchSensitive: true,
    })).toBe('SENSITIVE')

    expect(classifyRecommendation({
      action: 'TRANSFER',
      actionable: true,
      affordabilityStatus: 'EXACT',
      netExpectedGain: 5,
      probabilityBeatsRoll: .9,
      latestMatchSensitive: true,
    })).toBe('SENSITIVE')
  })

  it('requires at least 2.0 net points gain for ROBUST', () => {
    expect(classifyRecommendation({
      action: 'TRANSFER',
      actionable: true,
      affordabilityStatus: 'EXACT',
      netExpectedGain: 1.99,
      probabilityBeatsRoll: .85,
      latestMatchSensitivity: 'LOW',
    })).toBe('MARGINAL')
  })
})
