INSERT INTO "PlayerSignalAudit" (
  "id", "signal_id", "from_status", "to_status", "reason", "actor_type", "created_at"
)
SELECT
  'migration007:' || "id", "id", "status", 'VERIFIED',
  'Reclassified creator FPL bench selection as context only', 'SYSTEM', datetime('now')
FROM "PlayerSignal"
WHERE "source_type" = 'YOUTUBE_TRANSCRIPT'
  AND "status" = 'PENDING'
  AND (
    lower("evidence_summary") LIKE '%bench boost%'
    OR lower("evidence_summary") LIKE '%my bench%'
    OR lower("evidence_summary") LIKE '%bench goalkeeper%'
    OR lower("evidence_summary") LIKE '%bench plan%'
  );

UPDATE "PlayerSignal"
SET "claim_class" = 'FPL_SELECTION',
    "kind" = 'VALUE_OPINION',
    "status" = CASE WHEN "status" = 'PENDING' THEN 'VERIFIED' ELSE "status" END,
    "updated_at" = datetime('now')
WHERE "source_type" = 'YOUTUBE_TRANSCRIPT'
  AND (
    lower("evidence_summary") LIKE '%bench boost%'
    OR lower("evidence_summary") LIKE '%my bench%'
    OR lower("evidence_summary") LIKE '%bench goalkeeper%'
    OR lower("evidence_summary") LIKE '%bench plan%'
  );

UPDATE "PlayerSignalInterpretation"
SET "claim_class" = 'FPL_SELECTION',
    "model_impact" = 'NONE',
    "rationale" = 'Creator FPL bench selection; context only with no projection impact.',
    "status" = CASE WHEN "status" = 'PROPOSED' THEN 'APPROVED' ELSE "status" END,
    "updated_at" = datetime('now')
WHERE "signal_id" IN (
  SELECT "id" FROM "PlayerSignal"
  WHERE "source_type" = 'YOUTUBE_TRANSCRIPT' AND "claim_class" = 'FPL_SELECTION'
);
