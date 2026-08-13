ALTER TABLE "RecommendationSet" ADD COLUMN "league_id" INTEGER;
ALTER TABLE "RecommendationSet" ADD COLUMN "league_name" TEXT;

ALTER TABLE "RecommendationCandidate" ADD COLUMN "league_differential" REAL;
