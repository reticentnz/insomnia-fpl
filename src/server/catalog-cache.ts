import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export type CatalogueCacheState = 'FRESH' | 'STALE' | 'MISS'

export type RestartCatalogueEntry<T> = {
  schemaVersion: 1
  key: string
  requestKey: string
  cachedAt: string
  payload: T
}

type RestartCatalogueFile<T> = { schemaVersion: 1; entries: Record<string, RestartCatalogueEntry<T>> }

export type CatalogueCacheOptions = {
  ttlMs?: number
  maxStaleMs?: number
  filePath?: string
  now?: () => number
}

const defaultNow = () => Date.now()

/** Server-side cache for successful catalogue assembly only. */
export class CatalogueCache<T> {
  private readonly entries = new Map<string, { cachedAt: number; payload: T }>()
  private readonly ttlMs: number
  private readonly maxStaleMs: number
  private readonly filePath?: string
  private readonly now: () => number

  constructor(options: CatalogueCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? Number(process.env.FPL_CATALOG_CACHE_TTL_MS || 60_000)
    this.maxStaleMs = options.maxStaleMs ?? Number(process.env.FPL_CATALOG_CACHE_MAX_STALE_MS || 86_400_000)
    this.filePath = options.filePath
    this.now = options.now || defaultNow
  }

  get(key: string): T | null {
    const entry = this.entries.get(key)
    if (!entry || this.now() - entry.cachedAt > this.ttlMs) return null
    return entry.payload
  }

  async put(key: string, requestKey: string, payload: T) {
    const cachedAt = this.now()
    this.entries.set(key, { cachedAt, payload })
    if (!this.filePath) return
    const entry: RestartCatalogueEntry<T> = { schemaVersion: 1, key, requestKey, cachedAt: new Date(cachedAt).toISOString(), payload }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    let entries: Record<string, RestartCatalogueEntry<T>> = {}
    try {
      const existing = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as RestartCatalogueFile<T>
      if (existing.schemaVersion === 1 && existing.entries) entries = existing.entries
    } catch { /* first successful catalogue write */ }
    entries[key] = entry
    const temporaryPath = `${this.filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    await fs.writeFile(temporaryPath, `${JSON.stringify({ schemaVersion: 1, entries } satisfies RestartCatalogueFile<T>)}\n`, 'utf8')
    await fs.rename(temporaryPath, this.filePath)
  }

  async getRestart(requestKey: string): Promise<T | null> {
    if (!this.filePath) return null
    try {
      const file = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as RestartCatalogueFile<T>
      if (file.schemaVersion !== 1 || !file.entries) return null
      const eligible = Object.values(file.entries)
        .filter(entry => entry.schemaVersion === 1 && entry.requestKey === requestKey)
        .map(entry => ({ entry, cachedAt: Date.parse(entry.cachedAt) }))
        .filter(({ cachedAt }) => Number.isFinite(cachedAt) && this.now() - cachedAt <= this.maxStaleMs)
        .sort((left, right) => right.cachedAt - left.cachedAt)
      return eligible[0]?.entry.payload || null
    } catch {
      return null
    }
  }
}

export function catalogueRequestKey(options: { season?: string | null; asOf?: string | null }) {
  return JSON.stringify({ season: options.season || null, asOf: options.asOf || null })
}

export function catalogueCacheKey(requestKey: string, inputVersions: unknown) {
  return createHash('sha256').update(`${requestKey}\u0000${JSON.stringify(inputVersions)}`).digest('hex')
}
