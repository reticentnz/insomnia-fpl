export class ConcurrencyLimiter {
  private active = 0
  private readonly pending: Array<() => void> = []
  private readonly limit: number

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency limit must be a positive integer')
    this.limit = limit
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.pending.push(resolve))
    this.active += 1
    try {
      return await operation()
    } finally {
      this.active -= 1
      this.pending.shift()?.()
    }
  }
}

export class TtlCache<T> {
  private readonly values = new Map<string, { value: T; expiresAt: number }>()
  private readonly ttlMs: number
  private readonly now: () => number
  constructor(ttlMs: number, now = () => Date.now()) { this.ttlMs = ttlMs; this.now = now }
  get(key: string): T | null {
    const item = this.values.get(key)
    if (!item || item.expiresAt <= this.now()) return null
    return item.value
  }
  set(key: string, value: T) { this.values.set(key, { value, expiresAt: this.now() + this.ttlMs }) }
}
