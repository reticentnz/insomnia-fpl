# Insomnia FPL Rebuild: Data Dictionary

This document defines the canonical SQLite schema and field provenance. SQL migrations are authoritative once implemented. Timestamps are UTC ISO-8601 text values. Boolean fields are SQLite integers constrained to `0` or `1`.

## Conventions

- Primary identifiers use `TEXT PRIMARY KEY` UUIDs or deterministic season-scoped keys. Official numeric IDs are stored separately as `fpl_id` and are unique only within a season.
- Foreign keys are enabled and must use explicit `ON DELETE` behavior.
- JSON is stored as canonical JSON text and validated in application code.
- Money is stored as integer tenths of a million (`price_tenths`). Never store FPL prices as binary floats.
- Probabilities are real numbers constrained to `[0,1]`.
- Immutable observation tables have no update path other than correcting a failed development migration.
- `created_at` means application record creation. `observed_at` means source observation time. `source_updated_at` means a timestamp supplied by the source.

## SchemaMigration

| Column | Type | Rule |
|---|---|---|
| version | TEXT PK | Migration filename/version |
| checksum | TEXT | SHA-256 of migration contents |
| applied_at | TEXT | UTC application time |

## FeedRun

One attempted refresh of an external data source.

| Column | Type | Rule |
|---|---|---|
| id | TEXT PK | UUID |
| source | TEXT | `OFFICIAL_FPL`, `UNDERLYING`, `MARKET`, `CREATOR`, `RESEARCH` |
| status | TEXT | `RUNNING`, `SUCCEEDED`, `PARTIAL`, `FAILED` |
| started_at | TEXT | Required |
| finished_at | TEXT nullable | Set on completion |
| source_updated_at | TEXT nullable | Supplied by source when available |
| payload_hash | TEXT nullable | SHA-256 aggregate |
| request_count | INTEGER | Default 0 |
| inserted_count | INTEGER | Default 0 |
| updated_count | INTEGER | Default 0 |
| unmatched_count | INTEGER | Default 0 |
| used_cache | INTEGER | Boolean |
| cache_captured_at | TEXT nullable | Original cache time |
| error_summary | TEXT nullable | Sanitized, no secrets |
| metadata_json | TEXT | Default `{}` |

Indexes: `(source, started_at DESC)`, `(status, started_at DESC)`.

## Team

| Column | Type | Rule |
|---|---|---|
| id | TEXT PK | Internal season-safe ID |
| season | TEXT | Required |
| fpl_id | INTEGER | Official FPL team ID within season |
| name | TEXT | Official name |
| short_name | TEXT | Official short name |
| created_at | TEXT | Required |

Unique: `(season, fpl_id)`.

## TeamObservation

Immutable official team-strength snapshot.

| Column | Type | Rule |
|---|---|---|
| id | TEXT PK | UUID |
| team_id | TEXT FK | Required |
| feed_run_id | TEXT FK | Required |
| observed_at | TEXT | Required |
| strength_attack_home | REAL nullable | Official fact |
| strength_attack_away | REAL nullable | Official fact |
| strength_defence_home | REAL nullable | Official fact |
| strength_defence_away | REAL nullable | Official fact |
| active | INTEGER | Boolean |
| raw_payload_json | TEXT | Required |

Unique: `(team_id, feed_run_id)`.

## Gameweek

| Column | Type | Rule |
|---|---|---|
| id | TEXT PK | Internal season-safe ID |
| season | TEXT | Required |
| fpl_id | INTEGER | Official event number within season |
| name | TEXT | Official label |
| created_at | TEXT | Required |

Unique: `(season, fpl_id)`.

## GameweekObservation

| Column | Type | Rule |
|---|---|---|
| id | TEXT PK | UUID |
| gameweek_id | TEXT FK | Required |
| feed_run_id | TEXT FK | Required |
| observed_at | TEXT | Required |
| deadline_at | TEXT nullable | Official deadline |
| finished | INTEGER | Boolean |
| is_current | INTEGER | Boolean |
| is_next | INTEGER | Boolean |
| raw_payload_json | TEXT | Required |

Unique: `(gameweek_id, feed_run_id)`.

## Fixture

Stable season-scoped fixture identity. Changing schedule and difficulty facts belong in `FixtureObservation`.

| Column | Type | Rule |
|---|---|---|
| id | TEXT PK | Internal season-safe ID |
| season | TEXT | Required |
| fpl_id | INTEGER | Official fixture ID within season |
| home_team_id | TEXT FK | Required |
| away_team_id | TEXT FK | Required |
| created_at | TEXT | Required |

Unique: `(season, fpl_id)`.

## FixtureObservation

| Column | Type | Rule |
|---|---|---|
| id | TEXT PK | UUID |
| fixture_id | TEXT FK | Required |
| feed_run_id | TEXT FK | Required |
| observed_at | TEXT | Required |
| gameweek_id | TEXT FK nullable | Null for unscheduled/postponed fixture |
| kickoff_at | TEXT nullable | Official kickoff |
| difficulty_home | INTEGER nullable | 1–5 official FDR |
| difficulty_away | INTEGER nullable | 1–5 official FDR |
| started | INTEGER | Boolean |
| finished | INTEGER | Boolean |
| raw_payload_json | TEXT | Required |

Unique: `(fixture_id, feed_run_id)`. Index: `(gameweek_id, kickoff_at)`.

## Player

Stable player identity, not a statistical snapshot.

| Column | Type | Rule |
|---|---|---|
| id | TEXT PK | Internal season-safe ID |
| season | TEXT | Required |
| fpl_id | INTEGER | Official player ID within season |
| first_name | TEXT nullable | Official |
| second_name | TEXT nullable | Official |
| web_name | TEXT | Official display name |
| created_at | TEXT | Required |
| updated_at | TEXT | Identity update time |

Do not put changing statistics in this table.

Unique: `(season, fpl_id)`.

## PlayerObservation

Immutable official snapshot for a player.

| Column group | Fields |
|---|---|
| Identity | `id TEXT PK`, `player_id FK`, `feed_run_id FK`, `observed_at` |
| Registration | `team_id FK`, `position`, `active` |
| Availability | `status`, `chance_of_playing`, `news`, `news_added_at` |
| Market | `price_tenths`, `ownership_percent`, `transfers_in`, `transfers_out` |
| Playing time | `minutes`, `starts` |
| Returns | `total_points`, `points_per_game`, `form`, `ep_next`, `goals`, `assists`, `clean_sheets`, `goals_conceded`, `saves`, `bonus`, `bps` |
| Discipline/events | `yellow_cards`, `red_cards`, `own_goals`, `penalties_missed`, `penalties_saved` |
| Expected data | `expected_goals`, `expected_assists`, `expected_goal_involvements`, `expected_goals_conceded`, and official per-90 equivalents |
| Defensive contribution | `clearances_blocks_interceptions`, `tackles`, `recoveries`, `defensive_contribution`, `defensive_contribution_per_90` |
| Raw | `raw_payload_json` |

Unique: `(player_id, feed_run_id)`. Index: `(player_id, observed_at DESC)`.

## PlayerFixtureResult

Official completed-player result, upsertable until the fixture is officially finished, then immutable for normal operation.

Required identity uses internal text foreign keys: `player_id`, `fixture_id`, `gameweek_id`, `team_id`, `opponent_team_id`, plus `was_home` and `kickoff_at`.

Stat fields match the scoring inputs in `src/core/scoring.ts`, including minutes, total points, goals, assists, clean sheets, goals conceded, saves, bonus, BPS, cards, own goals, penalties and defensive contributions.

Primary key: `(player_id, fixture_id)`.

## UnderlyingObservation

| Column | Type | Rule |
|---|---|---|
| id | TEXT PK | UUID |
| feed_run_id | TEXT FK | Required |
| source | TEXT | Provider name |
| source_player_id | TEXT | Required |
| source_player_name | TEXT | Required |
| source_team_name | TEXT nullable | Matching evidence |
| season | TEXT | Required |
| player_id | TEXT FK nullable | Null until resolved |
| match_status | TEXT | `MATCHED`, `AMBIGUOUS`, `UNMATCHED`, `REJECTED` |
| match_confidence | REAL | 0–1 |
| observed_at | TEXT | Required |
| games, minutes, goals, assists, shots, key_passes | INTEGER | Non-negative |
| expected_goals, expected_assists, non_penalty_expected_goals | REAL | Non-negative |
| xg_per_90, xa_per_90 | REAL | Non-negative |
| raw_payload_json | TEXT | Required |

Indexes: `(player_id, observed_at DESC)`, `(match_status, observed_at DESC)`.

## MarketFixtureObservation

| Column | Type | Rule |
|---|---|---|
| id | TEXT PK | UUID |
| feed_run_id | TEXT FK | Required |
| source | TEXT | Provider |
| external_event_id | TEXT | Required |
| fixture_id | TEXT FK nullable | Null until resolved |
| captured_at | TEXT | Required |
| kickoff_at | TEXT nullable | Source kickoff |
| home_team_name, away_team_name | TEXT | Source values |
| home_win_probability, draw_probability, away_win_probability | REAL nullable | De-vigged |
| over_2_5_probability, btts_probability | REAL nullable | De-vigged |
| home_expected_goals, away_expected_goals | REAL nullable | Only when derivable |
| derivation_method | TEXT nullable | Formula/version |
| raw_payload_json | TEXT | Required |

Unique: `(source, external_event_id, captured_at)`.

## PlayerSignal

| Column | Type | Rule |
|---|---|---|
| id | TEXT PK | UUID |
| player_id | TEXT FK | Required |
| gameweek_id | TEXT FK nullable | Null means cross-gameweek until expiry |
| kind | TEXT | Enumerated application kind |
| value_json | TEXT | Validated typed value |
| source_type | TEXT | Official, journalist, research, creator, user, manual |
| source_url | TEXT nullable | Sanitized HTTP(S) URL |
| evidence_summary | TEXT | Required |
| confidence | REAL | 0–1 |
| observed_at | TEXT | Required |
| valid_until | TEXT | Required |
| status | TEXT | `PENDING`, `VERIFIED`, `REJECTED`, `EXPIRED` |
| created_at, updated_at | TEXT | Required |

## PlayerSignalAudit

Append-only status history: `id`, `signal_id`, `from_status`, `to_status`, `reason`, `actor_type`, `created_at`.

## ForecastRun

| Column | Type | Rule |
|---|---|---|
| id | TEXT PK | UUID |
| model_version | TEXT | Required |
| gameweek_id | TEXT FK | First target deadline gameweek |
| max_gameweeks | INTEGER | Number of future gameweeks covered, default 5 |
| as_of | TEXT | Facts cutoff |
| created_at | TEXT | Required |
| deadline_at | TEXT nullable | Copied at creation |
| status | TEXT | `RUNNING`, `SUCCEEDED`, `FAILED` |
| eligible_for_backtest | INTEGER | True only if `created_at <= deadline_at` and run succeeded |
| official_feed_run_id | TEXT FK | Required |
| underlying_feed_run_id | TEXT FK nullable | Exact selected run |
| market_feed_run_id | TEXT FK nullable | Exact selected run |
| signal_version | TEXT | Hash of eligible signals |
| calibration_version | TEXT nullable | Applied calibration set |
| input_hash | TEXT | Hash of canonical assembled inputs |
| config_json | TEXT | Priors, thresholds, simulation count, seed version |
| error_summary | TEXT nullable | Sanitized |

No update after reaching `SUCCEEDED`, except a one-way administrative invalidation field if later required.

## PlayerFixtureForecast

Primary key: `(forecast_run_id, player_id, fixture_id)` using internal text IDs.

Fields:

- `expected_minutes`
- `appearance_points`
- `goal_points`
- `assist_points`
- `clean_sheet_points`
- `goals_conceded_points`
- `save_points`
- `penalty_points`
- `defensive_contribution_points`
- `bonus_points`
- `card_points`
- `mean_points`
- `standard_deviation`
- `p10_points`, `p50_points`, `p90_points`
- `start_probability`, `substitute_probability`, `no_show_probability`
- `minutes_confidence`
- `strength_method`
- `role_source_json`
- `input_provenance_json`

## CalibrationSet and CalibrationMetric

`CalibrationSet`: `id`, `model_version`, `trained_at`, `training_cutoff`, `observation_count`, `status`, `config_json`.

`CalibrationMetric`: composite key `(calibration_set_id, position, horizon, confidence_band, strength_method)` with sample size, MAE, RMSE, bias, interval coverage, rank correlation and applied factor.

## ManagerAccount

Single local manager is allowed initially, but retain an ID.

Fields: `id`, `fpl_entry_id UNIQUE`, team and manager names, total/gameweek points, overall rank, current gameweek, last_imported_at, created_at, updated_at.

Do not store provider API keys here.

## OfficialSquadSnapshot

Immutable imported official state.

Fields: `id TEXT PK`, `manager_account_id FK`, `gameweek_id`, `imported_at`, `bank_tenths`, `squad_value_tenths`, `active_chip`, `event_transfers`, `event_transfer_cost`, `captain_player_id`, `vice_captain_player_id`, `raw_payload_json`.

## OfficialSquadPlayer

Primary key: `(squad_snapshot_id, player_id)`.

Fields: official position/order, multiplier, captain flags, `purchase_price_tenths nullable`, `selling_price_tenths nullable`, and `economics_source` (`OFFICIAL`, `USER_CONFIRMED`, `UNKNOWN`).

## ManagerAssumption

Append-only manager inputs. Fields: `id`, `manager_account_id`, `gameweek_id`, `kind`, `value_json`, `source` (`USER_CONFIRMED`, `IMPORTED`), `created_at`, `supersedes_id nullable`.

Initially required kind: `FREE_TRANSFERS`.

## Plan

Immutable plan revision.

| Column | Type | Rule |
|---|---|---|
| id | TEXT PK | UUID |
| manager_account_id | TEXT FK | Required |
| official_squad_snapshot_id | TEXT FK | Baseline official state |
| parent_plan_id | TEXT FK nullable | Revision ancestry |
| name | TEXT | User-visible scenario name |
| status | TEXT | `ACTIVE`, `SAVED`, `ARCHIVED` |
| bank_tenths | INTEGER nullable | Null if affordability unknown |
| free_transfers | INTEGER | User-confirmed assumption |
| created_at | TEXT | Required |
| change_summary_json | TEXT | Moves from parent |

## PlanPlayer

Primary key: `(plan_id, player_id)`. Fields: squad slot, planned purchase price, inherited selling price where owned from official baseline, captain, vice-captain, bench order and lock state.

## RecommendationSet

Fields: `id`, `plan_id`, `forecast_run_id`, `horizon`, `max_transfers`, `chip`, `uncertainty_penalty_rate`, `created_at`, `status`, `primary_candidate_id nullable`, `input_hash`.

## RecommendationCandidate

Fields: `id`, `recommendation_set_id`, rank, action (`ROLL`, `TRANSFER`, `CHIP`, `INSUFFICIENT_DATA`), moves JSON, raw gain, hit cost, uncertainty penalty, net expected gain, probability beats roll, bank after, affordability status, expected team points and outcome quantiles.

## DecisionRecord

Fields: `id`, `recommendation_set_id`, `candidate_id nullable`, decision (`ACCEPTED`, `REJECTED`, `IGNORED`, `CUSTOM`), selected_plan_id nullable, reason nullable, created_at, evaluated_at nullable, realized_points_delta nullable, outcome_json nullable.

## AppSetting

Non-secret settings only: `key TEXT PK`, `value_json`, `updated_at`.

Provider credentials belong in environment variables or the protected local settings file described in the blueprint.

## Retention

- Keep forecast runs, official squad snapshots, plans and decisions indefinitely during development.
- Keep successful official observations needed by any forecast indefinitely.
- A maintenance job may remove failed feed payloads after 30 days.
- A feed observation referenced by a forecast run must never be deleted.
- Raw market/underlying payload retention defaults to one season and must be configurable.
