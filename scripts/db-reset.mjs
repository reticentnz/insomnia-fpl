import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb, resolveDatabasePath } from './db.mjs'

const confirmationFlag = '--yes-reset-development-data'

function containsUnresolvedVariable(value) {
  return /\$\{?[A-Z_][A-Z0-9_]*\}?|%[A-Z_][A-Z0-9_]*%/.test(value)
}

function isWithin(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function assertSafeResetPath(databasePath, rawDatabaseUrl) {
  if (containsUnresolvedVariable(rawDatabaseUrl)) throw new Error('Refusing reset: DATABASE_URL contains an unresolved environment variable')
  if (process.env.APP_DATA_DIR && containsUnresolvedVariable(process.env.APP_DATA_DIR)) throw new Error('Refusing reset: APP_DATA_DIR contains an unresolved environment variable')
  if (databasePath === ':memory:') throw new Error('Refusing reset: in-memory database path is unsafe')

  const repositoryRoot = path.resolve(process.cwd())
  const homeDirectory = path.resolve(os.homedir())
  const configuredDataRoot = process.env.APP_DATA_DIR
    ? path.resolve(process.cwd(), process.env.APP_DATA_DIR)
    : path.join(repositoryRoot, 'data')
  const normalizedDatabasePath = path.resolve(databasePath)

  if (normalizedDatabasePath === path.parse(normalizedDatabasePath).root) throw new Error('Refusing reset: filesystem root is unsafe')
  if (normalizedDatabasePath === homeDirectory) throw new Error('Refusing reset: home directory is unsafe')
  if (normalizedDatabasePath === repositoryRoot) throw new Error('Refusing reset: repository root is unsafe')
  if (!isWithin(repositoryRoot, normalizedDatabasePath) && !isWithin(configuredDataRoot, normalizedDatabasePath)) {
    throw new Error('Refusing reset: database path is outside the repository or configured application data directory')
  }
  if (fs.existsSync(normalizedDatabasePath) && fs.statSync(normalizedDatabasePath).isDirectory()) {
    throw new Error('Refusing reset: database path resolves to a directory')
  }
  if (!['.db', '.sqlite', '.sqlite3'].includes(path.extname(normalizedDatabasePath).toLowerCase())) {
    throw new Error('Refusing reset: database path must use a .db, .sqlite or .sqlite3 extension')
  }
  if (fs.existsSync(normalizedDatabasePath) && fs.statSync(normalizedDatabasePath).size > 0) {
    const descriptor = fs.openSync(normalizedDatabasePath, 'r')
    try {
      const header = Buffer.alloc(16)
      fs.readSync(descriptor, header, 0, header.length, 0)
      if (header.toString('utf8') !== 'SQLite format 3\u0000') {
        throw new Error('Refusing reset: existing target is not a SQLite database')
      }
    } finally {
      fs.closeSync(descriptor)
    }
  }

  return normalizedDatabasePath
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename) && !process.argv.slice(2).includes(confirmationFlag)) {
  console.error(`db-reset requires ${confirmationFlag}`)
  process.exitCode = 1
} else if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    const rawDatabaseUrl = process.env.DATABASE_URL || 'file:./dev.db'
    const databasePath = assertSafeResetPath(resolveDatabasePath(), rawDatabaseUrl)
    await closeDb()
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      fs.rmSync(file, { force: true })
    }
    console.log(`development database reset: ${databasePath}`)
  } catch (error) {
    console.error(`db-reset failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
