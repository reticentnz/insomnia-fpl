import fs from 'node:fs'
import { getDb } from './db.mjs'
import { evaluateCalibration } from '../src/backtest.ts'
import { MODEL_VERSION } from '../src/model.ts'

for (const envFile of ['.env.local', '.env']) {
  if (!fs.existsSync(envFile)) continue
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '')
  }
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

const client = getDb()
try {
  const result = await client.query(`
    SELECT observation."position", forecast."mean_points" AS expected_points, result."total_points"
    FROM "PlayerFixtureForecast" forecast
    JOIN "ForecastRun" run ON run."id"=forecast."forecast_run_id"
    JOIN "PlayerFixtureResult" result ON result."player_id"=forecast."player_id" AND result."fixture_id"=forecast."fixture_id"
    JOIN "PlayerObservation" observation ON observation."player_id"=forecast."player_id"
      AND observation."observed_at"=(SELECT MAX(candidate."observed_at") FROM "PlayerObservation" candidate WHERE candidate."player_id"=forecast."player_id" AND candidate."observed_at"<=run."as_of")
    WHERE run."model_version"=$1`, [MODEL_VERSION])
  const rows = result.rows.map(row => ({ position: row.position, expectedPoints: Number(row.expected_points), actualPoints: Number(row.total_points) }))
  const summaries = evaluateCalibration(rows)
  console.table(summaries)
} finally {
  await client.end()
}
