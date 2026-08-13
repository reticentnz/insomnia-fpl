ALTER TABLE "MarketFixtureObservation" ADD COLUMN "home_clean_sheet_probability" REAL CHECK ("home_clean_sheet_probability" IS NULL OR "home_clean_sheet_probability" BETWEEN 0 AND 1);
ALTER TABLE "MarketFixtureObservation" ADD COLUMN "away_clean_sheet_probability" REAL CHECK ("away_clean_sheet_probability" IS NULL OR "away_clean_sheet_probability" BETWEEN 0 AND 1);
