import { listPlayerSignals } from './signal-service.ts'

type Database = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
type SignalRecord = Awaited<ReturnType<typeof listPlayerSignals>>[number]

export type RemoteSignalFinding = SignalRecord & {
  actionable: boolean
  suggestedAction: 'APPROVE' | 'REJECT' | null
  state: 'ACTION_REQUIRED' | 'ACTIVE' | 'CLOSED'
}

function finding(signal: SignalRecord): RemoteSignalFinding {
  const actionable = signal.status === 'PENDING'
  return {
    ...signal,
    actionable,
    suggestedAction: actionable ? 'APPROVE' : null,
    state: actionable ? 'ACTION_REQUIRED' : signal.status === 'VERIFIED' ? 'ACTIVE' : 'CLOSED',
  }
}

export async function getRemoteSignalFeed(db: Database, options: {
  status?: string | null
  playerId?: string | number | null
  since?: string | null
  actionableOnly?: boolean
  limit?: number
} = {}) {
  const limit = Math.min(500, Math.max(1, Number(options.limit) || 100))
  const rows = await listPlayerSignals(db, {
    status: options.status || null,
    playerId: options.playerId ?? null,
    limit: 500,
  })
  const since = options.since ? Date.parse(options.since) : NaN
  if (options.since && !Number.isFinite(since)) throw new Error('since must be a valid timestamp')
  const findings = rows
    .filter(signal => !Number.isFinite(since) || Date.parse(signal.observedAt) > since)
    .map(finding)
    .filter(signal => !options.actionableOnly || signal.actionable)
    .slice(0, limit)
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    count: findings.length,
    actionableCount: findings.filter(signal => signal.actionable).length,
    findings,
  }
}
