import fs from 'node:fs/promises'
import path from 'node:path'
import { projectCatalogFixture } from '../src/server/forecast-service.ts'
import { MODEL_VERSION } from '../src/core/projection.ts'
import { spearmanRankCorrelation } from '../src/core/rank-correlation.ts'
import { selectLineup, type StoredForecast } from '../src/core/lineup.ts'

type Catalog = { asOf: string; players: any[] }
type ProjectedPlayer = { id: string; name: string; position: 'GK' | 'DEF' | 'MID' | 'FWD'; value: number; startProbability: number; noShowProbability: number; setPieceRole: string | null; roleSignalCount: number }

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
// The client cache retains full catalog snapshots under entries.  Accepting it
// directly makes a replay reproducible without copying a mutable API response
// into a second, easy-to-forget file.
const parsed = JSON.parse(raw)
const catalog = (Array.isArray(parsed.players)
  ? parsed
  : Object.values(parsed.entries || {}).map((entry: any) => entry.payload).filter((payload: any) => Array.isArray(payload?.players)).sort((a: Catalog, b: Catalog) => Date.parse(b.asOf) - Date.parse(a.asOf))[0]) as Catalog
if (!Array.isArray(catalog.players) || !catalog.players.length) throw new Error('Catalog contains no players.')
if (writeCatalog) await fs.writeFile(path.resolve(writeCatalog), `${JSON.stringify(catalog)}\n`, 'utf8')

const futureFixtures = catalog.players.flatMap(player => player.fixtures || [])
  .filter((fixture: any) => fixture.gameweekFplId && fixture.kickoffAt && Date.parse(fixture.kickoffAt) >= Date.parse(catalog.asOf))
const gameweek = Number.isFinite(gameweekArg) && gameweekArg > 0
  ? gameweekArg
  : Math.min(...futureFixtures.map((fixture: any) => Number(fixture.gameweekFplId)))
if (!Number.isFinite(gameweek)) throw new Error('Could not determine a target gameweek.')
const completedGameweeks = Math.max(0, gameweek - 1)
const projectedPlayers = catalog.players.flatMap(player => {
  const fixture = (player.fixtures || []).find((item: any) =>
    Number(item.gameweekFplId) === gameweek && item.kickoffAt && Date.parse(item.kickoffAt) >= Date.parse(catalog.asOf),
  )
  if (!fixture) return []
  const row = projectCatalogFixture(player, fixture, catalog as any, { forecastRunId: 'local-replay', modelVersion: MODEL_VERSION, completedGameweeks, deterministic: true })
  // Calibrate ranks to the model's deterministic expected value. The stored
  // forecast also contains a simulated mean for risk/percentiles, but using a
  // finite Monte Carlo sample here makes the calibration score change merely
  // because the model version changes its simulation seed.
  const value = row.appearancePoints + row.goalPoints + row.assistPoints + row.cleanSheetPoints
    + row.goalsConcededPoints + row.savePoints + row.penaltyPoints + row.defensiveContributionPoints
    + row.bonusPoints + row.cardPoints
  const position = String(player.official?.position || '').toUpperCase()
  if (!['GK', 'DEF', 'MID', 'FWD'].includes(position)) return []
  const role = row.startProbability + row.substituteProbability
  const roleSignals = Array.isArray(player.roleSignals) ? player.roleSignals : []
  const setPieceRole = roleSignals.some((signal: any) => signal.kind === 'PENALTIES' || signal.kind === 'SET_PIECES' || signal.value?.setPieceRole)
    ? roleSignals.find((signal: any) => signal.value?.setPieceRole)?.value?.setPieceRole || (roleSignals.some((signal: any) => signal.kind === 'PENALTIES') ? 'PENALTIES' : 'SET_PIECES')
    : null
  return [{ id: String(player.fplId ?? player.id), name: player.name, position: position as ProjectedPlayer['position'], value, startProbability: row.startProbability, noShowProbability: Math.max(0, 1 - role), setPieceRole, roleSignalCount: roleSignals.length }]
})
// Solio's public table uses abbreviated/surname display names. The catalogue
// legitimately contains duplicates (notably multiple Palmers), so do not let a
// later low-minute namesake overwrite the relevant FPL asset. In the absence of
// FPL IDs in the published table, the highest viable projection is the least
// assumption-heavy deterministic match and mirrors the public-list convention.
const projected = [...projectedPlayers.reduce((byName, item) => {
  const current = byName.get(item.name)
  if (!current || item.value > current.value) byName.set(item.name, item)
  return byName
}, new Map<string, ProjectedPlayer>()).values()]
const solio = JSON.parse(await fs.readFile(path.resolve(benchmarkFile), 'utf8'))
const benchmark = (solio.playerExpectedPoints as Array<[string, number]>).map(([name, value]) => ({ name, value }))
const result = spearmanRankCorrelation(projected, benchmark)
const projectedByName = new Map(projected.map(item => [item.name, item.value]))
const benchmarkByName = new Map(benchmark.map((item, index) => [item.name, { ...item, rank: index + 1 }]))
const rows = result.rows
  .map(row => ({ ...row, localPoints: projectedByName.get(row.name)!, solioPoints: benchmark.find(item => item.name === row.name)!.value }))
  .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))

const rankByName = new Map(result.rows.map(row => [row.name, row.leftRank]))
const captainCandidates = [...projected]
  .sort((a, b) => (b.value * (1 - b.noShowProbability)) - (a.value * (1 - a.noShowProbability)) || a.name.localeCompare(b.name))
  .slice(0, 5)
  .map(player => ({ name: player.name, localPoints: player.value, localRank: rankByName.get(player.name) ?? null, solioRank: benchmarkByName.get(player.name)?.rank ?? null, solioPoints: benchmarkByName.get(player.name)?.value ?? null, setPieceRole: player.setPieceRole, roleSignalCount: player.roleSignalCount }))

// selectLineup enumerates legal formations.  For a global (not squad-bound)
// XI, a player below the top positional maximum can never be selected, so
// trim first rather than constructing millions of dominated combinations.
const positionalLimits: Record<ProjectedPlayer['position'], number> = { GK: 1, DEF: 5, MID: 5, FWD: 3 }
const lineupPool = (Object.keys(positionalLimits) as ProjectedPlayer['position'][]).flatMap(position => projected
  .filter(player => player.position === position)
  .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
  .slice(0, positionalLimits[position]))
const lineupRows: StoredForecast[] = lineupPool.map(player => ({
  playerId: player.id, gameweekId: String(gameweek), position: player.position, meanPoints: player.value,
  standardDeviation: 0, p10Points: player.value, p50Points: player.value, p90Points: player.value,
  startProbability: player.startProbability, noShowProbability: player.noShowProbability,
}))
const lineup = selectLineup(lineupRows)
const projectedById = new Map(projected.map(player => [player.id, player]))
const describeSelection = (id: string | null) => id ? (() => {
  const player = projectedById.get(id)!
  return { name: player.name, position: player.position, localPoints: player.value, localRank: rankByName.get(player.name) ?? null, solioRank: benchmarkByName.get(player.name)?.rank ?? null, solioPoints: benchmarkByName.get(player.name)?.value ?? null, setPieceRole: player.setPieceRole, roleSignalCount: player.roleSignalCount }
})() : null
const startingXI = lineup.starters.map(id => describeSelection(id))
const benchmarkedCaptainCount = captainCandidates.filter(candidate => candidate.solioRank != null).length
const benchmarkedXiCount = startingXI.filter(player => player?.solioRank != null).length
const maxRankRegression = Math.max(0, ...result.rows.map(row => row.difference))
const thresholds = solio.replayAssertions || { minSpearman: 0, maxRankRegression: Infinity, minBenchmarkedCaptainCandidates: 0, minBenchmarkedXIPlayers: 0 }
const assertions = {
  validFormation: lineup.starters.length === 11 && new Set(lineup.starters).size === 11,
  captainCandidatesCoveredByBenchmark: benchmarkedCaptainCount >= thresholds.minBenchmarkedCaptainCandidates,
  startingXICoveredByBenchmark: benchmarkedXiCount >= thresholds.minBenchmarkedXIPlayers,
  minimumRankCorrelation: result.correlation >= thresholds.minSpearman,
  noMaterialRankRegression: maxRankRegression <= thresholds.maxRankRegression,
}
const passed = Object.values(assertions).every(Boolean)
const materialRankThreshold = thresholds.materialRankDifference ?? 8
const projectedByNameRow = new Map(projected.map(player => [player.name, player]))
const materialRankRegressions = rows.filter(row => row.difference >= materialRankThreshold).map(row => {
  const player = projectedByNameRow.get(row.name)
  return { ...row, setPieceRole: player?.setPieceRole ?? null, roleSignalCount: player?.roleSignalCount ?? 0, attributableToLatestRoleOrSetPieceSignal: Boolean(player?.setPieceRole || player?.roleSignalCount) }
})
const report = {
  modelVersion: MODEL_VERSION, catalogAsOf: catalog.asOf, gameweek, benchmarkCapturedAt: solio.capturedAt,
  spearman: result.correlation, sampleSize: result.sampleSize, assertions, passed,
  topCaptainCandidates: captainCandidates,
  optimalStartingXI: { formation: lineup.starters.map(id => projectedById.get(id)!.position).reduce((counts, position) => ({ ...counts, [position]: (counts[position] || 0) + 1 }), {} as Record<string, number>), players: startingXI, captain: describeSelection(lineup.captainId), viceCaptain: describeSelection(lineup.viceCaptainId) },
  materialRankRegressions,
  largestRankDifferences: rows.slice(0, 12),
}
console.log(JSON.stringify(report, null, 2))
if (option('--assert') && !passed) throw new Error(`Solio replay assertions failed: ${Object.entries(assertions).filter(([, value]) => !value).map(([name]) => name).join(', ')}`)
