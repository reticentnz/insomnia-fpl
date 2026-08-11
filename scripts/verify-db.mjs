import fs from 'node:fs'
import { getDb } from './db.mjs'
import { MODEL_VERSION } from '../src/model.ts'

for (const envFile of ['.env.local', '.env']) {
  if (!fs.existsSync(envFile)) continue
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '')
  }
}

const client = getDb()
try {
  const result = await client.query('SELECT $1 AS model_version, (SELECT count(*) FROM "Player") AS players, (SELECT count(*) FROM "Team") AS teams, (SELECT count(*) FROM "Fixture") AS fixtures, (SELECT count(*) FROM "PlayerObservation") AS player_observations, (SELECT count(*) FROM "PlayerFixtureResult") AS player_fixture_results, (SELECT count(*) FROM "PlayerFixtureForecast" forecast JOIN "ForecastRun" run ON run."id"=forecast."forecast_run_id" WHERE run."model_version"=$1) AS forecasts, (SELECT count(*) FROM "CalibrationSet" WHERE "model_version"=$1) AS calibration_sets, (SELECT COALESCE((SELECT "gameweek_id" FROM "GameweekObservation" WHERE "is_current"=1 ORDER BY "observed_at" DESC LIMIT 1),(SELECT "id" FROM "Gameweek" ORDER BY "fpl_id" LIMIT 1))) AS current_gw', [MODEL_VERSION])
  console.log(result.rows[0])
} finally {
  await client.end()
}
