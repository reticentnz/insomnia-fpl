import { describe, expect, it } from 'vitest'
import { spearmanRankCorrelation } from './rank-correlation.ts'

describe('spearmanRankCorrelation', () => {
  it('returns one for matching player order and only compares the shared set', () => {
    const result = spearmanRankCorrelation(
      [{ name: 'A', value: 5 }, { name: 'B', value: 4 }, { name: 'C', value: 3 }],
      [{ name: 'A', value: 8 }, { name: 'B', value: 2 }, { name: 'C', value: 1 }, { name: 'D', value: 9 }],
    )
    expect(result).toMatchObject({ correlation: 1, sampleSize: 3 })
  })
})
