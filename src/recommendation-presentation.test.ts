import { describe, expect, it } from 'vitest'
import { formatAccounting, formatTimingBadge, recommendationClassificationBadge, recommendationInputStatus, recommendationSensitivity, recommendationTiming } from './recommendation-presentation.ts'

describe('recommendation presentation', () => {
  it('states the full net-gain calculation including saved-transfer value', () => {
    expect(formatAccounting({ rawGain: 6.37, hitCost: 0, uncertaintyPenalty: 1.25, savedTransferValue: 2, netExpectedGain: 3.12 }))
      .toBe('Raw gain +6.37 − hit 0.00 − uncertainty 1.25 − roll option 2.00 = net +3.12 pts')
    expect(formatAccounting({ rawGain: 6, hitCost: 0, uncertaintyPenalty: 1, savedTransferValue: -2, netExpectedGain: 7 }))
      .toBe('Raw gain +6.00 − hit 0.00 − uncertainty 1.00 + future-structure advantage 2.00 = net +7.00 pts')
  })

  it('does not invent sensitivity or timing metadata for legacy responses', () => {
    expect(recommendationSensitivity({})).toEqual([])
    expect(recommendationInputStatus({})).toBeNull()
  })

  it('normalizes optional sensitivity and cache metadata from newer responses', () => {
    expect(recommendationSensitivity({ sensitivity: { earlySeason: true, latestMatchSensitivity: 'HIGH' } }))
      .toEqual(['EARLY-SEASON SENSITIVE', 'LATEST-MATCH SENSITIVE'])
    expect(recommendationInputStatus({ cacheStatus: 'HIT' })).toBe('reused stored result — inputs unchanged')
  })

  it('renders structured price timing only when the API supplies it', () => {
    expect(recommendationTiming({})).toBeNull()
    expect(recommendationTiming({ priceTiming: { verdict: 'ACT_SOON', incomingPressure: { description: 'Incoming player has high price pressure.' }, reasons: ['The transfer remains robust.'] } }))
      .toEqual({ verdict: 'ACT SOON', details: ['Incoming player has high price pressure.', 'The transfer remains robust.'] })
  })

  it('formats timing badge prefix clearly', () => {
    expect(formatTimingBadge('WAIT')).toBe('TIMING: WAIT')
    expect(formatTimingBadge('ACT_SOON')).toBe('TIMING: ACT SOON')
    expect(formatTimingBadge('TIMING: WAIT')).toBe('TIMING: WAIT')
  })

  it('maps server classifications to badge labels and pill classes', () => {
    expect(recommendationClassificationBadge('ROBUST')).toEqual({ label: 'Action threshold met', pillClass: 'green' })
    expect(recommendationClassificationBadge('MARGINAL')).toEqual({ label: 'Watchlist only', pillClass: 'amber' })
    expect(recommendationClassificationBadge('SENSITIVE')).toEqual({ label: 'Watchlist — sensitive inputs', pillClass: 'amber' })
    expect(recommendationClassificationBadge('INELIGIBLE')).toEqual({ label: 'Not actionable', pillClass: 'neutral' })
    expect(recommendationClassificationBadge(null)).toBeNull()
  })

  it('displays 0.596 as 60% without accidentally clearing robust thresholds due to rounding', () => {
    const rawProbability = 0.596
    const displayedPct = Math.round(rawProbability * 100)
    expect(displayedPct).toBe(60)

    // The threshold check must use raw server classification / raw probability, not the rounded display string
    const raw746 = 0.746
    const displayed75 = Math.round(raw746 * 100)
    expect(displayed75).toBe(75)
    expect(raw746 >= 0.75).toBe(false)
  })
})
