import fs from 'node:fs'
import { getDb } from './db.mjs'
import { runBacktest } from '../src/server/backtest-service.ts'
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
  const result = await runBacktest(client, { modelVersion: process.env.MODEL_VERSION || MODEL_VERSION })
  if (!result.observationCount) {
    console.log('backtest: zero eligible observations (Uncalibrated)')
  } else {
    for (const model of result.models) {
      console.log(`backtest: ${model.modelVersion}; ${model.observationCount} observations; ${model.status}; cutoff ${result.trainingCutoff}`)
      console.table(model.metrics)
    }
  }
} finally {
  await client.end()
}
