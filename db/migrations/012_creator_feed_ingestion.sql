CREATE TABLE IF NOT EXISTS "CreatorSource" (
  "id" TEXT PRIMARY KEY,
  "platform" TEXT NOT NULL DEFAULT 'YOUTUBE' CHECK ("platform" = 'YOUTUBE'),
  "channel_id" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "feed_url" TEXT NOT NULL,
  "enabled" INTEGER NOT NULL DEFAULT 1 CHECK ("enabled" IN (0, 1)),
  "last_polled_at" TEXT,
  "last_error" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "CreatorVideo" (
  "id" TEXT PRIMARY KEY,
  "source_id" TEXT NOT NULL REFERENCES "CreatorSource"("id") ON DELETE CASCADE,
  "title" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "published_at" TEXT,
  "status" TEXT NOT NULL CHECK ("status" IN ('DISCOVERED','PROCESSING','COMPLETE','NO_TRANSCRIPT','RETRY','FAILED')),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TEXT,
  "transcript_json" TEXT,
  "transcript_language" TEXT,
  "transcript_generated" INTEGER,
  "extraction_provider" TEXT,
  "extraction_json" TEXT,
  "claim_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "processed_at" TEXT
);

CREATE INDEX IF NOT EXISTS "CreatorVideo_queue_idx"
  ON "CreatorVideo"("status", "next_attempt_at", "published_at");
CREATE INDEX IF NOT EXISTS "CreatorVideo_source_idx"
  ON "CreatorVideo"("source_id", "published_at" DESC);
