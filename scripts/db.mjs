import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

let dbInstance = null

export function expandSqlParams(sql, params = []) {
  const expanded = []
  let usedNumberedParams = false
  const querySql = sql
    .replace(/\bNOW\(\)/gi, "datetime('now')")
    .replace(/\$(\d+)/g, (_match, rawIndex) => {
      usedNumberedParams = true
      const index = Number(rawIndex) - 1
      if (index < 0 || index >= params.length) throw new RangeError(`Missing SQL parameter $${rawIndex}`)
      expanded.push(params[index])
      return '?'
    })
  return { querySql, params: usedNumberedParams ? expanded : params }
}

function ensureEnvLoaded() {
  for (const envFile of ['.env.local', '.env']) {
    const fullEnvPath = path.resolve(process.cwd(), envFile)
    if (fs.existsSync(fullEnvPath)) {
      for (const line of fs.readFileSync(fullEnvPath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
        if (match && !process.env[match[1]]) {
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
      // Preserve numbered-parameter semantics, including repeated or
      // out-of-order placeholders, while binding through SQLite.
      const expanded = expandSqlParams(sql, params)
      const querySql = expanded.querySql

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

      const boundParams = expanded.params.map(v => {
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
