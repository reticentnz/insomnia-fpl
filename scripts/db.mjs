import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

let dbInstance = null

function ensureEnvLoaded() {
  for (const envFile of ['.env.local', '.env']) {
    const fullEnvPath = path.resolve(process.cwd(), envFile)
    if (fs.existsSync(fullEnvPath)) {
      for (const line of fs.readFileSync(fullEnvPath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
        if (match) {
          process.env[match[1]] = match[2].replace(/^"|"$/g, '')
        }
      }
    }
  }
}

export function getDb(customPath) {
  if (dbInstance) return dbInstance

  ensureEnvLoaded()

  const rawPath = customPath || process.env.DATABASE_URL || 'file:./dev.db'
  const cleanPath = rawPath.replace(/^file:\/\//, '').replace(/^file:/, '')
  const resolvedPath = path.isAbsolute(cleanPath) ? cleanPath : path.resolve(process.cwd(), cleanPath)
  const dir = path.dirname(resolvedPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const sqlite = new DatabaseSync(resolvedPath)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA synchronous = NORMAL;')
  sqlite.exec('PRAGMA foreign_keys = OFF;') // Relax during bulk updates/ingest

  dbInstance = {
    sqlite,
    async query(sql, params = []) {
      // Convert Postgres NOW() to SQLite datetime('now') and $1, $2 to ?
      let querySql = sql
        .replace(/\bNOW\(\)/gi, "datetime('now')")
        .replace(/\$\d+/g, '?')

      const trimmed = querySql.trim().toUpperCase()
      if (
        trimmed.startsWith('CREATE') ||
        trimmed.startsWith('ALTER') ||
        trimmed.startsWith('DROP') ||
        trimmed.startsWith('BEGIN') ||
        trimmed.startsWith('COMMIT') ||
        trimmed.startsWith('ROLLBACK') ||
        trimmed.startsWith('PRAGMA')
      ) {
        sqlite.exec(querySql)
        return { rows: [] }
      }

      const boundParams = params.map(v => {
        if (typeof v === 'boolean') return v ? 1 : 0
        if (v instanceof Date) return v.toISOString()
        return v
      })

      const stmt = sqlite.prepare(querySql)
      if (trimmed.startsWith('SELECT') || trimmed.includes('RETURNING')) {
        const rows = stmt.all(...boundParams)
        return { rows }
      } else {
        const result = stmt.run(...boundParams)
        return { rows: [], changes: result.changes, lastInsertRowid: result.lastInsertRowid }
      }
    },
    async end() {
      sqlite.close()
      dbInstance = null
    }
  }
  return dbInstance
}
