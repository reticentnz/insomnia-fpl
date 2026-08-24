-- Version 2 is a fixed-input, one-gameweek lookahead applied after the
-- per-gameweek horizon optimizer. Existing stored recommendations remain
-- readable, but are not reused by the new optimizer.
ALTER TABLE "RecommendationSet" ADD COLUMN "roll_option_version" INTEGER NOT NULL DEFAULT 0 CHECK ("roll_option_version" BETWEEN 0 AND 2);

ALTER TABLE "RecommendationCandidate" ADD COLUMN "saved_transfer_value" REAL NOT NULL DEFAULT 0;
ALTER TABLE "RecommendationCandidate" ADD COLUMN "lookahead_available" INTEGER NOT NULL DEFAULT 0 CHECK ("lookahead_available" IN (0, 1));
ALTER TABLE "RecommendationCandidate" ADD COLUMN "next_week_free_transfers" INTEGER CHECK ("next_week_free_transfers" IS NULL OR "next_week_free_transfers" BETWEEN 0 AND 5);
ALTER TABLE "RecommendationCandidate" ADD COLUMN "next_week_best_net_gain" REAL;
