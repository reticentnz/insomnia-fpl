ALTER TABLE "ManagerAccount"
  ADD COLUMN "total_transfers" INTEGER NOT NULL DEFAULT 0 CHECK ("total_transfers" >= 0);

CREATE TABLE "AppUserState" (
  "id" TEXT PRIMARY KEY CHECK ("id" = 'default'),
  "active_manager_account_id" TEXT,
  "user_name" TEXT NOT NULL DEFAULT '',
  "exploratory_bank_tenths" INTEGER CHECK ("exploratory_bank_tenths" IS NULL OR "exploratory_bank_tenths" >= 0),
  "exploratory_free_transfers" INTEGER CHECK ("exploratory_free_transfers" IS NULL OR "exploratory_free_transfers" BETWEEN 0 AND 5),
  "default_league_id" INTEGER,
  "onboarding_completed" INTEGER NOT NULL DEFAULT 0 CHECK ("onboarding_completed" IN (0, 1)),
  "challenge_result_json" TEXT,
  "staged_reviews_json" TEXT NOT NULL DEFAULT '{}',
  "ai_provider" TEXT NOT NULL DEFAULT '',
  "api_key" TEXT NOT NULL DEFAULT '',
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("active_manager_account_id") REFERENCES "ManagerAccount" ("id") ON DELETE SET NULL
);

INSERT INTO "AppUserState" ("id", "updated_at") VALUES ('default', datetime('now'));

UPDATE "AppUserState"
SET "active_manager_account_id" = (
  SELECT "id" FROM "ManagerAccount" ORDER BY "updated_at" DESC, "id" DESC LIMIT 1
)
WHERE "id" = 'default';
