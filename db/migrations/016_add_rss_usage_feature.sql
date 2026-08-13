PRAGMA foreign_keys = OFF;

ALTER TABLE "AiUsageEvent" RENAME TO "AiUsageEvent_previous";

CREATE TABLE "AiUsageEvent" (
  "id" TEXT PRIMARY KEY,
  "feature" TEXT NOT NULL CHECK ("feature" IN ('ASK', 'SQUAD_CHALLENGE', 'YOUTUBE_EXTRACTION', 'RSS_EXTRACTION')),
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

INSERT INTO "AiUsageEvent" ("id", "feature", "provider", "model", "billing_source", "input_tokens", "cached_input_tokens", "output_tokens", "total_tokens", "web_search_calls", "estimated_cost_usd", "created_at")
SELECT "id", "feature", "provider", "model", "billing_source", "input_tokens", "cached_input_tokens", "output_tokens", "total_tokens", "web_search_calls", "estimated_cost_usd", "created_at"
FROM "AiUsageEvent_previous";

DROP TABLE "AiUsageEvent_previous";

CREATE INDEX "AiUsageEvent_created_at_idx" ON "AiUsageEvent"("created_at" DESC);
CREATE INDEX "AiUsageEvent_feature_idx" ON "AiUsageEvent"("feature", "created_at" DESC);

PRAGMA foreign_keys = ON;
