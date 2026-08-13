export const DEFAULT_INGEST_INTERVAL_HOURS = 12

export function parseIngestIntervalHours(value: unknown, defaultHours = DEFAULT_INGEST_INTERVAL_HOURS) {
  const hours = Number.parseFloat(String(value ?? defaultHours))
  return Number.isFinite(hours) && hours > 0 ? hours : 0
}

export function nextIngestSchedule(
  lastSuccessfulAt: string | null | undefined,
  intervalHours: number,
  now = Date.now(),
  notBefore = 0,
) {
  if (!(intervalHours > 0)) return null
  const lastSuccessfulMs = lastSuccessfulAt ? Date.parse(lastSuccessfulAt) : Number.NaN
  const intervalMs = intervalHours * 60 * 60 * 1000
  const nominalNextMs = Number.isFinite(lastSuccessfulMs)
    ? lastSuccessfulMs + intervalMs
    : now
  const nextMs = Math.max(now, nominalNextMs, notBefore)
  return {
    lastIngestedAt: Number.isFinite(lastSuccessfulMs)
      ? new Date(lastSuccessfulMs).toISOString()
      : null,
    nextIngestAt: new Date(nextMs).toISOString(),
    delayMs: Math.max(0, nextMs - now),
  }
}
