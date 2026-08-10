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
const result = await client.query('SELECT p.position,pr."expectedPoints",m."totalPoints" FROM "PlayerProjection" pr JOIN "Player" p ON p.id=pr."playerId" JOIN "PlayerMatchStat" m ON m."playerId"=pr."playerId" AND m.gameweek=pr."gameweekId" WHERE pr."modelVersion"=$1', [MODEL_VERSION])
const rows = result.rows.map(row => ({ position: row.position, expectedPoints: Number(row.expectedPoints), actualPoints: Number(row.totalPoints) }))
const summaries = evaluateCalibration(rows)
for (const summary of summaries.filter(row => row.position !== 'ALL' && row.sampleSize >= 20)) {
  await client.query('INSERT INTO "ModelCalibration" ("modelVersion",position,"sampleSize",factor,mae,rmse,bias,"updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP) ON CONFLICT ("modelVersion",position) DO UPDATE SET "sampleSize"=EXCLUDED."sampleSize",factor=EXCLUDED.factor,mae=EXCLUDED.mae,rmse=EXCLUDED.rmse,bias=EXCLUDED.bias,"updatedAt"=CURRENT_TIMESTAMP', [MODEL_VERSION, summary.position, summary.sampleSize, summary.factor, summary.mae, summary.rmse, summary.bias])
}
console.table(summaries)
