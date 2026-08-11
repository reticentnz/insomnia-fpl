import fs from 'node:fs'
import { closeDb, getDb } from './db.mjs'
import { createForecastRun } from '../src/server/forecast-service.ts'

for (const envFile of ['.env.local', '.env']) {
  if (!fs.existsSync(envFile)) continue
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '')
  }
}

const args = process.argv.slice(2)
const read = name => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

const db = getDb()
try {
  const result = await createForecastRun(db, {
    asOf: read('--as-of'),
    createdAt: read('--created-at'),
    maxGameweeks: read('--max-gameweeks') == null ? undefined : Number(read('--max-gameweeks')),
    modelVersion: read('--model-version'),
  })
  console.log(JSON.stringify(result))
  if (result.status === 'FAILED') process.exitCode = 1
} finally {
  await closeDb()
}
