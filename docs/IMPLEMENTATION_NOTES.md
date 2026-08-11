# Implementation Notes

## WP-16 — End-to-end verification and documentation

### Status

Complete.

### Implementation summary

- Added a deterministic fixture smoke workflow covering saved official ingestion, manager import, user-confirmed free transfers, immutable active-plan/scenario state, catalogue freshness and provenance, forecast-baseline selection, and explicit uncalibrated backtest output.
- Added the `test:e2e` command and a focused integration command to the documented verification workflow.
- Rewrote stale README setup, catalogue-cache, architecture and calibration descriptions to match the immutable catalogue/forecast services and their operational limits.
- Removed the obsolete no-op live-data cache invalidator; catalogue invalidation is version-keyed through the catalogue cache service.
- Updated the migration test expectation for the completed secret-removal migration and removed an obsolete affordability wording match.

### Files changed

- `scripts/e2e-fixture.test.ts`
- `package.json`
- `README.md`
- `scripts/serve.mjs`
- `scripts/db-migrate.test.ts`
- `src/integrations.ts`
- `docs/IMPLEMENTATION_NOTES.md`

### Commands run and results

- `npm test` — passed: 20 test files, 118 tests.
- `npm run test:integration` — passed: 5 test files, 20 tests.
- `npm run test:e2e` — passed: 1 fixture smoke test.
- `npm run build` — passed.
- Temporary-database `npm run db:migrate` — passed; applied migrations `001`, `002` and `003`.
- Temporary-database `npm run db:verify` — passed.
- Temporary-database `npm run backtest` — passed with zero eligible observations and explicit `Uncalibrated` status.
- Temporary repository-local `npm run db:reset -- --yes-reset-development-data` — passed.
- Final prohibited-behaviour search and `git diff --check` — passed with no matches/errors.

### Deviations or unresolved issues

- Browser-level fixture testing is represented by the deterministic end-to-end fixture smoke command because the development server's public manager-import route intentionally fetches the official upstream API and exposes no fixture-import HTTP mode. The smoke workflow exercises the same canonical services without network access, as required by the acceptance suite.
- The worktree intentionally contains the combined WP-05–WP-16 deliverables and the four authoritative specifications; no unrelated user changes were removed.

## WP-13 — Decision journal

### Status

Complete.

### Implementation summary

- Added a decision-journal service that records accepted, rejected, ignored and custom actions against immutable recommendation, baseline-plan and optional selected-plan records.
- Added outcome evaluation from the saved forecast run and saved plans only. Results remain explicitly pending until every relevant player-fixture result exists.
- Stored separate baseline/chosen expected and realized values, model forecast error, and recorded manager decision result. The response wording explicitly describes this as a non-causal counterfactual comparison.
- Added decision-history API endpoints: `POST /api/decisions`, `GET /api/decisions`, and `POST /api/decisions/:id/evaluate`.

### Files changed

- `scripts/decision-journal-service.mjs`
- `scripts/decision-journal-service.test.ts`
- `scripts/serve.mjs`
- `docs/IMPLEMENTATION_NOTES.md`

### Commands run and results

- `npm run test:vitest -- scripts/decision-journal-service.test.ts` — passed (2 tests).
- `npm run build` — passed.
- `git diff --check` — passed.

### Deviations or unresolved issues

- `DecisionRecord.recommendation_set_id` is the persisted baseline-plan/forecast context; `selected_plan_id` records the chosen immutable plan. No new compatibility or mutable-state layer was introduced.
- The existing application does not yet create persisted recommendation sets from its legacy client-side recommendation view, so the journal API is the minimal UI-facing integration point for this package. It does not fabricate journal entries from legacy UI heuristics.
- WP-14 was not started.

## WP-00 — Baseline and repository cleanup

### Status

Complete.

### Implementation summary

- Captured the required pre-change test, build and database-verifier results.
- Removed the obsolete hard-coded `rules-aware-v1.0` verifier filter by sourcing the active model version from `MODEL_VERSION`.
- Ensured terminating database scripts close their connections in `finally`, including the zero-observation backtest path.
- Added Vitest test and hook timeouts for CI execution.

### Files changed

- `package.json`
- `scripts/backtest-projections.mjs`
- `scripts/db-push.mjs`
- `scripts/ingest-signals.mjs`
- `scripts/verify-db.mjs`
- `docs/IMPLEMENTATION_NOTES.md`

### Commands run and results

Baseline before WP-00 changes:

- `npm test` — reached Vitest but was manually interrupted with exit code 130 during the initial baseline capture; the existing Vitest suite was then run directly and completed with 56 passing tests.
- `npm run build` — passed.
- `npm run verify:db` — passed; reported the legacy verifier counts (`players=573`, `teams=20`, `fixtures=380`, `snapshots=573`, `projections=0`, `match_history=0`, `calibrations=0`, `current_gw=1`).

WP-00 verification:

- `npm test` — passed; domain and intelligence verification passed, and Vitest reported 2 test files and 56 passing tests.
- `npm run build` — passed; production bundle written to `dist/`.
- `npm run db:push` — passed; existing database schema was verified and the process exited cleanly.
- `npm run verify:db` — passed; reported `model_version: role-aware-v2.0`, `projections=2865`, and the expected current counts.
- `npm run backtest` — passed with zero observations; reported five zero-observation summaries and exited with code 0.
- `rg 'rules-aware-v1\\.0' src scripts README.md` — passed; no obsolete references found.
- `git diff --check` — passed.
- Final diff/status review — completed; unrelated pre-existing changes remain unstaged and outside WP-00.

### Deviations or unresolved issues

- No WP-00 deviations are known.
- The pre-existing repository changes and the four authoritative specification documents were preserved and are outside this package's implementation files.
- No later work package was started.

## WP-01 — Canonical SQL migrations

### Status

Complete.

### Implementation summary

- Added `db/migrations/001_initial_rebuild.sql` containing the canonical data-dictionary schema, constraints, indexes and explicit foreign-key delete behavior.
- Added checksum-aware `db:migrate` and guarded `db:reset` commands.
- Enabled SQLite foreign keys, WAL mode, a 5-second busy timeout and normal synchronous mode in the database adapter.
- Removed the Prisma schemas, Prisma package/scripts and legacy raw-schema setup script.
- Updated runtime startup, signal ingestion, verifier, Docker, Compose, environment and README references to the migration workflow.
- Added migration tests for idempotence, checksum protection and foreign-key enforcement.

### Files changed

- `db/migrations/001_initial_rebuild.sql`
- `scripts/db.mjs`
- `scripts/db-migrate.mjs`
- `scripts/db-reset.mjs`
- `scripts/db-migrate.test.ts`
- `scripts/backtest-projections.mjs`
- `scripts/ingest-signals.mjs`
- `scripts/serve.mjs`
- `scripts/verify-db.mjs`
- `package.json`
- `package-lock.json`
- `.env.example`
- `Dockerfile`
- `compose.example.yaml`
- `README.md`
- Deleted `scripts/db-push.mjs` and `prisma/` schemas.

### Commands run and results

- `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` — passed; Prisma dependency removed from the lockfile.
- Temporary `npm run db:migrate` on an empty database — passed; applied `001_initial_rebuild` and created 29 canonical tables.
- Temporary second `npm run db:migrate` — passed; reported database already up to date.
- Temporary checksum mutation followed by `npm run db:migrate` — failed as expected with the migration version and checksum mismatch, then the migration file was restored and revalidated.
- Temporary SQLite pragma check — passed: foreign keys `1`, journal mode `wal`, synchronous `NORMAL`, busy timeout `5000` through the application adapter.
- Temporary orphan child insert — rejected by foreign keys as expected.
- `db:reset` without `--yes-reset-development-data` — rejected as expected.
- `db:reset` against `/`, the home directory, the repository root and an unresolved variable — rejected as expected.
- Temporary confirmed `db:reset` followed by `db:migrate` — passed.
- Temporary `npm run db:verify` — passed with an empty canonical database.
- Temporary `npm run backtest` — passed with zero observations and exit code 0.
- `npm test` — passed; 3 test files and 59 tests.
- `npm run build` — passed.
- `git diff --check` — passed.

### Deviations or unresolved issues

- Backtest calibration persistence remains deferred to WP-12; WP-01 only keeps the empty canonical backtest command operational.
- The existing development database was not reset; all migration/reset checks used temporary databases to preserve local data.
- WP-02 and all later work packages were not started.

## WP-02 — Feed-run framework and official ingestion

### Status

Complete.

### Implementation summary

- Added a feed-run lifecycle helper covering `RUNNING`, `SUCCEEDED`, `PARTIAL` and `FAILED` states, canonical SHA-256 payload hashing, sanitized error summaries, cache metadata and source freshness lookup.
- Rewrote official FPL ingestion against the canonical schema with deterministic season-scoped internal identities and immutable team, gameweek, fixture and player observations tied to each feed run.
- Persisted official player news, news timestamps, integer-tenth prices, availability, market, season-total, expected-statistic and defensive-contribution fields, plus completed player-fixture results.
- Added explicit season resolution from `FPL_SEASON`, `FPL_SEASON_START_YEAR` or bootstrap context; no season is hard-coded in ingestion logic.
- Ensured fact writes run in one transaction, while failed feed runs remain retained outside that transaction. Network refreshes begin the feed run before source requests and support eligible cache fallback as `PARTIAL` without refreshing the cache observation timestamp.
- Kept projection tables untouched; official ingestion does not create forecasts or projections.
- Added saved bootstrap, fixture and element-summary JSON fixtures and deterministic Vitest coverage for complete ingestion, atomic failure, repeated ingestion, season identity isolation and cache fallback.

### Files changed

- `.env.example`
- `README.md`
- `scripts/feed-run.mjs`
- `scripts/ingest-fpl.mjs`
- `scripts/ingest-fpl.test.ts`
- `scripts/fixtures/wp02-bootstrap.json`
- `scripts/fixtures/wp02-fixtures.json`
- `scripts/fixtures/wp02-element-summary-10.json`
- `scripts/fixtures/wp02-element-summary-11.json`
- `docs/IMPLEMENTATION_NOTES.md`

### Commands run and results

- `npm run test:vitest -- scripts/ingest-fpl.test.ts` — passed; 4 tests.
- `npm test` — passed; 4 test files and 63 tests.
- `npm run build` — passed; production bundle written to `dist/`.
- `node --check scripts/ingest-fpl.mjs && node --check scripts/feed-run.mjs` — passed.
- `git diff --check` — passed.
- Temporary `DATABASE_URL=... npm run db:migrate` — passed; applied the canonical migration.
- Temporary `DATABASE_URL=... npm run db:verify` — passed on an empty canonical database.
- Temporary `DATABASE_URL=... npm run backtest` — passed with zero observations.
- `npm run db:verify` against the existing development database — failed because that preserved database has no canonical `PlayerObservation` table.
- `npm run backtest` against the existing development database — failed because that preserved database has no canonical `PlayerFixtureForecast` table.

### Deviations or unresolved issues

- The existing `dev.db` was deliberately not reset or overwritten because it predates the canonical migration. Canonical verification used temporary databases; running `npm run db:migrate` or the guarded development reset is still required before using the preserved local database with canonical commands.
- No later work package was started while implementing WP-02.

## WP-03 — Manager import and exact economics

### Status

Complete.

### Implementation summary

- Added transactional manager import services for `ManagerAccount`, immutable `OfficialSquadSnapshot`, `OfficialSquadPlayer` economics and append-only `ManagerAssumption` records.
- Imported official purchase/selling prices and bank/squad value as integer tenths without substituting current catalogue prices.
- Added user-confirmed free-transfer and missing-selling-price updates with supersession and provenance.
- Added pure simultaneous-transfer affordability and legality functions using final-squad positions, duplicate checks, club limits, exact bank and hit costs.
- Replaced the legacy `/api/fpl-account` and `/api/fpl-squad` routes with `POST /api/manager/import`, `GET /api/manager/current` and `PATCH /api/manager/assumptions`; updated the client account import to use the new route.
- Added saved manager payload fixtures and tests for official economics, unknown affordability, confirmation overrides, immutable re-imports, exact multi-transfer funding and simultaneous club-limit checks.

### Files changed

- `scripts/manager-service.mjs`
- `scripts/manager-service.test.ts`
- `scripts/fixtures/wp03-entry.json`
- `scripts/fixtures/wp03-picks.json`
- `scripts/serve.mjs`
- `src/core/transfers.ts`
- `src/core/transfers.test.ts`
- `src/integrations.ts`
- `docs/IMPLEMENTATION_NOTES.md`

### Commands run and results

- `npm run test:vitest -- src/core/transfers.test.ts scripts/manager-service.test.ts` — passed; 2 files and 7 tests.
- `npm test` — passed; 6 test files and 70 tests.
- `npm run build` — passed; production bundle written to `dist/`.
- `node --check scripts/manager-service.mjs && node --check scripts/serve.mjs` — passed.
- `git diff --check` — passed.
- `rg '/api/fpl-account|/api/fpl-squad' scripts/serve.mjs src/integrations.ts` — passed; no legacy account/squad route references remain.

### Deviations or unresolved issues

- Legacy `/api/user-profile` and local selected-player persistence remain outside WP-03 and are scheduled for the plan/hydration work in WP-04; official manager state is now represented by the canonical manager endpoints and snapshots.
- The preserved legacy `dev.db` remains untouched as documented under WP-02.
- No later work package was started while implementing WP-03.

## WP-04 — Plans and hydration

### Status

Complete.

### Implementation summary

- Added immutable plan services for creating active or named saved revisions, copying an official squad snapshot into `PlanPlayer` rows, creating child revisions, selecting an earlier revision for undo, and retaining parent ancestry.
- Manager import now creates the initial active plan from the imported official snapshot when no active plan exists.
- Added plan API routes for creation, active-plan retrieval and revision selection; `GET /api/manager/current` now includes the active plan.
- Moved client account/profile hydration to the manager/current and plan APIs. Catalogue loading waits until profile hydration completes, preventing a fast profile response or slow catalogue response from replacing a saved plan with a generated default.
- Made generated catalogue exploration explicit with a visible demo-squad label. Numeric selected-player IDs remain a transient UI projection of the active plan rather than a second persistence source.
- Added tests covering official-state isolation, parent/child revisions, undo selection, named saved scenarios and reloadable active plans.

### Files changed

- `scripts/plan-service.mjs`
- `scripts/plan-service.test.ts`
- `scripts/manager-service.mjs`
- `scripts/serve.mjs`
- `src/integrations.ts`
- `src/main.tsx`
- `docs/IMPLEMENTATION_NOTES.md`

### Commands run and results

- `npm run test:vitest -- scripts/plan-service.test.ts scripts/manager-service.test.ts` — passed; 2 files and 6 tests.
- `npm test` — passed; 7 test files and 73 tests.
- `npm run build` — passed; production bundle written to `dist/`.
- `node --check scripts/plan-service.mjs && node --check scripts/manager-service.mjs && node --check scripts/serve.mjs` — passed.
- `git diff --check` — passed.

### Deviations or unresolved issues

- Existing non-plan preference endpoints remain for unrelated UI settings; selected squad persistence no longer uses them and is routed through immutable plans. Full preference cleanup is outside the WP-04 acceptance surface.
- The preserved legacy `dev.db` remains untouched as documented under WP-02.
- No later work package was started while implementing WP-04.

## WP-05 — Unified catalog service

### Status

Complete.

### Implementation summary

- Added typed projection-input and provenance boundaries with internal IDs and explicit official `fplId` values.
- Added `src/server/catalog-service.ts`, which assembles immutable official player, team-strength and fixture inputs at an explicit `asOf` timestamp, with canonical SHA-256 hashing and per-source freshness.
- Eligible underlying records must be confirmed matches for the active season and inside the configured age window; unmatched, ambiguous and post-`asOf` records are excluded.
- Eligible signals must be verified, current at `asOf` and applicable to the active season. Manual role overrides supersede same-kind non-manual signals and remain visible in provenance.
- Added `GET /api/catalog`; the primary UI catalogue loader and Model Debug now consume this shared catalogue service.
- Added deterministic catalogue tests for as-of filtering, input hashing, underlying eligibility, signal eligibility and manual-override provenance.

### Files changed

- `src/core/types.ts`
- `src/server/catalog-service.ts`
- `src/server/catalog-service.test.ts`
- `scripts/serve.mjs`
- `src/integrations.ts`
- `src/main.tsx`
- `docs/IMPLEMENTATION_NOTES.md`

### Commands run and results

- `npm run test:vitest -- src/server/catalog-service.test.ts` — passed; 2 tests.
- `npm test` — initially passed; 8 test files and 75 tests. A final rerun after an unrelated untracked `002_app_state_and_manager_totals.sql` appeared failed only in `scripts/db-migrate.test.ts`, whose hard-coded expected migration list contains only `001_initial_rebuild`; 77 other tests passed.
- `npm run build` — passed; production bundle written to `dist/`.
- Temporary canonical-database `npm run db:migrate`, `npm run db:verify` and `npm run backtest` — passed; migration applied, verifier reported the empty canonical schema, and backtest exited cleanly with zero observations.
- `git diff --check` — passed.
- Final diff/status review — completed; unrelated pre-existing modifications remain preserved.

### Deviations or unresolved issues

- The final full-suite rerun has one unrelated migration-test failure caused by the newly present, untracked `db/migrations/002_app_state_and_manager_totals.sql`. It is outside WP-05 and was preserved without modification.
- The legacy development database remains untouched; the new service is exercised against fresh temporary canonical databases.
- WP-06 and all later work packages have not been started.

## WP-11 — Real chip counterfactuals

### Status

Complete.

### Implementation summary

- Added the shared `src/core/chips.ts` counterfactual evaluator for TC, BB, FH and WC.
- TC returns exactly one additional selected-captain score distribution; BB returns only the legal baseline bench contribution.
- FH evaluates a legal temporary squad only for the selected gameweek; WC evaluates a legal replacement squad over the full requested horizon with no transfer hits.
- FH/WC estimates are explicitly unavailable when exact economics, required forecasts or a successful legal optimisation are absent. No fixed or bench-derived gains remain.
- Recommendation generation now stores chip candidates using the existing recommendation tables, including chip metadata in the immutable candidate payload.
- The legacy UI hides unsupported WC/FH values rather than showing a fabricated number.

### Files changed

- `src/core/chips.ts`
- `src/core/chips.test.ts`
- `src/core/lineup.ts`
- `src/core/optimizer.ts`
- `scripts/recommendation-service.mjs`
- `src/domain.ts`
- `src/main.tsx`
- `docs/IMPLEMENTATION_NOTES.md`

### Commands run and results

- `npm run test:vitest -- src/core/chips.test.ts src/core/optimizer.test.ts` — passed; 2 files and 6 tests.
- `npm run build` — passed; domain verification and production bundle succeeded.
- `git diff --check` — passed.

### Deviations or unresolved issues

- FH/WC use a deterministic beam search with exact budget, lock, position and club-limit checks over a realistic catalogue. Small candidate pools retain an exhaustive correctness guard in the transfer optimiser tests.
- The broader worktree contains concurrent package changes and was preserved. No later package was started by this WP-11 implementation.

## Release review — offline projection and request-time optimisation

- Forecast generation is performed during ingestion or the explicit `npm run forecast` background command and stored as immutable player/fixture rows.
- Request-time recommendation generation reads only a selected successful forecast run and performs bounded, manager-specific optimisation; it does not recompute player projections.
- Identical requests reuse their persisted `RecommendationSet` before forecast rows are loaded. The cache identity is plan, forecast run, horizon, transfer limit, chip, uncertainty penalty and forecast input hash.
- Recommendation responses use stable camel-case API fields and translate canonical internal player IDs to public FPL IDs for the UI.
- Horizon uncertainty now combines fixture variances and derives the aggregate p10/p50/p90 range instead of adding percentile values directly.
- Migration `004_recommendation_cache_index.sql` indexes the request identity, and tests assert a cache hit never queries `PlayerFixtureForecast`.

## Release review — API and secret handling

- All JSON API failures now pass through one response boundary and use `{ schemaVersion: 1, error: { code, message, requestId } }`; error text is sanitized and the request ID is also returned in the response header.
- UI integrations accept the canonical envelope while retaining compatibility with asynchronous research-job failures returned inside successful polling responses.
- AI configuration metadata returns provider, configured state and only the last four key characters. The full key remains in the mode-`0600` application-data file and is not duplicated into SQLite.
- Process-level HTTP tests cover wrong content type (`415`), oversized bodies (`413`), request-ID correlation, key suffix metadata, file permissions and absence of the test key from SQLite.
