CREATE TABLE IF NOT EXISTS "RssSource" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "feed_url" TEXT NOT NULL UNIQUE,
  "enabled" INTEGER NOT NULL DEFAULT 1 CHECK ("enabled" IN (0, 1)),
  "last_polled_at" TEXT,
  "last_error" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "RssItem" (
  "id" TEXT PRIMARY KEY,
  "source_id" TEXT NOT NULL REFERENCES "RssSource"("id") ON DELETE CASCADE,
  "external_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "url" TEXT,
  "published_at" TEXT,
  "content_text" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('DISCOVERED','PROCESSING','COMPLETE','INSUFFICIENT_EVIDENCE','RETRY','FAILED')),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TEXT,
  "extraction_provider" TEXT,
  "extraction_json" TEXT,
  "claim_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "processed_at" TEXT,
  UNIQUE ("source_id", "external_id")
);

CREATE INDEX IF NOT EXISTS "RssItem_queue_idx"
  ON "RssItem"("status", "next_attempt_at", "published_at");
CREATE INDEX IF NOT EXISTS "RssItem_source_idx"
  ON "RssItem"("source_id", "published_at" DESC);
