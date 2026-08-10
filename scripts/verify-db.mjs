import fs from 'node:fs'
import { getDb } from './db.mjs'

for (const envFile of ['.env.local', '.env']) {
  if (!fs.existsSync(envFile)) continue
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (match) process.env[match[1]] = match[2].replace(/^"|"$/g, '')
  }
}

const client = getDb()
const result = await client.query('SELECT (SELECT count(*) FROM "Player") AS players, (SELECT count(*) FROM "Team") AS teams, (SELECT count(*) FROM "Fixture") AS fixtures, (SELECT count(*) FROM "PlayerSnapshot") AS snapshots, (SELECT count(*) FROM "PlayerProjection" WHERE "modelVersion"=\'rules-aware-v1.0\') AS projections, (SELECT count(*) FROM "PlayerMatchStat") AS match_history, (SELECT count(*) FROM "ModelCalibration" WHERE "modelVersion"=\'rules-aware-v1.0\') AS calibrations, (SELECT COALESCE((SELECT id FROM "Gameweek" WHERE "isCurrent"=1 LIMIT 1),(SELECT id FROM "Gameweek" WHERE "isFuture"=1 ORDER BY id LIMIT 1))) AS current_gw')
console.log(result.rows[0])
