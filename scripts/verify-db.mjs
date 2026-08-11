import fs from 'node:fs'
import { getDb } from './db.mjs'
import { MODEL_VERSION } from '../src/model.ts'

for (const envFile of ['.env.local', '.env']) {
  if (!fs.existsSync(envFile)) continue
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (match) process.env[match[1]] = match[2].replace(/^"|"$/g, '')
  }
}

const client = getDb()
try {
  const result = await client.query('SELECT $1 AS model_version, (SELECT count(*) FROM "Player") AS players, (SELECT count(*) FROM "Team") AS teams, (SELECT count(*) FROM "Fixture") AS fixtures, (SELECT count(*) FROM "PlayerSnapshot") AS snapshots, (SELECT count(*) FROM "PlayerProjection" WHERE "modelVersion"=$1) AS projections, (SELECT count(*) FROM "PlayerMatchStat") AS match_history, (SELECT count(*) FROM "ModelCalibration" WHERE "modelVersion"=$1) AS calibrations, (SELECT COALESCE((SELECT id FROM "Gameweek" WHERE "isCurrent"=1 LIMIT 1),(SELECT id FROM "Gameweek" WHERE "isFuture"=1 ORDER BY id LIMIT 1))) AS current_gw', [MODEL_VERSION])
  console.log(result.rows[0])
} finally {
  await client.end()
}
