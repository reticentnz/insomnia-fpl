CREATE TABLE IF NOT EXISTS "SchemaMigration" (
  "version" TEXT PRIMARY KEY,
  "checksum" TEXT NOT NULL,
  "applied_at" TEXT NOT NULL
);

CREATE TABLE "FeedRun" (
  "id" TEXT PRIMARY KEY,
  "source" TEXT NOT NULL CHECK ("source" IN ('OFFICIAL_FPL', 'UNDERLYING', 'MARKET', 'CREATOR', 'RESEARCH')),
  "status" TEXT NOT NULL CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
  "started_at" TEXT NOT NULL,
  "finished_at" TEXT,
  "source_updated_at" TEXT,
  "payload_hash" TEXT,
  "request_count" INTEGER NOT NULL DEFAULT 0 CHECK ("request_count" >= 0),
  "inserted_count" INTEGER NOT NULL DEFAULT 0 CHECK ("inserted_count" >= 0),
  "updated_count" INTEGER NOT NULL DEFAULT 0 CHECK ("updated_count" >= 0),
  "unmatched_count" INTEGER NOT NULL DEFAULT 0 CHECK ("unmatched_count" >= 0),
  "used_cache" INTEGER NOT NULL DEFAULT 0 CHECK ("used_cache" IN (0, 1)),
  "cache_captured_at" TEXT,
  "error_summary" TEXT,
  "metadata_json" TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX "FeedRun_source_started_idx" ON "FeedRun" ("source", "started_at" DESC);
CREATE INDEX "FeedRun_status_started_idx" ON "FeedRun" ("status", "started_at" DESC);

CREATE TABLE "Team" (
  "id" TEXT PRIMARY KEY,
  "season" TEXT NOT NULL,
  "fpl_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "short_name" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE UNIQUE INDEX "Team_season_fpl_id_unique" ON "Team" ("season", "fpl_id");

CREATE TABLE "TeamObservation" (
  "id" TEXT PRIMARY KEY,
  "team_id" TEXT NOT NULL,
  "feed_run_id" TEXT NOT NULL,
  "observed_at" TEXT NOT NULL,
  "strength_attack_home" REAL,
  "strength_attack_away" REAL,
  "strength_defence_home" REAL,
  "strength_defence_away" REAL,
  "active" INTEGER NOT NULL CHECK ("active" IN (0, 1)),
  "raw_payload_json" TEXT NOT NULL,
  UNIQUE ("team_id", "feed_run_id"),
  FOREIGN KEY ("team_id") REFERENCES "Team" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("feed_run_id") REFERENCES "FeedRun" ("id") ON DELETE RESTRICT
);

CREATE TABLE "Gameweek" (
  "id" TEXT PRIMARY KEY,
  "season" TEXT NOT NULL,
  "fpl_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE UNIQUE INDEX "Gameweek_season_fpl_id_unique" ON "Gameweek" ("season", "fpl_id");

CREATE TABLE "GameweekObservation" (
  "id" TEXT PRIMARY KEY,
  "gameweek_id" TEXT NOT NULL,
  "feed_run_id" TEXT NOT NULL,
  "observed_at" TEXT NOT NULL,
  "deadline_at" TEXT,
  "finished" INTEGER NOT NULL CHECK ("finished" IN (0, 1)),
  "is_current" INTEGER NOT NULL CHECK ("is_current" IN (0, 1)),
  "is_next" INTEGER NOT NULL CHECK ("is_next" IN (0, 1)),
  "raw_payload_json" TEXT NOT NULL,
  UNIQUE ("gameweek_id", "feed_run_id"),
  FOREIGN KEY ("gameweek_id") REFERENCES "Gameweek" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("feed_run_id") REFERENCES "FeedRun" ("id") ON DELETE RESTRICT
);

CREATE TABLE "Fixture" (
  "id" TEXT PRIMARY KEY,
  "season" TEXT NOT NULL,
  "fpl_id" INTEGER NOT NULL,
  "home_team_id" TEXT NOT NULL,
  "away_team_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  UNIQUE ("season", "fpl_id"),
  FOREIGN KEY ("home_team_id") REFERENCES "Team" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("away_team_id") REFERENCES "Team" ("id") ON DELETE RESTRICT
);

CREATE TABLE "FixtureObservation" (
  "id" TEXT PRIMARY KEY,
  "fixture_id" TEXT NOT NULL,
  "feed_run_id" TEXT NOT NULL,
  "observed_at" TEXT NOT NULL,
  "gameweek_id" TEXT,
  "kickoff_at" TEXT,
  "difficulty_home" INTEGER CHECK ("difficulty_home" IS NULL OR "difficulty_home" BETWEEN 1 AND 5),
  "difficulty_away" INTEGER CHECK ("difficulty_away" IS NULL OR "difficulty_away" BETWEEN 1 AND 5),
  "started" INTEGER NOT NULL CHECK ("started" IN (0, 1)),
  "finished" INTEGER NOT NULL CHECK ("finished" IN (0, 1)),
  "raw_payload_json" TEXT NOT NULL,
  UNIQUE ("fixture_id", "feed_run_id"),
  FOREIGN KEY ("fixture_id") REFERENCES "Fixture" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("feed_run_id") REFERENCES "FeedRun" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("gameweek_id") REFERENCES "Gameweek" ("id") ON DELETE SET NULL
);
CREATE INDEX "FixtureObservation_gameweek_kickoff_idx" ON "FixtureObservation" ("gameweek_id", "kickoff_at");

CREATE TABLE "Player" (
  "id" TEXT PRIMARY KEY,
  "season" TEXT NOT NULL,
  "fpl_id" INTEGER NOT NULL,
  "first_name" TEXT,
  "second_name" TEXT,
  "web_name" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE UNIQUE INDEX "Player_season_fpl_id_unique" ON "Player" ("season", "fpl_id");

CREATE TABLE "PlayerObservation" (
  "id" TEXT PRIMARY KEY,
  "player_id" TEXT NOT NULL,
  "feed_run_id" TEXT NOT NULL,
  "observed_at" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "position" TEXT NOT NULL CHECK ("position" IN ('GK', 'DEF', 'MID', 'FWD')),
  "active" INTEGER NOT NULL CHECK ("active" IN (0, 1)),
  "status" TEXT,
  "chance_of_playing" INTEGER CHECK ("chance_of_playing" IS NULL OR "chance_of_playing" BETWEEN 0 AND 100),
  "news" TEXT,
  "news_added_at" TEXT,
  "price_tenths" INTEGER NOT NULL CHECK ("price_tenths" >= 0),
  "ownership_percent" REAL NOT NULL DEFAULT 0 CHECK ("ownership_percent" >= 0),
  "transfers_in" INTEGER NOT NULL DEFAULT 0 CHECK ("transfers_in" >= 0),
  "transfers_out" INTEGER NOT NULL DEFAULT 0 CHECK ("transfers_out" >= 0),
  "minutes" INTEGER NOT NULL DEFAULT 0 CHECK ("minutes" >= 0),
  "starts" INTEGER NOT NULL DEFAULT 0 CHECK ("starts" >= 0),
  "total_points" INTEGER NOT NULL DEFAULT 0,
  "points_per_game" REAL NOT NULL DEFAULT 0,
  "form" REAL NOT NULL DEFAULT 0,
  "ep_next" REAL NOT NULL DEFAULT 0,
  "goals" INTEGER NOT NULL DEFAULT 0 CHECK ("goals" >= 0),
  "assists" INTEGER NOT NULL DEFAULT 0 CHECK ("assists" >= 0),
  "clean_sheets" INTEGER NOT NULL DEFAULT 0 CHECK ("clean_sheets" >= 0),
  "goals_conceded" INTEGER NOT NULL DEFAULT 0 CHECK ("goals_conceded" >= 0),
  "saves" INTEGER NOT NULL DEFAULT 0 CHECK ("saves" >= 0),
  "bonus" INTEGER NOT NULL DEFAULT 0 CHECK ("bonus" >= 0),
  "bps" INTEGER NOT NULL DEFAULT 0,
  "yellow_cards" INTEGER NOT NULL DEFAULT 0 CHECK ("yellow_cards" >= 0),
  "red_cards" INTEGER NOT NULL DEFAULT 0 CHECK ("red_cards" >= 0),
  "own_goals" INTEGER NOT NULL DEFAULT 0 CHECK ("own_goals" >= 0),
  "penalties_missed" INTEGER NOT NULL DEFAULT 0 CHECK ("penalties_missed" >= 0),
  "penalties_saved" INTEGER NOT NULL DEFAULT 0 CHECK ("penalties_saved" >= 0),
  "expected_goals" REAL NOT NULL DEFAULT 0 CHECK ("expected_goals" >= 0),
  "expected_assists" REAL NOT NULL DEFAULT 0 CHECK ("expected_assists" >= 0),
  "expected_goal_involvements" REAL NOT NULL DEFAULT 0 CHECK ("expected_goal_involvements" >= 0),
  "expected_goals_conceded" REAL NOT NULL DEFAULT 0 CHECK ("expected_goals_conceded" >= 0),
  "expected_goals_per_90" REAL NOT NULL DEFAULT 0 CHECK ("expected_goals_per_90" >= 0),
  "expected_assists_per_90" REAL NOT NULL DEFAULT 0 CHECK ("expected_assists_per_90" >= 0),
  "expected_goal_involvements_per_90" REAL NOT NULL DEFAULT 0 CHECK ("expected_goal_involvements_per_90" >= 0),
  "expected_goals_conceded_per_90" REAL NOT NULL DEFAULT 0 CHECK ("expected_goals_conceded_per_90" >= 0),
  "clearances_blocks_interceptions" INTEGER NOT NULL DEFAULT 0 CHECK ("clearances_blocks_interceptions" >= 0),
  "tackles" INTEGER NOT NULL DEFAULT 0 CHECK ("tackles" >= 0),
  "recoveries" INTEGER NOT NULL DEFAULT 0 CHECK ("recoveries" >= 0),
  "defensive_contribution" REAL NOT NULL DEFAULT 0 CHECK ("defensive_contribution" >= 0),
  "defensive_contribution_per_90" REAL NOT NULL DEFAULT 0 CHECK ("defensive_contribution_per_90" >= 0),
  "raw_payload_json" TEXT NOT NULL,
  UNIQUE ("player_id", "feed_run_id"),
  FOREIGN KEY ("player_id") REFERENCES "Player" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("feed_run_id") REFERENCES "FeedRun" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("team_id") REFERENCES "Team" ("id") ON DELETE RESTRICT
);
CREATE INDEX "PlayerObservation_player_observed_idx" ON "PlayerObservation" ("player_id", "observed_at" DESC);

CREATE TABLE "PlayerFixtureResult" (
  "player_id" TEXT NOT NULL,
  "fixture_id" TEXT NOT NULL,
  "gameweek_id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "opponent_team_id" TEXT NOT NULL,
  "was_home" INTEGER NOT NULL CHECK ("was_home" IN (0, 1)),
  "kickoff_at" TEXT NOT NULL,
  "minutes" INTEGER NOT NULL DEFAULT 0 CHECK ("minutes" >= 0),
  "total_points" INTEGER NOT NULL DEFAULT 0,
  "goals" INTEGER NOT NULL DEFAULT 0 CHECK ("goals" >= 0),
  "assists" INTEGER NOT NULL DEFAULT 0 CHECK ("assists" >= 0),
  "clean_sheets" INTEGER NOT NULL DEFAULT 0 CHECK ("clean_sheets" >= 0),
  "goals_conceded" INTEGER NOT NULL DEFAULT 0 CHECK ("goals_conceded" >= 0),
  "saves" INTEGER NOT NULL DEFAULT 0 CHECK ("saves" >= 0),
  "bonus" INTEGER NOT NULL DEFAULT 0 CHECK ("bonus" >= 0),
  "bps" INTEGER NOT NULL DEFAULT 0,
  "yellow_cards" INTEGER NOT NULL DEFAULT 0 CHECK ("yellow_cards" >= 0),
  "red_cards" INTEGER NOT NULL DEFAULT 0 CHECK ("red_cards" >= 0),
  "own_goals" INTEGER NOT NULL DEFAULT 0 CHECK ("own_goals" >= 0),
  "penalties_missed" INTEGER NOT NULL DEFAULT 0 CHECK ("penalties_missed" >= 0),
  "penalties_saved" INTEGER NOT NULL DEFAULT 0 CHECK ("penalties_saved" >= 0),
  "clearances_blocks_interceptions" INTEGER NOT NULL DEFAULT 0 CHECK ("clearances_blocks_interceptions" >= 0),
  "tackles" INTEGER NOT NULL DEFAULT 0 CHECK ("tackles" >= 0),
  "recoveries" INTEGER NOT NULL DEFAULT 0 CHECK ("recoveries" >= 0),
  "defensive_contribution" REAL NOT NULL DEFAULT 0 CHECK ("defensive_contribution" >= 0),
  PRIMARY KEY ("player_id", "fixture_id"),
  FOREIGN KEY ("player_id") REFERENCES "Player" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("fixture_id") REFERENCES "Fixture" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("gameweek_id") REFERENCES "Gameweek" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("team_id") REFERENCES "Team" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("opponent_team_id") REFERENCES "Team" ("id") ON DELETE RESTRICT
);

CREATE TABLE "UnderlyingObservation" (
  "id" TEXT PRIMARY KEY,
  "feed_run_id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "source_player_id" TEXT NOT NULL,
  "source_player_name" TEXT NOT NULL,
  "source_team_name" TEXT,
  "season" TEXT NOT NULL,
  "player_id" TEXT,
  "match_status" TEXT NOT NULL CHECK ("match_status" IN ('MATCHED', 'AMBIGUOUS', 'UNMATCHED', 'REJECTED')),
  "match_confidence" REAL NOT NULL CHECK ("match_confidence" BETWEEN 0 AND 1),
  "observed_at" TEXT NOT NULL,
  "games" INTEGER NOT NULL DEFAULT 0 CHECK ("games" >= 0),
  "minutes" INTEGER NOT NULL DEFAULT 0 CHECK ("minutes" >= 0),
  "goals" INTEGER NOT NULL DEFAULT 0 CHECK ("goals" >= 0),
  "assists" INTEGER NOT NULL DEFAULT 0 CHECK ("assists" >= 0),
  "shots" INTEGER NOT NULL DEFAULT 0 CHECK ("shots" >= 0),
  "key_passes" INTEGER NOT NULL DEFAULT 0 CHECK ("key_passes" >= 0),
  "expected_goals" REAL NOT NULL DEFAULT 0 CHECK ("expected_goals" >= 0),
  "expected_assists" REAL NOT NULL DEFAULT 0 CHECK ("expected_assists" >= 0),
  "non_penalty_expected_goals" REAL NOT NULL DEFAULT 0 CHECK ("non_penalty_expected_goals" >= 0),
  "xg_per_90" REAL NOT NULL DEFAULT 0 CHECK ("xg_per_90" >= 0),
  "xa_per_90" REAL NOT NULL DEFAULT 0 CHECK ("xa_per_90" >= 0),
  "raw_payload_json" TEXT NOT NULL,
  FOREIGN KEY ("feed_run_id") REFERENCES "FeedRun" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("player_id") REFERENCES "Player" ("id") ON DELETE SET NULL
);
CREATE INDEX "UnderlyingObservation_player_observed_idx" ON "UnderlyingObservation" ("player_id", "observed_at" DESC);
CREATE INDEX "UnderlyingObservation_status_observed_idx" ON "UnderlyingObservation" ("match_status", "observed_at" DESC);

CREATE TABLE "MarketFixtureObservation" (
  "id" TEXT PRIMARY KEY,
  "feed_run_id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "external_event_id" TEXT NOT NULL,
  "fixture_id" TEXT,
  "captured_at" TEXT NOT NULL,
  "kickoff_at" TEXT,
  "home_team_name" TEXT NOT NULL,
  "away_team_name" TEXT NOT NULL,
  "home_win_probability" REAL CHECK ("home_win_probability" IS NULL OR "home_win_probability" BETWEEN 0 AND 1),
  "draw_probability" REAL CHECK ("draw_probability" IS NULL OR "draw_probability" BETWEEN 0 AND 1),
  "away_win_probability" REAL CHECK ("away_win_probability" IS NULL OR "away_win_probability" BETWEEN 0 AND 1),
  "over_2_5_probability" REAL CHECK ("over_2_5_probability" IS NULL OR "over_2_5_probability" BETWEEN 0 AND 1),
  "btts_probability" REAL CHECK ("btts_probability" IS NULL OR "btts_probability" BETWEEN 0 AND 1),
  "home_expected_goals" REAL CHECK ("home_expected_goals" IS NULL OR "home_expected_goals" >= 0),
  "away_expected_goals" REAL CHECK ("away_expected_goals" IS NULL OR "away_expected_goals" >= 0),
  "derivation_method" TEXT,
  "raw_payload_json" TEXT NOT NULL,
  UNIQUE ("source", "external_event_id", "captured_at"),
  FOREIGN KEY ("feed_run_id") REFERENCES "FeedRun" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("fixture_id") REFERENCES "Fixture" ("id") ON DELETE SET NULL
);

CREATE TABLE "PlayerSignal" (
  "id" TEXT PRIMARY KEY,
  "player_id" TEXT NOT NULL,
  "gameweek_id" TEXT,
  "kind" TEXT NOT NULL,
  "value_json" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_url" TEXT,
  "evidence_summary" TEXT NOT NULL,
  "confidence" REAL NOT NULL CHECK ("confidence" BETWEEN 0 AND 1),
  "observed_at" TEXT NOT NULL,
  "valid_until" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED')),
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("player_id") REFERENCES "Player" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("gameweek_id") REFERENCES "Gameweek" ("id") ON DELETE SET NULL
);
CREATE INDEX "PlayerSignal_player_status_valid_idx" ON "PlayerSignal" ("player_id", "status", "valid_until");
CREATE INDEX "PlayerSignal_gameweek_idx" ON "PlayerSignal" ("gameweek_id");

CREATE TABLE "PlayerSignalAudit" (
  "id" TEXT PRIMARY KEY,
  "signal_id" TEXT NOT NULL,
  "from_status" TEXT,
  "to_status" TEXT NOT NULL CHECK ("to_status" IN ('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED')),
  "reason" TEXT NOT NULL,
  "actor_type" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("signal_id") REFERENCES "PlayerSignal" ("id") ON DELETE RESTRICT
);
CREATE INDEX "PlayerSignalAudit_signal_created_idx" ON "PlayerSignalAudit" ("signal_id", "created_at" DESC);

CREATE TABLE "ForecastRun" (
  "id" TEXT PRIMARY KEY,
  "model_version" TEXT NOT NULL,
  "gameweek_id" TEXT NOT NULL,
  "max_gameweeks" INTEGER NOT NULL DEFAULT 5 CHECK ("max_gameweeks" > 0),
  "as_of" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "deadline_at" TEXT,
  "status" TEXT NOT NULL CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  "eligible_for_backtest" INTEGER NOT NULL DEFAULT 0 CHECK ("eligible_for_backtest" IN (0, 1)),
  "official_feed_run_id" TEXT NOT NULL,
  "underlying_feed_run_id" TEXT,
  "market_feed_run_id" TEXT,
  "signal_version" TEXT NOT NULL,
  "calibration_version" TEXT,
  "input_hash" TEXT NOT NULL,
  "config_json" TEXT NOT NULL,
  "error_summary" TEXT,
  FOREIGN KEY ("gameweek_id") REFERENCES "Gameweek" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("official_feed_run_id") REFERENCES "FeedRun" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("underlying_feed_run_id") REFERENCES "FeedRun" ("id") ON DELETE SET NULL,
  FOREIGN KEY ("market_feed_run_id") REFERENCES "FeedRun" ("id") ON DELETE SET NULL
);
CREATE INDEX "ForecastRun_gameweek_created_idx" ON "ForecastRun" ("gameweek_id", "created_at" DESC);
CREATE INDEX "ForecastRun_backtest_idx" ON "ForecastRun" ("eligible_for_backtest", "status", "created_at" DESC);

CREATE TABLE "PlayerFixtureForecast" (
  "forecast_run_id" TEXT NOT NULL,
  "player_id" TEXT NOT NULL,
  "fixture_id" TEXT NOT NULL,
  "expected_minutes" REAL NOT NULL CHECK ("expected_minutes" >= 0),
  "appearance_points" REAL NOT NULL,
  "goal_points" REAL NOT NULL,
  "assist_points" REAL NOT NULL,
  "clean_sheet_points" REAL NOT NULL,
  "goals_conceded_points" REAL NOT NULL,
  "save_points" REAL NOT NULL,
  "penalty_points" REAL NOT NULL,
  "defensive_contribution_points" REAL NOT NULL,
  "bonus_points" REAL NOT NULL,
  "card_points" REAL NOT NULL,
  "mean_points" REAL NOT NULL,
  "standard_deviation" REAL NOT NULL CHECK ("standard_deviation" >= 0),
  "p10_points" REAL NOT NULL,
  "p50_points" REAL NOT NULL,
  "p90_points" REAL NOT NULL,
  "start_probability" REAL NOT NULL CHECK ("start_probability" BETWEEN 0 AND 1),
  "substitute_probability" REAL NOT NULL CHECK ("substitute_probability" BETWEEN 0 AND 1),
  "no_show_probability" REAL NOT NULL CHECK ("no_show_probability" BETWEEN 0 AND 1),
  "minutes_confidence" TEXT NOT NULL,
  "strength_method" TEXT NOT NULL,
  "role_source_json" TEXT NOT NULL,
  "input_provenance_json" TEXT NOT NULL,
  PRIMARY KEY ("forecast_run_id", "player_id", "fixture_id"),
  CHECK (ABS(("start_probability" + "substitute_probability" + "no_show_probability") - 1.0) <= 0.000001),
  CHECK ("p10_points" <= "p50_points" AND "p50_points" <= "p90_points"),
  FOREIGN KEY ("forecast_run_id") REFERENCES "ForecastRun" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("player_id") REFERENCES "Player" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("fixture_id") REFERENCES "Fixture" ("id") ON DELETE RESTRICT
);
CREATE INDEX "PlayerFixtureForecast_player_fixture_idx" ON "PlayerFixtureForecast" ("player_id", "fixture_id");

CREATE TABLE "CalibrationSet" (
  "id" TEXT PRIMARY KEY,
  "model_version" TEXT NOT NULL,
  "trained_at" TEXT NOT NULL,
  "training_cutoff" TEXT NOT NULL,
  "observation_count" INTEGER NOT NULL CHECK ("observation_count" >= 0),
  "status" TEXT NOT NULL,
  "config_json" TEXT NOT NULL
);

CREATE TABLE "CalibrationMetric" (
  "calibration_set_id" TEXT NOT NULL,
  "position" TEXT NOT NULL,
  "horizon" INTEGER NOT NULL CHECK ("horizon" > 0),
  "confidence_band" TEXT NOT NULL,
  "strength_method" TEXT NOT NULL,
  "sample_size" INTEGER NOT NULL CHECK ("sample_size" >= 0),
  "mae" REAL NOT NULL CHECK ("mae" >= 0),
  "rmse" REAL NOT NULL CHECK ("rmse" >= 0),
  "bias" REAL NOT NULL,
  "interval_coverage" REAL NOT NULL CHECK ("interval_coverage" BETWEEN 0 AND 1),
  "rank_correlation" REAL,
  "applied_factor" REAL NOT NULL,
  PRIMARY KEY ("calibration_set_id", "position", "horizon", "confidence_band", "strength_method"),
  FOREIGN KEY ("calibration_set_id") REFERENCES "CalibrationSet" ("id") ON DELETE RESTRICT
);

CREATE TABLE "ManagerAccount" (
  "id" TEXT PRIMARY KEY,
  "fpl_entry_id" INTEGER NOT NULL UNIQUE,
  "team_name" TEXT NOT NULL,
  "manager_name" TEXT NOT NULL,
  "total_points" INTEGER NOT NULL DEFAULT 0,
  "gameweek_points" INTEGER NOT NULL DEFAULT 0,
  "overall_rank" INTEGER,
  "current_gameweek" INTEGER,
  "last_imported_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);

CREATE TABLE "OfficialSquadSnapshot" (
  "id" TEXT PRIMARY KEY,
  "manager_account_id" TEXT NOT NULL,
  "gameweek_id" TEXT NOT NULL,
  "imported_at" TEXT NOT NULL,
  "bank_tenths" INTEGER NOT NULL CHECK ("bank_tenths" >= 0),
  "squad_value_tenths" INTEGER NOT NULL CHECK ("squad_value_tenths" >= 0),
  "active_chip" TEXT,
  "event_transfers" INTEGER NOT NULL DEFAULT 0 CHECK ("event_transfers" >= 0),
  "event_transfer_cost" INTEGER NOT NULL DEFAULT 0 CHECK ("event_transfer_cost" >= 0),
  "captain_player_id" TEXT,
  "vice_captain_player_id" TEXT,
  "raw_payload_json" TEXT NOT NULL,
  FOREIGN KEY ("manager_account_id") REFERENCES "ManagerAccount" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("gameweek_id") REFERENCES "Gameweek" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("captain_player_id") REFERENCES "Player" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("vice_captain_player_id") REFERENCES "Player" ("id") ON DELETE RESTRICT
);
CREATE INDEX "OfficialSquadSnapshot_manager_imported_idx" ON "OfficialSquadSnapshot" ("manager_account_id", "imported_at" DESC);

CREATE TABLE "OfficialSquadPlayer" (
  "squad_snapshot_id" TEXT NOT NULL,
  "player_id" TEXT NOT NULL,
  "position" TEXT NOT NULL CHECK ("position" IN ('GK', 'DEF', 'MID', 'FWD')),
  "squad_order" INTEGER NOT NULL CHECK ("squad_order" >= 0),
  "multiplier" INTEGER NOT NULL DEFAULT 1 CHECK ("multiplier" IN (0, 1, 2, 3)),
  "is_captain" INTEGER NOT NULL DEFAULT 0 CHECK ("is_captain" IN (0, 1)),
  "is_vice_captain" INTEGER NOT NULL DEFAULT 0 CHECK ("is_vice_captain" IN (0, 1)),
  "purchase_price_tenths" INTEGER CHECK ("purchase_price_tenths" IS NULL OR "purchase_price_tenths" >= 0),
  "selling_price_tenths" INTEGER CHECK ("selling_price_tenths" IS NULL OR "selling_price_tenths" >= 0),
  "economics_source" TEXT NOT NULL CHECK ("economics_source" IN ('OFFICIAL', 'USER_CONFIRMED', 'UNKNOWN')),
  PRIMARY KEY ("squad_snapshot_id", "player_id"),
  FOREIGN KEY ("squad_snapshot_id") REFERENCES "OfficialSquadSnapshot" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("player_id") REFERENCES "Player" ("id") ON DELETE RESTRICT
);

CREATE TABLE "ManagerAssumption" (
  "id" TEXT PRIMARY KEY,
  "manager_account_id" TEXT NOT NULL,
  "gameweek_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "value_json" TEXT NOT NULL,
  "source" TEXT NOT NULL CHECK ("source" IN ('USER_CONFIRMED', 'IMPORTED')),
  "created_at" TEXT NOT NULL,
  "supersedes_id" TEXT,
  FOREIGN KEY ("manager_account_id") REFERENCES "ManagerAccount" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("gameweek_id") REFERENCES "Gameweek" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("supersedes_id") REFERENCES "ManagerAssumption" ("id") ON DELETE SET NULL
);
CREATE INDEX "ManagerAssumption_manager_gameweek_idx" ON "ManagerAssumption" ("manager_account_id", "gameweek_id", "created_at" DESC);

CREATE TABLE "Plan" (
  "id" TEXT PRIMARY KEY,
  "manager_account_id" TEXT NOT NULL,
  "official_squad_snapshot_id" TEXT NOT NULL,
  "parent_plan_id" TEXT,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('ACTIVE', 'SAVED', 'ARCHIVED')),
  "bank_tenths" INTEGER CHECK ("bank_tenths" IS NULL OR "bank_tenths" >= 0),
  "free_transfers" INTEGER NOT NULL CHECK ("free_transfers" >= 0),
  "created_at" TEXT NOT NULL,
  "change_summary_json" TEXT NOT NULL,
  FOREIGN KEY ("manager_account_id") REFERENCES "ManagerAccount" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("official_squad_snapshot_id") REFERENCES "OfficialSquadSnapshot" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("parent_plan_id") REFERENCES "Plan" ("id") ON DELETE SET NULL
);
CREATE INDEX "Plan_manager_status_created_idx" ON "Plan" ("manager_account_id", "status", "created_at" DESC);

CREATE TABLE "PlanPlayer" (
  "plan_id" TEXT NOT NULL,
  "player_id" TEXT NOT NULL,
  "squad_slot" INTEGER NOT NULL CHECK ("squad_slot" >= 0),
  "planned_purchase_price_tenths" INTEGER CHECK ("planned_purchase_price_tenths" IS NULL OR "planned_purchase_price_tenths" >= 0),
  "inherited_selling_price_tenths" INTEGER CHECK ("inherited_selling_price_tenths" IS NULL OR "inherited_selling_price_tenths" >= 0),
  "is_captain" INTEGER NOT NULL DEFAULT 0 CHECK ("is_captain" IN (0, 1)),
  "is_vice_captain" INTEGER NOT NULL DEFAULT 0 CHECK ("is_vice_captain" IN (0, 1)),
  "bench_order" INTEGER CHECK ("bench_order" IS NULL OR "bench_order" >= 0),
  "locked" INTEGER NOT NULL DEFAULT 0 CHECK ("locked" IN (0, 1)),
  PRIMARY KEY ("plan_id", "player_id"),
  FOREIGN KEY ("plan_id") REFERENCES "Plan" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("player_id") REFERENCES "Player" ("id") ON DELETE RESTRICT
);

CREATE TABLE "RecommendationSet" (
  "id" TEXT PRIMARY KEY,
  "plan_id" TEXT NOT NULL,
  "forecast_run_id" TEXT NOT NULL,
  "horizon" INTEGER NOT NULL CHECK ("horizon" > 0),
  "max_transfers" INTEGER NOT NULL CHECK ("max_transfers" BETWEEN 0 AND 5),
  "chip" TEXT,
  "uncertainty_penalty_rate" REAL NOT NULL CHECK ("uncertainty_penalty_rate" >= 0),
  "created_at" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "primary_candidate_id" TEXT,
  "input_hash" TEXT NOT NULL,
  FOREIGN KEY ("plan_id") REFERENCES "Plan" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("forecast_run_id") REFERENCES "ForecastRun" ("id") ON DELETE RESTRICT
);
CREATE INDEX "RecommendationSet_plan_created_idx" ON "RecommendationSet" ("plan_id", "created_at" DESC);

CREATE TABLE "RecommendationCandidate" (
  "id" TEXT PRIMARY KEY,
  "recommendation_set_id" TEXT NOT NULL,
  "rank" INTEGER NOT NULL CHECK ("rank" > 0),
  "action" TEXT NOT NULL CHECK ("action" IN ('ROLL', 'TRANSFER', 'CHIP', 'INSUFFICIENT_DATA')),
  "moves_json" TEXT NOT NULL,
  "raw_gain" REAL NOT NULL,
  "hit_cost" INTEGER NOT NULL CHECK ("hit_cost" >= 0),
  "uncertainty_penalty" REAL NOT NULL CHECK ("uncertainty_penalty" >= 0),
  "net_expected_gain" REAL NOT NULL,
  "probability_beats_roll" REAL CHECK ("probability_beats_roll" IS NULL OR "probability_beats_roll" BETWEEN 0 AND 1),
  "bank_after_tenths" INTEGER,
  "affordability_status" TEXT NOT NULL,
  "expected_team_points" REAL NOT NULL,
  "p10_points" REAL,
  "p50_points" REAL,
  "p90_points" REAL,
  UNIQUE ("recommendation_set_id", "rank"),
  FOREIGN KEY ("recommendation_set_id") REFERENCES "RecommendationSet" ("id") ON DELETE RESTRICT
);

CREATE TABLE "DecisionRecord" (
  "id" TEXT PRIMARY KEY,
  "recommendation_set_id" TEXT NOT NULL,
  "candidate_id" TEXT,
  "decision" TEXT NOT NULL CHECK ("decision" IN ('ACCEPTED', 'REJECTED', 'IGNORED', 'CUSTOM')),
  "selected_plan_id" TEXT,
  "reason" TEXT,
  "created_at" TEXT NOT NULL,
  "evaluated_at" TEXT,
  "realized_points_delta" REAL,
  "outcome_json" TEXT,
  FOREIGN KEY ("recommendation_set_id") REFERENCES "RecommendationSet" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("candidate_id") REFERENCES "RecommendationCandidate" ("id") ON DELETE SET NULL,
  FOREIGN KEY ("selected_plan_id") REFERENCES "Plan" ("id") ON DELETE SET NULL
);
CREATE INDEX "DecisionRecord_recommendation_created_idx" ON "DecisionRecord" ("recommendation_set_id", "created_at" DESC);

CREATE TABLE "AppSetting" (
  "key" TEXT PRIMARY KEY,
  "value_json" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
