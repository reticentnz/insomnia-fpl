import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CatalogueCache, catalogueCacheKey, catalogueRequestKey } from './catalog-cache.ts'
import { ConcurrencyLimiter, TtlCache } from './upstream-control.ts'

const directories: string[] = []
afterEach(() => { while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true }) })

describe('WP-14 catalogue cache', () => {
  it('uses keyed memory entries inside the TTL and invalidates when input versions differ', async () => {
    let now = Date.parse('2026-08-15T12:00:00Z')
    const cache = new CatalogueCache<{ observation: string }>({ ttlMs: 60_000, now: () => now })
    const request = catalogueRequestKey({ season: '2026/27' })
    const first = catalogueCacheKey(request, { official: ['run-a'], signals: ['a'], model: 'v1' })
    const changed = catalogueCacheKey(request, { official: ['run-a'], signals: ['b'], model: 'v1' })
    await cache.put(first, request, { observation: '2026-08-15T11:00:00Z' })
    expect(cache.get(first)).toEqual({ observation: '2026-08-15T11:00:00Z' })
    expect(cache.get(changed)).toBeNull()
    now += 60_001
    expect(cache.get(first)).toBeNull()
  })

  it('serves an eligible restart cache as stale without changing payload timestamps and rejects over-age cache', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-cache-'))
    directories.push(directory)
    let now = Date.parse('2026-08-15T12:00:00Z')
    const filePath = path.join(directory, 'catalog.json')
    const request = catalogueRequestKey({ season: '2026/27' })
    const otherRequest = catalogueRequestKey({ season: '2025/26' })
    const writing = new CatalogueCache<{ freshness: { official: { observedAt: string } } }>({ filePath, maxStaleMs: 86_400_000, now: () => now })
    await writing.put('key', request, { freshness: { official: { observedAt: '2026-08-15T10:00:00Z' } } })
    await writing.put('other-key', otherRequest, { freshness: { official: { observedAt: '2025-08-15T10:00:00Z' } } })
    const restarted = new CatalogueCache<{ freshness: { official: { observedAt: string } } }>({ filePath, maxStaleMs: 86_400_000, now: () => now })
    expect(await restarted.getRestart(request)).toEqual({ freshness: { official: { observedAt: '2026-08-15T10:00:00Z' } } })
    expect(await restarted.getRestart(otherRequest)).toEqual({ freshness: { official: { observedAt: '2025-08-15T10:00:00Z' } } })
    now += 86_400_001
    expect(await restarted.getRestart(request)).toBeNull()
  })

  it('bounds persisted restart entries and replaces obsolete revisions of the same request', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-cache-'))
    directories.push(directory)
    const filePath = path.join(directory, 'catalog.json')
    let now = Date.parse('2026-08-15T12:00:00Z')
    const cache = new CatalogueCache<{ revision: number }>({ filePath, maxRestartEntries: 3, now: () => now })
    const live = catalogueRequestKey({})
    const historic = catalogueRequestKey({ season: '2025/26' })
    await cache.put('live-v1', live, { revision: 1 })
    now += 1
    await cache.put('live-v2', live, { revision: 2 })
    now += 1
    await cache.put('historic-v1', historic, { revision: 3 })
    now += 1
    await cache.put('third-v1', catalogueRequestKey({ season: '2024/25' }), { revision: 4 })
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect(Object.keys(stored.entries)).toHaveLength(3)
    expect(stored.entries['live-v2'].payload).toEqual({ revision: 2 })
    expect(stored.entries['live-v1']).toBeUndefined()
  })
})

describe('WP-14 upstream control', () => {
  it('never starts more than five upstream requests concurrently', async () => {
    const limiter = new ConcurrencyLimiter(5)
    let active = 0
    let maximum = 0
    await Promise.all(Array.from({ length: 30 }, (_, id) => limiter.run(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active -= 1
      return id
    })))
    expect(maximum).toBe(5)
  })

  it('keeps league responses for five minutes', () => {
    let now = 0
    const cache = new TtlCache<string>(300_000, () => now)
    cache.set('league:1', 'sample')
    expect(cache.get('league:1')).toBe('sample')
    now = 300_000
    expect(cache.get('league:1')).toBeNull()
  })
})
