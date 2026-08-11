CREATE INDEX "RecommendationSet_request_identity_idx"
ON "RecommendationSet" (
  "plan_id",
  "forecast_run_id",
  "horizon",
  "max_transfers",
  "chip",
  "uncertainty_penalty_rate",
  "input_hash",
  "created_at" DESC
);
