import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getDb } from './db.mjs'

const migrationDirectory = path.resolve(process.cwd(), 'db', 'migrations')

function migrationFiles() {
  if (!fs.existsSync(migrationDirectory)) return []
  return fs.readdirSync(migrationDirectory)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => path.join(migrationDirectory, file))
}

function checksum(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

export async function migrateDatabase(customPath) {
  const db = getDb(customPath)
  const applied = []
  const skipped = []

  try {
    db.sqlite.exec(`CREATE TABLE IF NOT EXISTS "SchemaMigration" (
      "version" TEXT PRIMARY KEY,
      "checksum" TEXT NOT NULL,
      "applied_at" TEXT NOT NULL
    )`)

    for (const file of migrationFiles()) {
      const version = path.basename(file, '.sql')
      const contents = fs.readFileSync(file, 'utf8')
      const currentChecksum = checksum(contents)
      const existing = db.sqlite.prepare('SELECT "checksum" FROM "SchemaMigration" WHERE "version" = ?').get(version)

      if (existing) {
        if (existing.checksum !== currentChecksum) {
          throw new Error(`Migration ${version} checksum mismatch: applied ${existing.checksum}, current ${currentChecksum}`)
        }
        skipped.push(version)
        continue
      }

      try {
        db.sqlite.exec('BEGIN IMMEDIATE')
        db.sqlite.exec(contents)
        db.sqlite.prepare('INSERT INTO "SchemaMigration" ("version", "checksum", "applied_at") VALUES (?, ?, ?)').run(version, currentChecksum, new Date().toISOString())
        db.sqlite.exec('COMMIT')
        applied.push(version)
      } catch (error) {
        try { db.sqlite.exec('ROLLBACK') } catch {}
        throw error
      }
    }

    return { applied, skipped }
  } finally {
    await db.end()
  }
}

if (process.argv[1] && process.argv[1].endsWith('db-migrate.mjs')) {
  try {
    const result = await migrateDatabase()
    if (result.applied.length) console.log(`applied migrations: ${result.applied.join(', ')}`)
    else console.log('database already up to date')
  } catch (error) {
    console.error(`db-migrate failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
