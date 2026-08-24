import { describe, expect, it } from 'vitest'
import { formatAccounting, recommendationInputStatus, recommendationSensitivity, recommendationTiming } from './recommendation-presentation.ts'

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
})
