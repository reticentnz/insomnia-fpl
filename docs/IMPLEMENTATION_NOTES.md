# Implementation Notes

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
