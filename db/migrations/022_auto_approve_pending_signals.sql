INSERT INTO "PlayerSignalAudit" (
  "id", "signal_id", "from_status", "to_status", "reason", "actor_type", "created_at"
)
SELECT
  'migration022:' || "id", "id", "status", 'VERIFIED',
  '100% auto-approval migration: marked signal as verified', 'AUTO_MIGRATION', datetime('now')
FROM "PlayerSignal"
WHERE "status" = 'PENDING';

UPDATE "PlayerSignal"
SET "status" = 'VERIFIED',
    "updated_at" = datetime('now')
WHERE "status" = 'PENDING';

UPDATE "PlayerSignalInterpretation"
SET "status" = 'APPROVED',
    "updated_at" = datetime('now')
WHERE "status" = 'PROPOSED';
