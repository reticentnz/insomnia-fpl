ALTER TABLE "PlayerSignal" ADD COLUMN "claim_class" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "PlayerSignal" ADD COLUMN "evidence_text" TEXT;

CREATE TABLE "PlayerSignalInterpretation" (
  "id" TEXT PRIMARY KEY,
  "signal_id" TEXT NOT NULL,
  "origin" TEXT NOT NULL CHECK ("origin" IN ('AUTO', 'USER')),
  "claim_class" TEXT NOT NULL,
  "model_impact" TEXT NOT NULL CHECK ("model_impact" IN ('ROLE', 'NONE')),
  "value_json" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "confidence" REAL NOT NULL CHECK ("confidence" BETWEEN 0 AND 1),
  "status" TEXT NOT NULL CHECK ("status" IN ('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
  "supersedes_id" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("signal_id") REFERENCES "PlayerSignal" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("supersedes_id") REFERENCES "PlayerSignalInterpretation" ("id") ON DELETE RESTRICT
);

CREATE INDEX "PlayerSignalInterpretation_signal_status_idx"
  ON "PlayerSignalInterpretation" ("signal_id", "status", "updated_at" DESC);

UPDATE "PlayerSignal"
SET "evidence_text" = "evidence_summary",
    "claim_class" = CASE
      WHEN "kind" IN ('START_PROBABILITY', 'DEPTH_CHART', 'EXPECTED_ROLE') THEN 'REAL_WORLD_ROLE'
      WHEN "kind" = 'INJURY' THEN 'INJURY'
      WHEN "kind" = 'SET_PIECES' THEN 'SET_PIECES'
      WHEN "kind" = 'PENALTIES' THEN 'PENALTIES'
      WHEN "kind" = 'VALUE_OPINION' THEN 'VALUE_OPINION'
      WHEN "kind" = 'STATISTICAL_CLAIM' THEN 'STATISTICAL_CONTEXT'
      ELSE 'UNKNOWN'
    END;

INSERT INTO "PlayerSignalInterpretation" (
  "id", "signal_id", "origin", "claim_class", "model_impact", "value_json",
  "rationale", "confidence", "status", "created_at", "updated_at"
)
SELECT
  'legacy:' || "id", "id",
  CASE WHEN "source_type" = 'MANUAL_OVERRIDE' THEN 'USER' ELSE 'AUTO' END,
  "claim_class",
  CASE
    WHEN json_type("value_json", '$.startProbability') IS NOT NULL
      OR json_type("value_json", '$.minutesIfStarting') IS NOT NULL
      OR json_type("value_json", '$.substituteProbabilityWhenBenched') IS NOT NULL
      OR json_type("value_json", '$.minutesIfSubstitute') IS NOT NULL
      OR json_type("value_json", '$.depthRole') IS NOT NULL
    THEN 'ROLE' ELSE 'NONE'
  END,
  "value_json", 'Migrated from the existing signal interpretation.', "confidence",
  CASE
    WHEN "status" = 'VERIFIED' THEN 'APPROVED'
    WHEN "status" = 'REJECTED' THEN 'REJECTED'
    WHEN "status" = 'EXPIRED' THEN 'SUPERSEDED'
    ELSE 'PROPOSED'
  END,
  "created_at", "updated_at"
FROM "PlayerSignal";
