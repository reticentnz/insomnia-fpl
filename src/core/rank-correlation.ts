export type RankedValue = { name: string; value: number }

/** Spearman's rank correlation for the mutually available player values. */
export function spearmanRankCorrelation(left: RankedValue[], right: RankedValue[]) {
  const leftValues = new Map(left.map(item => [item.name, item.value]))
  const rightValues = new Map(right.map(item => [item.name, item.value]))
  const names = [...leftValues.keys()].filter(name => rightValues.has(name))
  if (names.length < 2) return { correlation: null, sampleSize: names.length, rows: [] as Array<{ name: string; leftRank: number; rightRank: number; difference: number }> }
  const rank = (values: Map<string, number>) => new Map([...names]
    .sort((a, b) => values.get(b)! - values.get(a)! || a.localeCompare(b))
    .map((name, index) => [name, index + 1]))
  const leftRank = rank(leftValues), rightRank = rank(rightValues)
  const rows = names.map(name => ({ name, leftRank: leftRank.get(name)!, rightRank: rightRank.get(name)!, difference: leftRank.get(name)! - rightRank.get(name)! }))
  const sumSquaredDifferences = rows.reduce((total, row) => total + row.difference ** 2, 0)
  const n = rows.length
  return { correlation: 1 - 6 * sumSquaredDifferences / (n * (n ** 2 - 1)), sampleSize: n, rows }
}
