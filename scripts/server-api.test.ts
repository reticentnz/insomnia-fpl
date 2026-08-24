import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { ingestOfficialFpl } from './ingest-fpl.mjs'

const directories: string[] = []
const processes: ChildProcess[] = []
const fixtures = path.resolve('scripts', 'fixtures')
const fixture = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'))

async function waitForServer(process: ChildProcess, baseUrl: string) {
  let output = ''
  process.stdout?.on('data', chunk => { output += String(chunk) })
  process.stderr?.on('data', chunk => { output += String(chunk) })
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Server exited early: ${output}`)
    try { if ((await fetch(`${baseUrl}/api/system-status`)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not become ready: ${output}`)
}

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 2_000)),
      ])
      if (!stopped && child.exitCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    }
  }
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

describe('canonical HTTP API smoke', () => {
  it('serves catalog, compatibility data, markets, and auditable signal writes from a fresh migrated fixture database', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-api-'))
    directories.push(directory)
    const databasePath = path.join(directory, 'database.sqlite')
    await ingestOfficialFpl({ dbPath: databasePath, season: '2026/27', observedAt: '2026-08-10T12:00:00Z', finishedAt: '2026-08-10T12:01:00Z', bootstrap: fixture('wp02-bootstrap.json'), fixtures: fixture('wp02-fixtures.json'), elementSummaries: {} })
    const port = 43000 + Math.floor(Math.random() * 1000)
    const server = spawn(process.execPath, ['--experimental-strip-types', 'scripts/serve.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_URL: `file:${databasePath}`, FPL_SEASON: '2026/27', FPL_INGEST_INTERVAL_HOURS: '876000', ADMIN_TOKEN: 'fixture-admin-token', ODDS_API_KEY: ' ', FPL_CATALOG_CACHE_FILE: path.join(directory, 'catalog-cache.json'), SIGNAL_CONFIG_FILE: path.join(directory, 'signal-config.json'), AI_SETTINGS_FILE: path.join(directory, 'ai-settings.json') }, stdio: ['ignore', 'pipe', 'pipe'] })
    processes.push(server)
    const baseUrl = `http://127.0.0.1:${port}`
    await waitForServer(server, baseUrl)

    const health = await fetch(`${baseUrl}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok', database: 'ready', playerCount: 2 })
    const scheduling = await fetch(`${baseUrl}/api/system-status`).then(response => response.json())
    expect(scheduling).toMatchObject({
      lastIngestedAt: '2026-08-10T12:01:00.000Z',
      nextIngestAt: '2126-07-17T12:01:00.000Z',
      ingestIntervalHours: 876000,
    })
    const admin = await fetch(`${baseUrl}/api/admin/status`).then(response => response.json())
    expect(admin).toMatchObject({ authenticationRequired: true, season: '2026/27', oddsConfigured: false, unresolved: { players: 0, fixtures: 0 } })
    expect(admin.operations).toHaveLength(7)
    expect(admin.operations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'signals-sync' })]))
    expect(admin.feedRuns[0]).toMatchObject({ source: 'OFFICIAL_FPL', status: 'SUCCEEDED' })
    const unauthorizedAdminWrite = await fetch(`${baseUrl}/api/admin/actions/not-real`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(unauthorizedAdminWrite.status).toBe(401)
    const authorizedUnknownAdminWrite = await fetch(`${baseUrl}/api/admin/actions/not-real`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-admin-token' }, body: '{}' })
    expect(authorizedUnknownAdminWrite.status).toBe(404)
    const catalog = await fetch(`${baseUrl}/api/catalog`).then(response => response.json())
    expect(catalog.players).toHaveLength(2)
    expect(catalog.inputHash).toMatch(/^[a-f0-9]{64}$/)
    const clientCatalogResponse = await fetch(`${baseUrl}/api/client-catalog?fixtureHorizon=1`)
    const clientCatalogEtag = clientCatalogResponse.headers.get('etag')
    const clientCatalog = await clientCatalogResponse.json()
    expect(clientCatalog).toMatchObject({ season: '2026/27' })
    expect(clientCatalog.currentGameweek).toBeGreaterThanOrEqual(1)
    expect(clientCatalog.players).toHaveLength(2)
    expect(clientCatalog.players[0].upcomingFixtures).toHaveLength(1)
    expect(clientCatalog.players[0]).not.toHaveProperty('official')
    expect(clientCatalog.players[0]).not.toHaveProperty('provenance')
    expect(JSON.stringify(clientCatalog).length).toBeLessThan(JSON.stringify(catalog).length)
    expect(clientCatalogEtag).toMatch(/^".+"$/)
    const notModified = await fetch(`${baseUrl}/api/client-catalog?fixtureHorizon=1`, { headers: { 'if-none-match': clientCatalogEtag! } })
    expect(notModified.status).toBe(304)
    const compatibility = await fetch(`${baseUrl}/api/fpl-data`).then(response => response.json())
    expect(compatibility.players.map((player: any) => player.id)).toEqual([10, 11])
    const markets = await fetch(`${baseUrl}/api/team-market-snapshots`).then(response => response.json())
    expect(markets.snapshots).toEqual([])

    const removedCreatorWebhook = await fetch(`${baseUrl}/api/signals/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(removedCreatorWebhook.status).toBe(404)

    const createdResponse = await fetch(`${baseUrl}/api/player-signals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: 10, kind: 'START_PROBABILITY', manualOverride: true, evidenceSummary: 'Fixture smoke override', value: { startProbability: .8 } }) })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()).signal
    expect(created).toMatchObject({ playerId: 10, sourceType: 'MANUAL_OVERRIDE', status: 'VERIFIED' })
    const updatedResponse = await fetch(`${baseUrl}/api/player-signals/${encodeURIComponent(created.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'REJECTED' }) })
    expect(updatedResponse.status).toBe(200)
    expect((await updatedResponse.json()).signal.status).toBe('REJECTED')

    const remoteUnauthorized = await fetch(`${baseUrl}/api/remote/signals`)
    expect(remoteUnauthorized.status).toBe(401)
    const pendingResponse = await fetch(`${baseUrl}/api/player-signals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: 11, kind: 'INJURY', evidenceSummary: 'Remote review fixture', confidence: .7, status: 'PENDING' }) })
    expect(pendingResponse.status).toBe(201)
    const pending = (await pendingResponse.json()).signal
    const remoteFeedResponse = await fetch(`${baseUrl}/api/remote/signals?actionableOnly=true`, { headers: { authorization: 'Bearer fixture-admin-token' } })
    expect(remoteFeedResponse.status).toBe(200)
    const remoteFeed = await remoteFeedResponse.json()
    expect(remoteFeed).toMatchObject({ schemaVersion: 1, actionableCount: 1 })
    expect(remoteFeed.findings[0]).toMatchObject({ id: pending.id, actionable: true, suggestedAction: 'APPROVE', state: 'ACTION_REQUIRED' })
    const remoteActionResponse = await fetch(`${baseUrl}/api/remote/actions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-admin-token' }, body: JSON.stringify({ action: 'reject', signalId: pending.id, reason: 'Remote test review' }) })
    expect(remoteActionResponse.status).toBe(200)
    expect((await remoteActionResponse.json()).signals[0]).toMatchObject({ id: pending.id, status: 'REJECTED' })

    const testKey = 'test-provider-key-not-for-production-9x7z'
    const savedKey = await fetch(`${baseUrl}/api/ai-config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'openai', apiKey: testKey }) })
    expect(savedKey.status).toBe(200)
    const keyMetadata = await fetch(`${baseUrl}/api/ai-config`).then(response => response.json())
    expect(keyMetadata).toEqual({ provider: 'openai', configured: true, suffix: '9x7z' })
    expect(JSON.stringify(keyMetadata)).not.toContain(testKey)
    expect(fs.readFileSync(databasePath).includes(Buffer.from(testKey))).toBe(false)
    const settingsStat = fs.statSync(path.join(directory, 'ai-settings.json'))
    expect(settingsStat.isFile()).toBe(true)
    // Windows does not expose POSIX permission bits; chmod is effective and
    // verifiable on the deployment platforms that support them.
    if (process.platform !== 'win32') expect(settingsStat.mode & 0o777).toBe(0o600)

    const wrongContentType = await fetch(`${baseUrl}/api/ask`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
    const wrongContentTypeBody = await wrongContentType.json()
    expect(wrongContentType.status).toBe(415)
    expect(wrongContentTypeBody).toMatchObject({ schemaVersion: 1, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' } })
    expect(wrongContentTypeBody.error.requestId).toBe(wrongContentType.headers.get('x-request-id'))

    const oversized = await fetch(`${baseUrl}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(1_000_001) })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ schemaVersion: 1, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } })
  })
})
