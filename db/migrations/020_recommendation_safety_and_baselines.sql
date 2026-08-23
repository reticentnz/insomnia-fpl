ALTER TABLE "RecommendationSet" ADD COLUMN "free_transfers_confirmed" INTEGER NOT NULL DEFAULT 0 CHECK ("free_transfers_confirmed" IN (0, 1));
ALTER TABLE "RecommendationSet" ADD COLUMN "exact_selling_prices" INTEGER NOT NULL DEFAULT 0 CHECK ("exact_selling_prices" IN (0, 1));
