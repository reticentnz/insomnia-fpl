import fs from 'node:fs'
import { getDb } from './db.mjs'

for (const envFile of ['.env.local', '.env']) {
  if (!fs.existsSync(envFile)) continue
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '')
  }
}

const statements = [
  `CREATE TABLE IF NOT EXISTS "Team" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "shortName" TEXT NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS "Player" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "clubId" INTEGER NOT NULL, "previousClubId" INTEGER, "clubChangedAt" DATETIME, "position" TEXT NOT NULL, "price" REAL NOT NULL, "status" TEXT, "active" BOOLEAN NOT NULL DEFAULT 1, "season" TEXT NOT NULL DEFAULT '2026/27', "chanceOfPlaying" INTEGER, "minutes" INTEGER NOT NULL DEFAULT 0, "starts" INTEGER NOT NULL DEFAULT 0, "totalPoints" INTEGER NOT NULL DEFAULT 0, "pointsPerGame" REAL NOT NULL DEFAULT 0, "form" REAL NOT NULL DEFAULT 0, "epNext" REAL NOT NULL DEFAULT 0, "goals" INTEGER NOT NULL DEFAULT 0, "assists" INTEGER NOT NULL DEFAULT 0, "cleanSheets" INTEGER NOT NULL DEFAULT 0, "goalsConceded" INTEGER NOT NULL DEFAULT 0, "saves" INTEGER NOT NULL DEFAULT 0, "bonus" INTEGER NOT NULL DEFAULT 0, "bps" INTEGER NOT NULL DEFAULT 0, "yellowCards" INTEGER NOT NULL DEFAULT 0, "redCards" INTEGER NOT NULL DEFAULT 0, "ownGoals" INTEGER NOT NULL DEFAULT 0, "penaltiesMissed" INTEGER NOT NULL DEFAULT 0, "penaltiesSaved" INTEGER NOT NULL DEFAULT 0, "clearancesBlocksInterceptions" INTEGER NOT NULL DEFAULT 0, "tackles" INTEGER NOT NULL DEFAULT 0, "recoveries" INTEGER NOT NULL DEFAULT 0, "defensiveContribution" REAL NOT NULL DEFAULT 0, "defensiveContributionPer90" REAL NOT NULL DEFAULT 0, "expectedGoalsPer90" REAL NOT NULL DEFAULT 0, "expectedAssistsPer90" REAL NOT NULL DEFAULT 0, "expectedGCPer90" REAL NOT NULL DEFAULT 0, "savesPer90" REAL NOT NULL DEFAULT 0, "ownership" REAL NOT NULL DEFAULT 0, "transfersIn" INTEGER NOT NULL DEFAULT 0, "transfersOut" INTEGER NOT NULL DEFAULT 0, "expectedGoals" REAL NOT NULL DEFAULT 0, "expectedAssists" REAL NOT NULL DEFAULT 0, "expectedGI" REAL NOT NULL DEFAULT 0, "expectedGC" REAL NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
  `CREATE TABLE IF NOT EXISTS "Gameweek" ("id" INTEGER PRIMARY KEY, "season" TEXT NOT NULL DEFAULT '2026/27', "deadline" DATETIME, "finished" BOOLEAN NOT NULL DEFAULT 0, "isCurrent" BOOLEAN NOT NULL DEFAULT 0, "isFuture" BOOLEAN NOT NULL DEFAULT 1);`,
  `CREATE TABLE IF NOT EXISTS "Fixture" ("id" INTEGER PRIMARY KEY, "season" TEXT NOT NULL DEFAULT '2026/27', "gameweekId" INTEGER NOT NULL, "homeTeamId" INTEGER NOT NULL, "awayTeamId" INTEGER NOT NULL, "kickoff" DATETIME, "difficultyHome" INTEGER, "difficultyAway" INTEGER);`,
  `CREATE TABLE IF NOT EXISTS "PlayerSnapshot" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "playerId" INTEGER NOT NULL, "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "totalPoints" INTEGER, "form" REAL, "minutes" INTEGER, "ownership" REAL, "transfersIn" INTEGER, "transfersOut" INTEGER, "price" REAL);`,
  `CREATE INDEX IF NOT EXISTS "PlayerSnapshot_playerId_capturedAt_idx" ON "PlayerSnapshot" ("playerId", "capturedAt");`,
  `CREATE TABLE IF NOT EXISTS "PlayerProjection" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "playerId" INTEGER NOT NULL, "gameweekId" INTEGER NOT NULL, "modelVersion" TEXT NOT NULL, "expectedMinutes" REAL NOT NULL, "expectedGoals" REAL NOT NULL, "expectedAssists" REAL NOT NULL, "cleanSheetProbability" REAL NOT NULL, "expectedBonus" REAL NOT NULL, "expectedCardDeduction" REAL NOT NULL, "expectedPoints" REAL NOT NULL, UNIQUE ("playerId", "gameweekId", "modelVersion"));`,
  `CREATE TABLE IF NOT EXISTS "PlayerMatchStat" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "playerId" INTEGER NOT NULL, "fixtureId" INTEGER NOT NULL, "gameweek" INTEGER NOT NULL, "opponentTeamId" INTEGER NOT NULL, "wasHome" BOOLEAN NOT NULL, "kickoff" DATETIME, "minutes" INTEGER NOT NULL DEFAULT 0, "totalPoints" INTEGER NOT NULL DEFAULT 0, "goals" INTEGER NOT NULL DEFAULT 0, "assists" INTEGER NOT NULL DEFAULT 0, "cleanSheets" INTEGER NOT NULL DEFAULT 0, "goalsConceded" INTEGER NOT NULL DEFAULT 0, "saves" INTEGER NOT NULL DEFAULT 0, "bonus" INTEGER NOT NULL DEFAULT 0, "bps" INTEGER NOT NULL DEFAULT 0, "yellowCards" INTEGER NOT NULL DEFAULT 0, "redCards" INTEGER NOT NULL DEFAULT 0, "ownGoals" INTEGER NOT NULL DEFAULT 0, "penaltiesMissed" INTEGER NOT NULL DEFAULT 0, "penaltiesSaved" INTEGER NOT NULL DEFAULT 0, "expectedGoals" REAL NOT NULL DEFAULT 0, "expectedAssists" REAL NOT NULL DEFAULT 0, "expectedGoalsConceded" REAL NOT NULL DEFAULT 0, "defensiveContribution" REAL NOT NULL DEFAULT 0, "clearancesBlocksInterceptions" INTEGER NOT NULL DEFAULT 0, "tackles" INTEGER NOT NULL DEFAULT 0, "recoveries" INTEGER NOT NULL DEFAULT 0, UNIQUE ("playerId", "fixtureId"));`,
  `CREATE INDEX IF NOT EXISTS "PlayerMatchStat_playerId_gameweek_idx" ON "PlayerMatchStat" ("playerId", "gameweek");`,
  `CREATE TABLE IF NOT EXISTS "PlayerSignal" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "playerId" INTEGER NOT NULL, "gameweekId" INTEGER, "kind" TEXT NOT NULL, "value" TEXT NOT NULL, "sourceType" TEXT NOT NULL, "sourceUrl" TEXT, "evidenceSummary" TEXT NOT NULL, "confidence" REAL NOT NULL, "observedAt" DATETIME NOT NULL, "validUntil" DATETIME NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
  `CREATE INDEX IF NOT EXISTS "PlayerSignal_playerId_status_validUntil_idx" ON "PlayerSignal" ("playerId", "status", "validUntil");`,
  `CREATE INDEX IF NOT EXISTS "PlayerSignal_gameweekId_idx" ON "PlayerSignal" ("gameweekId");`,
  `CREATE TABLE IF NOT EXISTS "CreatorContent" ("id" TEXT PRIMARY KEY, "platform" TEXT NOT NULL, "externalId" TEXT NOT NULL, "creator" TEXT NOT NULL, "title" TEXT NOT NULL, "url" TEXT NOT NULL, "publishedAt" DATETIME, "payload" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "processedAt" DATETIME, "processingError" TEXT, UNIQUE ("platform", "externalId"));`,
  `CREATE TABLE IF NOT EXISTS "CreatorClaim" ("id" TEXT PRIMARY KEY, "contentId" TEXT NOT NULL, "rawPlayerName" TEXT NOT NULL, "normalizedPlayerName" TEXT NOT NULL, "resolvedPlayerId" INTEGER, "clubHint" TEXT, "positionHint" TEXT, "priceHint" REAL, "category" TEXT NOT NULL, "sentiment" TEXT NOT NULL, "summary" TEXT NOT NULL, "evidenceText" TEXT, "timestampSeconds" INTEGER, "timeHorizon" TEXT, "numericClaims" TEXT NOT NULL DEFAULT '[]', "relatedMentions" TEXT NOT NULL DEFAULT '[]', "signalValue" TEXT NOT NULL DEFAULT '{}', "matchStatus" TEXT NOT NULL DEFAULT 'UNRESOLVED', "matchConfidence" REAL NOT NULL DEFAULT 0, "matchCandidates" TEXT NOT NULL DEFAULT '[]', "signalId" INTEGER, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
  `CREATE INDEX IF NOT EXISTS "CreatorClaim_matchStatus_idx" ON "CreatorClaim" ("matchStatus");`,
  `CREATE INDEX IF NOT EXISTS "CreatorClaim_resolvedPlayerId_idx" ON "CreatorClaim" ("resolvedPlayerId");`,
  `CREATE TABLE IF NOT EXISTS "PlayerAlias" ("alias" TEXT PRIMARY KEY, "playerId" INTEGER NOT NULL, "canonicalName" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
  `CREATE INDEX IF NOT EXISTS "PlayerAlias_playerId_idx" ON "PlayerAlias" ("playerId");`,
  `CREATE TABLE IF NOT EXISTS "PlayerOutlook" ("playerId" INTEGER NOT NULL, "gameweekId" INTEGER NOT NULL, "startProbability" REAL NOT NULL, "minutesIfStarting" REAL NOT NULL, "substituteProbabilityWhenBenched" REAL NOT NULL, "minutesIfSubstitute" REAL NOT NULL, "confidence" TEXT NOT NULL, "derivedSignalIds" TEXT NOT NULL DEFAULT '[]', "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("playerId", "gameweekId"));`,
  `CREATE INDEX IF NOT EXISTS "PlayerOutlook_gameweekId_idx" ON "PlayerOutlook" ("gameweekId");`,
  `CREATE TABLE IF NOT EXISTS "ModelCalibration" ("modelVersion" TEXT NOT NULL, "position" TEXT NOT NULL, "sampleSize" INTEGER NOT NULL, "factor" REAL NOT NULL, "mae" REAL NOT NULL, "rmse" REAL NOT NULL, "bias" REAL NOT NULL, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("modelVersion", "position"));`,
  `CREATE TABLE IF NOT EXISTS "Squad" ("id" TEXT PRIMARY KEY, "bank" REAL NOT NULL, "freeTransfers" INTEGER NOT NULL DEFAULT 1, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);`,
  `CREATE TABLE IF NOT EXISTS "SquadPlayer" ("squadId" TEXT NOT NULL, "playerId" INTEGER NOT NULL, "position" TEXT NOT NULL, PRIMARY KEY ("squadId", "playerId"));`,
  `CREATE TABLE IF NOT EXISTS "UserAccount" ("id" TEXT PRIMARY KEY DEFAULT 'default', "teamId" INTEGER NOT NULL, "teamName" TEXT NOT NULL, "managerName" TEXT NOT NULL DEFAULT '', "totalPoints" INTEGER NOT NULL DEFAULT 0, "gameweekPoints" INTEGER NOT NULL DEFAULT 0, "squadValue" REAL NOT NULL DEFAULT 100, "bank" REAL NOT NULL DEFAULT 0, "overallRank" INTEGER, "transfersCost" INTEGER NOT NULL DEFAULT 0, "eventTransfers" INTEGER NOT NULL DEFAULT 0, "totalTransfers" INTEGER NOT NULL DEFAULT 0, "currentGameweek" INTEGER NOT NULL DEFAULT 1, "selectedIds" TEXT NOT NULL DEFAULT '[]', "lastSynced" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);`
]

export async function ensureDatabaseSchema() {
  const db = getDb()
  try {
    await db.query('BEGIN')
    for (const statement of statements) {
      await db.query(statement)
    }
    const claimSchema=await db.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='CreatorClaim'`)
    if(!String(claimSchema.rows[0]?.sql||'').includes('"signalValue"'))await db.query(`ALTER TABLE "CreatorClaim" ADD COLUMN "signalValue" TEXT NOT NULL DEFAULT '{}'`)
    await db.query('COMMIT')
    const result = await db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    console.log(`database schema ready: ${result.rows.map(row => row.name).join(', ')}`)
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  }
}

if (process.argv[1] && process.argv[1].endsWith('db-push.mjs')) {
  ensureDatabaseSchema().catch((err) => {
    console.error('db-push failed:', err)
    process.exit(1)
  })
}
