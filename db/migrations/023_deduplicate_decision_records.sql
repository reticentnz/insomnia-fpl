-- A decision is a single recorded action for a recommendation candidate. Keep the
-- earliest historical copy before enforcing that invariant for future requests.
DELETE FROM "DecisionRecord" AS duplicate
WHERE EXISTS (
  SELECT 1
  FROM "DecisionRecord" AS original
  WHERE original."recommendation_set_id" = duplicate."recommendation_set_id"
    AND original."candidate_id" IS duplicate."candidate_id"
    AND original."decision" = duplicate."decision"
    AND original."selected_plan_id" IS duplicate."selected_plan_id"
    AND (
      original."created_at" < duplicate."created_at"
      OR (original."created_at" = duplicate."created_at" AND original."id" < duplicate."id")
    )
);

CREATE UNIQUE INDEX "DecisionRecord_action_once_idx"
  ON "DecisionRecord" (
    "recommendation_set_id",
    COALESCE("candidate_id", ''),
    "decision",
    COALESCE("selected_plan_id", '')
  );
