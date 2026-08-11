# Insomnia FPL Rebuild: Acceptance Tests

This is the release gate. Implementation is incomplete until every applicable test passes. Tests must use temporary databases and saved source fixtures; normal test runs must not require network access.

## 1. Standard verification commands

The completed repository must provide:

```bash
npm test
npm run test:integration
npm run test:e2e
npm run build
npm run db:reset -- --yes-reset-development-data
npm run db:migrate
npm run db:verify
npm run backtest
```

CI order:

```text
typecheck -> unit -> integration -> build -> e2e fixture mode
```

No command may depend on execution order or a developer's existing `dev.db`.

## 2. Database and migration scenarios

### DB-01 Fresh migration

Given no database, `db:migrate` creates every table, index, check and foreign key. A second run performs no work and exits zero.

### DB-02 Checksum protection

After applying a migration, changing its contents causes migration startup to fail with the migration version and checksum mismatch.

### DB-03 Foreign-key enforcement

Inserting a forecast for a nonexistent run, or a squad player for a nonexistent snapshot, fails.

### DB-04 Safe reset

Reset without the explicit confirmation flag fails. Reset against `/`, the home directory, repository root, or an unresolved environment variable fails.

## 3. Official ingestion scenarios

### ING-01 Complete fixture ingestion

Using saved bootstrap, fixture and element-summary JSON:

- feed run succeeds;
- counts match fixture expectations;
- news text and timestamp persist;
- player prices use integer tenths;
- completed results upsert once;
- source freshness equals feed observation time.
- the same official numeric player or fixture ID in a second season maps to a different internal identity.

### ING-02 Atomic failure

Inject failure after team writes but before player observations. No partial facts remain, while the feed run is `FAILED` with a sanitized error.

### ING-03 Repeated ingestion

Ingest identical payload twice. Stable identities remain unique; two immutable observations/feed runs exist as expected.

### ING-04 Source cache fallback

When a source refresh fails and an eligible cache exists, the feed run is `PARTIAL`, `used_cache=1`, and exposes the original cache capture time. It is not marked freshly sourced.

## 4. Manager economics scenarios

### ECO-01 Selling price

Official pick:

```json
{"element": 10, "purchase_price": 50, "selling_price": 52}
```

Current catalogue price is 54. Selling the player adds 52 tenths to bank, not 54.

### ECO-02 Missing economics

When an owned player's selling price is absent, a transfer involving that player returns `AFFORDABILITY_UNKNOWN`. After a user-confirmed override, the same request produces an exact result with provenance.

### ECO-03 Multi-transfer bank

Given bank 0.5, outgoing selling prices 5.0 and 6.0, and incoming prices 4.5 and 6.8, bank after is 0.2 and the route is affordable.

### ECO-04 Simultaneous club limits

Selling one of three Arsenal players while buying another Arsenal player remains legal. Buying the fourth without selling one is illegal.

## 5. Plan-state scenarios

### PLN-01 Official isolation

Import official squad A. Apply a local transfer to plan B. Reload. Official squad remains A and active plan remains B.

### PLN-02 Revision undo

Apply two plan revisions and undo once. The active plan points to the exact first child revision and all history remains queryable.

### PLN-03 Hydration race

Artificially delay catalogue response beyond profile response, then reverse the delays. Both runs produce the same saved active plan; neither silently creates a default squad.

## 6. Catalog and provenance scenarios

### CAT-01 As-of exclusion

An observation at 12:01 is excluded from a catalogue assembled `asOf=12:00`. This applies to player, team-strength, gameweek-deadline and fixture-schedule observations.

### CAT-02 Signal eligibility

Pending, rejected, expired and wrong-gameweek signals do not alter role probabilities. Current verified signals do. Manual override wins.

### CAT-03 Input hashing

Semantically identical canonical inputs produce identical hashes regardless of database row order. One changed fact changes the hash.

### CAT-04 Optional source fallback

Missing underlying or market inputs do not crash assembly. Provenance identifies the fallback and reduced confidence.

## 7. Scoring and projection scenarios

Retain tests for official appearance, goal, assist, clean-sheet, goals-conceded, save, penalty, card, own-goal, defensive-contribution and BPS tie rules.

### PRJ-01 One calculation path

For a fixed input fixture, the live endpoint, forecast creation service and Model Debug return identical component and total means.

### PRJ-02 Role states

Start 0.7, substitute appearance conditional on not starting 0.2 means:

```text
P(start) = 0.70
P(substitute) = 0.30 * 0.20 = 0.06
P(no show) = 0.24
```

### PRJ-03 Blank and double

No fixture yields zero. Two fixtures in one gameweek equal the sum of the two fixture expected values, with uncertainty aggregated by the documented simulation.

### PRJ-04 Strength fallback

Complete market goal inputs select `MARKET_XG`. Without them, official team strengths select `OFFICIAL_STRENGTH`. Without either, select `FDR_FALLBACK`.

### PRJ-05 Seed repeatability

Two runs with the same seed and inputs produce identical mean, standard deviation and quantiles. Quantiles remain ordered.

## 8. Forecast-ledger scenarios

### FRC-01 Immutability

Creating a second forecast for the same model/gameweek produces a new run. Attempts to update a succeeded run through application services fail.

### FRC-02 Deadline eligibility

Deadline 18:30. Runs at 17:00 and 18:20 are eligible; run at 18:31 is not. Baseline selection returns the 18:20 successful run.

### FRC-03 Failed run

Injected projection failure marks the run failed, stores no partial successful child set, and does not alter the selected prior baseline.

### FRC-04 Reproduction

Reassembling referenced inputs reproduces the stored input hash and expected outputs. A mismatch is a verification failure.

## 9. Transfer recommendation scenarios

### REC-01 Roll included

Every recommendation set contains a roll candidate.

### REC-02 Hit calculation

For three moves and free transfers 0, 1, 2, 3, expected hit costs are 12, 8, 4, 0.

### REC-03 Uncertainty decision rule

A move with positive mean but 55% probability of beating roll is not the primary recommendation. At 60% or above it may be, provided affordability is exact.

### REC-04 Reproducible order

Same plan, forecast and settings yield identical candidate order and values.

### REC-05 Search completeness guard

For a small synthetic player pool, compare bounded optimiser output to exhaustive enumeration. The best plan must match. Keep this test small enough for CI.

### REC-06 Five-move legality

Every intermediate representation and final returned squad has unique players, correct positional counts, club limits and non-negative bank.

## 10. Chip scenarios

### CHP-01 Triple Captain

Projected gain distribution equals one additional copy of the selected captain's score distribution relative to normal captaincy.

### CHP-02 Bench Boost

Gain equals the counterfactual inclusion of bench scores for the target gameweek after optimal legal lineup/bench selection.

### CHP-03 Free Hit reversion

The optimised temporary squad applies only to the target gameweek. Following weeks use the unchanged baseline plan.

### CHP-04 Wildcard persistence

The optimised squad remains active throughout later horizon gameweeks and has no hit cost.

### CHP-05 No heuristic fallback

If optimisation fails or required forecasts are absent, API returns unavailable with a reason. No numeric gain is returned.

## 11. Backtest scenarios

### BKT-01 No leakage

Only the selected pre-deadline baseline joins to actual results. Later forecast runs are excluded.

### BKT-02 Empty dataset

Backtest returns an explicit zero-observation result and exits cleanly.

### BKT-03 Calibration threshold

99 eligible observations do not activate calibration. 100 may activate it, with factor capped to `[0.85,1.15]`.

### BKT-04 Version isolation

Metrics and calibration for model A never include forecasts from model B.

### BKT-05 Interval coverage

Coverage reports the fraction of actual results within stored p10–p90 ranges and has a value between zero and one.

## 12. Cache and freshness scenarios

### CCH-01 Memory cache

Repeated identical catalogue requests inside TTL assemble once.

### CCH-02 Restart cache

After restart and simulated database assembly failure, an eligible restart cache is served as `STALE`. An over-age cache is rejected.

### CCH-03 Timestamp truth

Serving cached data does not replace official source timestamp with response time.

### CCH-04 Invalidation

New official feed run, verified signal set or model/calibration version changes the cache key.

### CCH-05 League concurrency

Instrumented upstream requests prove at most five are active simultaneously.

## 13. Secret and API scenarios

### SEC-01 Key metadata

Configured-key endpoint returns provider, configured boolean and suffix only.

### SEC-02 No duplication

Search SQLite text and normal logs for a test key; neither contains it.

### SEC-03 Body limit

Oversized body returns 413 and does not continue parsing or writing.

### SEC-04 Error envelope

All API errors use `{ schemaVersion: 1, error: { code, message, requestId } }` without stack traces or secrets.

## 14. Decision journal scenarios

### DEC-01 Immutable context

Accepted recommendation keeps its original plan, forecast run, candidates and settings after newer forecasts exist.

### DEC-02 Outcome evaluation

Realized comparison uses the stored chosen and baseline plans for the relevant fixtures.

### DEC-03 Honest language

UI and exported reports use `realized difference versus recorded baseline`, not `points gained because of the tool`.

## 15. Browser smoke path

In fixture mode:

1. Start with an empty migrated database.
2. Run saved official ingestion.
3. Import fixture manager ID.
4. Confirm free transfers.
5. Verify official squad economics.
6. Create active plan.
7. Generate recommendations.
8. Inspect uncertainty and provenance.
9. Apply a recommendation and undo it.
10. Run a signal challenge fixture and approve one finding.
11. Confirm a new forecast/recommendation reflects the role change.
12. Save a scenario and reload.
13. Generate a chip comparison.
14. Open backtest view and see explicit insufficient-sample state.

The smoke path must contain no uncaught browser errors, failed same-origin API requests, silent demo fallback, or mislabeled freshness.

## 16. Final repository audit

The final implementation must return no matches for obsolete or prohibited behavior except in migration/history documentation:

```bash
rg "rules-aware-v1\.0|function invalidateLiveDataCache\(\) \{\}|const wcGain =|const fhGain =|pricingBasis:.*verify official selling prices" src scripts README.md
```

Additional manual checks:

- README matches actual cache behavior and commands.
- Every endpoint is represented in API tests.
- Every schema table is used or explicitly justified.
- No secret exists in committed files or test snapshots.
- `git status --short` contains only intended deliverables.
