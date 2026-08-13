CREATE TABLE IF NOT EXISTS "AiUsageEvent" (
  "id" TEXT PRIMARY KEY,
  "feature" TEXT NOT NULL CHECK ("feature" IN ('ASK', 'SQUAD_CHALLENGE', 'YOUTUBE_EXTRACTION')),
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "billing_source" TEXT NOT NULL CHECK ("billing_source" IN ('USER_API_KEY', 'SERVER_API_KEY', 'LOCAL')),
  "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0,
  "total_tokens" INTEGER NOT NULL DEFAULT 0,
  "web_search_calls" INTEGER NOT NULL DEFAULT 0,
  "estimated_cost_usd" REAL,
  "created_at" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "AiUsageEvent_created_at_idx" ON "AiUsageEvent"("created_at" DESC);
CREATE INDEX IF NOT EXISTS "AiUsageEvent_feature_idx" ON "AiUsageEvent"("feature", "created_at" DESC);
