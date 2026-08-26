import fs from 'node:fs/promises'
import path from 'node:path'
import { projectCatalogFixture } from '../src/server/forecast-service.ts'
import { MODEL_VERSION } from '../src/core/projection.ts'
import { spearmanRankCorrelation } from '../src/core/rank-correlation.ts'

type Catalog = { asOf: string; players: any[] }

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}
const catalogFile = option('--catalog-file')
const catalogUrl = option('--catalog-url')
const writeCatalog = option('--write-catalog')
const benchmarkFile = option('--benchmark-file') || 'scripts/fixtures/solio-gw02-2026-08-26.json'
const gameweekArg = Number(option('--gameweek'))
if (!catalogFile && !catalogUrl) throw new Error('Use --catalog-file <snapshot.json> or --catalog-url <http://.../api/catalog>.')
if (catalogFile && catalogUrl) throw new Error('Use one catalog source at a time.')

const raw = catalogFile
  ? await fs.readFile(path.resolve(catalogFile), 'utf8')
  : await (await fetch(catalogUrl!)).text()
const catalog = JSON.parse(raw) as Catalog
if (!Array.isArray(catalog.players) || !catalog.players.length) throw new Error('Catalog contains no players.')
if (writeCatalog) await fs.writeFile(path.resolve(writeCatalog), `${JSON.stringify(catalog)}\n`, 'utf8')

const futureFixtures = catalog.players.flatMap(player => player.fixtures || [])
  .filter((fixture: any) => fixture.gameweekFplId && fixture.kickoffAt && Date.parse(fixture.kickoffAt) >= Date.parse(catalog.asOf))
const gameweek = Number.isFinite(gameweekArg) && gameweekArg > 0
  ? gameweekArg
  : Math.min(...futureFixtures.map((fixture: any) => Number(fixture.gameweekFplId)))
if (!Number.isFinite(gameweek)) throw new Error('Could not determine a target gameweek.')
const completedGameweeks = Math.max(0, gameweek - 1)
const projectedCandidates = catalog.players.flatMap(player => {
  const fixture = (player.fixtures || []).find((item: any) =>
    Number(item.gameweekFplId) === gameweek && item.kickoffAt && Date.parse(item.kickoffAt) >= Date.parse(catalog.asOf),
  )
  if (!fixture) return []
  const row = projectCatalogFixture(player, fixture, catalog as any, { forecastRunId: 'local-replay', modelVersion: MODEL_VERSION, completedGameweeks })
  // Calibrate ranks to the model's deterministic expected value. The stored
  // forecast also contains a simulated mean for risk/percentiles, but using a
  // finite Monte Carlo sample here makes the calibration score change merely
  // because the model version changes its simulation seed.
  const value = row.appearancePoints + row.goalPoints + row.assistPoints + row.cleanSheetPoints
    + row.goalsConcededPoints + row.savePoints + row.penaltyPoints + row.defensiveContributionPoints
    + row.bonusPoints + row.cardPoints
  return [{ name: player.name, value }]
})
// Solio's public table uses abbreviated/surname display names. The catalogue
// legitimately contains duplicates (notably multiple Palmers), so do not let a
// later low-minute namesake overwrite the relevant FPL asset. In the absence of
// FPL IDs in the published table, the highest viable projection is the least
// assumption-heavy deterministic match and mirrors the public-list convention.
const projected = [...projectedCandidates.reduce((byName, item) => {
  const current = byName.get(item.name)
  if (!current || item.value > current.value) byName.set(item.name, item)
  return byName
}, new Map<string, { name: string; value: number }>()).values()]
const solio = JSON.parse(await fs.readFile(path.resolve(benchmarkFile), 'utf8'))
const benchmark = (solio.playerExpectedPoints as Array<[string, number]>).map(([name, value]) => ({ name, value }))
const result = spearmanRankCorrelation(projected, benchmark)
const projectedByName = new Map(projected.map(item => [item.name, item.value]))
const rows = result.rows
  .map(row => ({ ...row, localPoints: projectedByName.get(row.name)!, solioPoints: benchmark.find(item => item.name === row.name)!.value }))
  .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))
console.log(JSON.stringify({ modelVersion: MODEL_VERSION, catalogAsOf: catalog.asOf, gameweek, benchmarkCapturedAt: solio.capturedAt, spearman: result.correlation, sampleSize: result.sampleSize, largestRankDifferences: rows.slice(0, 12) }, null, 2))
