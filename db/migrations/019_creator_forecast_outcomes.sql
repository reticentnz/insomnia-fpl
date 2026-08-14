CREATE TABLE IF NOT EXISTS "CreatorForecastOutcome" (
  "signal_id" TEXT PRIMARY KEY,
  "creator" TEXT NOT NULL,
  "external_source_id" TEXT NOT NULL,
  "target_metric" TEXT NOT NULL CHECK ("target_metric" IN ('EXPECTED_POINTS', 'PRICE')),
  "direction" TEXT NOT NULL CHECK ("direction" IN ('UNDERPERFORM', 'OUTPERFORM', 'PRICE_FALL', 'PRICE_RISE')),
  "probability" REAL NOT NULL CHECK ("probability" BETWEEN 0 AND 1),
  "horizon" TEXT NOT NULL,
  "observed_at" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN', 'EVALUATED', 'INSUFFICIENT')),
  "realized_value" REAL,
  "outcome" TEXT,
  "evaluated_at" TEXT,
  FOREIGN KEY ("signal_id") REFERENCES "PlayerSignal"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "CreatorForecastOutcome_creator_status_idx"
  ON "CreatorForecastOutcome" ("creator", "status", "observed_at" DESC);
