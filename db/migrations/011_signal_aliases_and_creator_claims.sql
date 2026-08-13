CREATE TABLE IF NOT EXISTS "PlayerAlias" (
  "id" TEXT PRIMARY KEY,
  "alias" TEXT NOT NULL,
  "normalized_alias" TEXT NOT NULL UNIQUE,
  "player_id" TEXT NOT NULL REFERENCES "Player"("id") ON DELETE CASCADE,
  "source" TEXT NOT NULL DEFAULT 'USER',
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "PlayerAlias_player_idx" ON "PlayerAlias"("player_id");

CREATE TABLE IF NOT EXISTS "CreatorClaim" (
  "id" TEXT PRIMARY KEY,
  "platform" TEXT NOT NULL,
  "external_source_id" TEXT NOT NULL,
  "raw_player_name" TEXT NOT NULL,
  "normalized_player_name" TEXT NOT NULL,
  "club_hint" TEXT,
  "position_hint" TEXT,
  "category" TEXT NOT NULL,
  "sentiment" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "timestamp_seconds" REAL,
  "time_horizon" TEXT,
  "claim_json" TEXT NOT NULL,
  "source_json" TEXT NOT NULL,
  "match_status" TEXT NOT NULL CHECK ("match_status" IN ('AMBIGUOUS','UNRESOLVED','RESOLVED','DISMISSED')),
  "match_confidence" REAL NOT NULL DEFAULT 0,
  "candidates_json" TEXT NOT NULL DEFAULT '[]',
  "resolved_player_id" TEXT REFERENCES "Player"("id") ON DELETE SET NULL,
  "signal_id" TEXT REFERENCES "PlayerSignal"("id") ON DELETE SET NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "CreatorClaim_status_idx" ON "CreatorClaim"("match_status", "created_at" DESC);
