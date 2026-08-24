import { MODEL_VERSION } from '../model.ts'
import { assembleProjectionInputCatalog } from './catalog-service.ts'
import { createForecastRun, DEFAULT_MAX_GAMEWEEKS } from './forecast-service.ts'

type Database = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

export type ForecastRefreshReason = 'manual' | 'official' | 'underlying' | 'market' | 'signal'
export type ForecastRefreshResult = {
  status: 'CREATED' | 'UNCHANGED' | 'FAILED'
  reason: ForecastRefreshReason[]
  checkedAt: string
  inputHash?: string
  previousRunId?: string | null
  forecastRunId?: string
  error?: string
}

/**
 * Rebuild only when the current *semantic* catalogue state differs from the
 * latest compatible forecast. ForecastRun remains append-only: a changed input
 * creates a new row, while a no-op refresh records no forecast at all.
 */
export async function refreshForecastIfInputsChanged(
  db: Database,
  options: { reasons?: ForecastRefreshReason[]; asOf?: string | Date; maxGameweeks?: number; modelVersion?: string } = {},
): Promise<ForecastRefreshResult> {
  const checkedAt = options.asOf instanceof Date
    ? options.asOf.toISOString()
    : new Date(options.asOf || Date.now()).toISOString()
  const requestedReasons: ForecastRefreshReason[] = options.reasons?.length ? options.reasons : ['manual']
  const reasons = [...new Set<ForecastRefreshReason>(requestedReasons)]
  const maxGameweeks = options.maxGameweeks ?? DEFAULT_MAX_GAMEWEEKS
  const modelVersion = options.modelVersion ?? MODEL_VERSION
  try {
    const catalog = await assembleProjectionInputCatalog(db, { asOf: checkedAt })
    const previous = await db.query(
      `SELECT "id", "input_hash" FROM "ForecastRun"
       WHERE "status"='SUCCEEDED' AND "model_version"=$1 AND "max_gameweeks"=$2
       ORDER BY datetime("created_at") DESC, "id" DESC LIMIT 1`,
      [modelVersion, maxGameweeks],
    )
    const previousRun = previous.rows[0] || null
    if (previousRun?.input_hash === catalog.inputHash) {
      return { status: 'UNCHANGED', reason: reasons, checkedAt, inputHash: catalog.inputHash, previousRunId: previousRun.id }
    }
    const result = await createForecastRun(db, {
      asOf: checkedAt,
      createdAt: checkedAt,
      maxGameweeks,
      modelVersion,
      config: {
        recompute: {
          reasons,
          checkedAt,
          previousRunId: previousRun?.id || null,
          previousInputHash: previousRun?.input_hash || null,
          changedInputHash: catalog.inputHash,
        },
      },
    })
    if (result.status === 'FAILED') return { status: 'FAILED', reason: reasons, checkedAt, inputHash: catalog.inputHash, previousRunId: previousRun?.id || null, forecastRunId: result.id, error: result.error }
    return { status: 'CREATED', reason: reasons, checkedAt, inputHash: result.inputHash, previousRunId: previousRun?.id || null, forecastRunId: result.id }
  } catch (error) {
    return { status: 'FAILED', reason: reasons, checkedAt, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Coalesces refresh events in one server process into a single state check. */
export class ForecastRefreshCoordinator {
  private running = false
  private queued = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private reasons = new Set<ForecastRefreshReason>()
  private readonly work: (reasons: ForecastRefreshReason[]) => Promise<ForecastRefreshResult>
  private readonly debounceMs: number

  constructor(
    work: (reasons: ForecastRefreshReason[]) => Promise<ForecastRefreshResult>,
    debounceMs = 3_000,
  ) {
    this.work = work
    this.debounceMs = debounceMs
  }

  request(reason: ForecastRefreshReason) {
    const idle = !this.running && !this.timer
    this.reasons.add(reason)
    this.queued = true
    if (!this.running && !this.timer) this.timer = setTimeout(() => void this.drain(), this.debounceMs)
    return { status: idle ? 'started' as const : 'queued' as const }
  }

  private async drain() {
    this.timer = null
    if (this.running || !this.queued) return
    this.running = true
    try {
      while (this.queued) {
        this.queued = false
        const reasons = [...this.reasons]
        this.reasons.clear()
        await this.work(reasons)
      }
    } finally {
      this.running = false
      if (this.queued && !this.timer) this.timer = setTimeout(() => void this.drain(), this.debounceMs)
    }
  }
}
