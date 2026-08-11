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

afterEach(() => {
  for (const process of processes.splice(0)) process.kill('SIGTERM')
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('canonical HTTP API smoke', () => {
  it('serves catalog, compatibility data, markets, and auditable signal writes from a fresh migrated fixture database', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-api-'))
    directories.push(directory)
    const databasePath = path.join(directory, 'database.sqlite')
    await ingestOfficialFpl({ dbPath: databasePath, season: '2026/27', observedAt: '2026-08-10T12:00:00Z', bootstrap: fixture('wp02-bootstrap.json'), fixtures: fixture('wp02-fixtures.json'), elementSummaries: {} })
    const port = 43000 + Math.floor(Math.random() * 1000)
    const server = spawn(process.execPath, ['--experimental-strip-types', 'scripts/serve.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_URL: `file:${databasePath}`, FPL_SEASON: '2026/27', FPL_INGEST_INTERVAL_HOURS: '0', FPL_CATALOG_CACHE_FILE: path.join(directory, 'catalog-cache.json'), SIGNAL_CONFIG_FILE: path.join(directory, 'signal-config.json'), AI_SETTINGS_FILE: path.join(directory, 'ai-settings.json') }, stdio: ['ignore', 'pipe', 'pipe'] })
    processes.push(server)
    const baseUrl = `http://127.0.0.1:${port}`
    await waitForServer(server, baseUrl)

    const catalog = await fetch(`${baseUrl}/api/catalog`).then(response => response.json())
    expect(catalog.players).toHaveLength(2)
    expect(catalog.inputHash).toMatch(/^[a-f0-9]{64}$/)
    const compatibility = await fetch(`${baseUrl}/api/fpl-data`).then(response => response.json())
    expect(compatibility.players.map((player: any) => player.id)).toEqual([10, 11])
    const markets = await fetch(`${baseUrl}/api/team-market-snapshots`).then(response => response.json())
    expect(markets.snapshots).toEqual([])

    const createdResponse = await fetch(`${baseUrl}/api/player-signals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: 10, kind: 'START_PROBABILITY', manualOverride: true, evidenceSummary: 'Fixture smoke override', value: { startProbability: .8 } }) })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()).signal
    expect(created).toMatchObject({ playerId: 10, sourceType: 'MANUAL_OVERRIDE', status: 'VERIFIED' })
    const updatedResponse = await fetch(`${baseUrl}/api/player-signals/${encodeURIComponent(created.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'REJECTED' }) })
    expect(updatedResponse.status).toBe(200)
    expect((await updatedResponse.json()).signal.status).toBe('REJECTED')

    const testKey = 'test-provider-key-not-for-production-9x7z'
    const savedKey = await fetch(`${baseUrl}/api/ai-config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'openai', apiKey: testKey }) })
    expect(savedKey.status).toBe(200)
    const keyMetadata = await fetch(`${baseUrl}/api/ai-config`).then(response => response.json())
    expect(keyMetadata).toEqual({ provider: 'openai', configured: true, suffix: '9x7z' })
    expect(JSON.stringify(keyMetadata)).not.toContain(testKey)
    expect(fs.readFileSync(databasePath).includes(Buffer.from(testKey))).toBe(false)
    expect(fs.statSync(path.join(directory, 'ai-settings.json')).mode & 0o777).toBe(0o600)

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
