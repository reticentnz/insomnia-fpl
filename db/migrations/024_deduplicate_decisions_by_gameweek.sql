-- Recommendation sets are regenerated as forecasts refresh. Collapse historical
-- copies of the same manager action for the same target gameweek, keeping the
-- earliest audit record. Future writes enforce this invariant in the service,
-- because a SQLite index cannot span the related tables needed for this key.
DELETE FROM "DecisionRecord" AS duplicate
WHERE EXISTS (
  SELECT 1
  FROM "DecisionRecord" AS original
  JOIN "RecommendationSet" AS original_set ON original_set."id" = original."recommendation_set_id"
  JOIN "Plan" AS original_baseline ON original_baseline."id" = original_set."plan_id"
  JOIN "ForecastRun" AS original_run ON original_run."id" = original_set."forecast_run_id"
  LEFT JOIN "RecommendationCandidate" AS original_candidate ON original_candidate."id" = original."candidate_id"
  JOIN "RecommendationSet" AS duplicate_set ON duplicate_set."id" = duplicate."recommendation_set_id"
  JOIN "Plan" AS duplicate_baseline ON duplicate_baseline."id" = duplicate_set."plan_id"
  JOIN "ForecastRun" AS duplicate_run ON duplicate_run."id" = duplicate_set."forecast_run_id"
  LEFT JOIN "RecommendationCandidate" AS duplicate_candidate ON duplicate_candidate."id" = duplicate."candidate_id"
  WHERE original_baseline."manager_account_id" = duplicate_baseline."manager_account_id"
    AND original_run."gameweek_id" = duplicate_run."gameweek_id"
    AND original."decision" = duplicate."decision"
    AND (
      (original."candidate_id" IS NOT NULL
       AND duplicate."candidate_id" IS NOT NULL
       AND original_candidate."action" = duplicate_candidate."action"
       AND original_candidate."moves_json" = duplicate_candidate."moves_json")
      OR (original."candidate_id" IS NULL
          AND duplicate."candidate_id" IS NULL
          AND original."selected_plan_id" IS duplicate."selected_plan_id")
    )
    AND (
      original."created_at" < duplicate."created_at"
      OR (original."created_at" = duplicate."created_at" AND original."id" < duplicate."id")
    )
);
