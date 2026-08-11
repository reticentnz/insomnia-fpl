# Insomnia FPL Rebuild: Ordered Work Packages

Implement these packages in order. Complete the package tests and commit before beginning the next package. Do not combine packages unless a reviewer explicitly approves it.

For every package:

1. Read the authoritative blueprint and relevant data-dictionary entries.
2. Inspect existing code before editing.
3. Preserve unrelated user changes.
4. Implement only the stated scope.
5. Add or update tests.
6. Run the package verification commands.
7. Record deviations in `docs/IMPLEMENTATION_NOTES.md` under the package ID.

## WP-00: Baseline and repository cleanup

Goal: establish a clean, observable starting point.

Tasks:

- Record current `npm test`, `npm run build`, and database-verifier results.
- Add `docs/IMPLEMENTATION_NOTES.md` with package/status/deviation headings.
- Remove obsolete `rules-aware-v1.0` references.
- Make every executable database script close its connection in `finally`.
- Add timeouts to commands used by CI where appropriate.
- Delete no functional code yet.

Acceptance:

- Build succeeds.
- All existing tests pass.
- `npm run backtest` terminates with exit code 0 even with zero observations.
- Database verifier reports the imported `MODEL_VERSION` rather than a literal version.

## WP-01: Canonical SQL migrations

Goal: replace the dual Prisma/raw-schema system with one migration system.

Tasks:

- Implement `db/migrations/001_initial_rebuild.sql` from `DATA_DICTIONARY.md`.
- Implement checksum-aware `scripts/db-migrate.mjs`.
- Implement guarded `scripts/db-reset.mjs`.
- Enable foreign keys, WAL, busy timeout and normal synchronous mode.
- Remove `prisma/`, Prisma scripts and Prisma dependency after all schema references move.
- Update `.env.example`, Dockerfile and compose example.

Acceptance:

- Reset plus migrate creates an empty valid database.
- Running migrate twice makes no changes.
- A changed checksum for an applied migration causes a hard failure.
- Inserting an orphan child row fails.
- Reset refuses without the explicit flag and refuses unsafe paths.

## WP-02: Feed-run framework and official ingestion

Goal: ingest auditable official facts without generating divergent projections.

Tasks:

- Add feed-run helper with success/failure/partial completion.
- Rewrite official ingestion against the new season-scoped identity and immutable observation schema.
- Persist player news and all dictionary fields.
- Derive season from configuration; remove hard-coded season values.
- Persist source timestamps and raw payload hashes.
- Preserve transactional fact writes.
- Do not create projections inside this package.

Acceptance:

- Fixture/bootstrap fixture tests ingest deterministic saved payloads.
- A failure halfway through fact writes rolls back facts and marks the feed run failed.
- Team, gameweek, fixture and player observations are immutable and tied to a feed run.
- Identical numeric FPL IDs in two seasons resolve to different internal IDs.
- Re-ingesting the same fixture does not duplicate identities.
- Freshness reports the feed-run time, not request time.

## WP-03: Manager import and exact economics

Goal: reproduce official squad economics.

Tasks:

- Implement `ManagerAccount`, `OfficialSquadSnapshot`, `OfficialSquadPlayer`, and `ManagerAssumption` services.
- Replace `/api/fpl-account` and `/api/fpl-squad` with `/api/manager/import` and `/api/manager/current`.
- Import purchase and selling prices from picks.
- Store bank in integer tenths.
- Add user-confirmed free transfers and missing-price overrides.
- Add pure affordability and simultaneous-transfer legality functions.

Acceptance:

- A player bought at 5.0, now priced 5.4, with official selling price 5.2 contributes 5.2 to affordability.
- Missing selling price returns `AFFORDABILITY_UNKNOWN`.
- Two-transfer funding routes use the final simultaneous squad and exact bank.
- Current market price is never substituted for an owned player's selling price.

## WP-04: Plans and hydration

Goal: separate official state from local scenarios.

Tasks:

- Implement immutable `Plan` and `PlanPlayer` revisions.
- Convert an imported squad snapshot into the initial active plan.
- Apply/undo by creating or selecting revisions.
- Support named saved scenarios.
- Remove unused legacy `Squad`, `SquadPlayer`, `selectedIds` duplication and global mutable plan state.
- Gate initial UI selection until catalogue and profile/manager state have both loaded.

Acceptance:

- Editing a plan never changes the official snapshot.
- Undo restores the exact parent revision.
- Reload retains the active plan.
- Slow catalogue and fast profile loading cannot replace a saved squad with a generated default.
- Demo exploration is explicit and visually labelled.

## WP-05: Unified catalog service

Goal: assemble the exact inputs used everywhere.

Tasks:

- Create typed `ProjectionInputCatalog` and provenance types using internal IDs plus explicit official `fplId` values at API boundaries.
- Implement `catalog-service.ts` with explicit `asOf`.
- Select the latest eligible official, underlying, market and signal inputs.
- Add ambiguity and staleness exclusion rules.
- Return per-source freshness.
- Make UI catalogue loading and Model Debug use this service.

Acceptance:

- Same `asOf` and source run IDs produce the same canonical input hash.
- A post-`asOf` observation is excluded.
- An unmatched underlying record is excluded.
- An expired or pending signal is excluded from numeric role inputs.
- A manual override takes precedence and is visible in provenance.

## WP-06: Projection core consolidation

Goal: ensure all forecast consumers use one model.

Tasks:

- Split current scoring and projection code into the target core modules.
- Remove projection formulas from ingestion, UI and server handlers.
- Preserve blanks, doubles and 2026/27 scoring rules.
- Add explicit team-strength method selection.
- Record component outputs and role probabilities.
- Replace ambiguous `minutes` percentage fields with named availability and expected-minutes fields.

Acceptance:

- Live API and persisted forecast for identical inputs match within `1e-6`.
- Role probabilities sum to one.
- Blank gameweek forecast is zero.
- Double gameweek aggregates both fixtures.
- All existing scoring rule tests remain valid.

## WP-07: Underlying and market integration

Goal: make optional data operational and honest.

Tasks:

- Rewrite underlying matching to use reviewable match statuses.
- Ingest compatible goals markets when available.
- Implement expected-goal derivation with a versioned method and tests.
- Use market goal estimates only when derivation inputs are complete.
- Fall back through official team strength and then FDR.
- Expose method and age in Model Debug.

Acceptance:

- H2H-only observations do not create expected goals.
- A complete stored market fixture selects the market method.
- Removing the market observation selects official-strength fallback deterministically.
- Ambiguous player/team matches never affect projections.

## WP-08: Immutable forecast runs

Goal: create reproducible pre-deadline forecasts.

Tasks:

- Implement `ForecastRun` and `PlayerFixtureForecast` services; one run covers the configured maximum future gameweeks and recommendation horizons aggregate its fixture rows.
- Create runs after successful ingestion and through `npm run forecast`.
- Store exact source IDs, input hash and configuration.
- Forbid update/delete of succeeded forecasts through application services.
- Mark backtest eligibility using creation time and copied deadline.
- Select the latest eligible run as deadline baseline.

Acceptance:

- Two refreshes create two runs rather than updating rows.
- A post-deadline run is ineligible.
- The selected baseline is the latest successful eligible run.
- A stored run can reproduce its forecasts from referenced inputs.
- Failed forecast creation retains a failed run and leaves facts intact.

## WP-09: Seeded uncertainty

Goal: show outcome distributions rather than false precision.

Tasks:

- Implement deterministic PRNG and Poisson/event draws without adding an unnecessary heavyweight dependency.
- Implement the 2,000-sample simulation in the blueprint.
- Store standard deviation and p10/p50/p90.
- Add paired simulation support for plan comparisons using common random numbers where practical.
- Add UI range and assumption labels.

Acceptance:

- Same seed and inputs produce byte-identical summaries.
- `p10 <= p50 <= p90`.
- Zero appearance probability produces zero points.
- Increasing start probability does not reduce expected minutes.
- UI calls the range an outcome range, not a confidence interval.

## WP-10: Lineup and multi-transfer recommendations

Goal: rank executable zero-to-five-transfer plans.

Tasks:

- Refactor XI, bench, captain and vice calculation to use aggregated stored forecasts.
- Implement bounded search for up to five transfers with dominance pruning.
- Include exact economics, hit cost, substitution cover and uncertainty penalty.
- Always include roll.
- Persist recommendation sets and candidates.
- Add probability-beats-roll decision rule.

Acceptance:

- Every returned plan is legal and affordable or explicitly unknown.
- No plan claims executability with unknown affordability.
- Hit costs are correct for 0–5 free transfers.
- Recommended action follows the 60% rule.
- Re-reading a recommendation set reproduces its ordering and explanation values.

## WP-11: Real chip counterfactuals

Goal: replace heuristic chip numbers.

Tasks:

- Delete `wcGain` and `fhGain` heuristics.
- Implement TC and BB single-week counterfactuals.
- Implement temporary FH optimisation.
- Implement persistent WC optimisation over the selected horizon.
- Store chip recommendation candidates through the same recommendation tables.
- Hide unavailable/failed estimates instead of falling back to a fabricated value.

Acceptance:

- No chip gain is calculated from a fixed constant or bench multiplier.
- FH reverts to the baseline plan after the target gameweek.
- WC retains the changed squad in subsequent gameweeks.
- TC gain equals one additional captain score distribution.
- Each chip gain compares against the same no-chip baseline.

## WP-12: Backtesting and calibration

Goal: measure the exact deployed model without leakage.

Tasks:

- Join completed results only to eligible deadline-baseline runs.
- Add metric grouping from the blueprint.
- Add interval coverage and rank correlation.
- Train versioned calibration sets.
- Refuse application below sample threshold.
- Add a backtest API and UI showing insufficient sample state.
- Close all database/script resources.

Acceptance:

- Post-deadline forecasts never enter metrics.
- Re-running backtest without new results is idempotent.
- Fewer than 100 observations produces `Uncalibrated` and factor 1.
- Metrics cite model version and training cutoff.
- Command exits cleanly with zero observations.

## WP-13: Decision journal

Goal: measure whether recommendations helped the manager.

Tasks:

- Record accepted, rejected, ignored and custom actions.
- Persist baseline and chosen plan IDs.
- Evaluate realized deltas after results exist.
- Add simple history UI with expected versus realized values.
- Do not label retrospective differences as causal proof.

Acceptance:

- A decision remains reproducible after later forecasts are created.
- Outcome evaluation uses the saved baseline, not today's squad.
- Pending outcomes remain pending.
- History distinguishes model forecast error from manager decision result.

## WP-14: Cache, freshness and upstream control

Goal: implement documented resilience.

Tasks:

- Add keyed memory and atomic restart catalogue caches.
- Add source freshness thresholds.
- Add league request caching, pagination policy and concurrency limit five.
- Return cache state and sampled-manager count.
- Remove or update every stale README claim.

Acceptance:

- Restart cache serves only within maximum stale age.
- Cache does not change source observation timestamps.
- Signal/config version changes invalidate the relevant catalogue key.
- League upstream concurrency never exceeds five.
- UI visibly distinguishes fresh, stale and missing.

## WP-15: Secrets and endpoint cleanup

Goal: remove avoidable development-security debt.

Tasks:

- Remove API keys from SQLite.
- Store optional local key once with mode `0600`, or use environment variables.
- Replace key-returning endpoint with configuration metadata.
- Sanitize error/log output.
- Add method/content-type/body-size validation consistently.
- Remove obsolete endpoints after clients migrate.

Acceptance:

- Searching database contents cannot find configured provider key.
- No API returns the full key.
- Logs contain no authorization header or key.
- Oversized request bodies terminate safely with 413.

## WP-16: End-to-end verification and documentation

Goal: ship a coherent development build.

Tasks:

- Add fixture-based ingestion integration tests.
- Add server/API integration tests against a temporary database.
- Add browser smoke tests for import, plan, recommendation, evidence and refresh workflows.
- Run complete acceptance suite.
- Rewrite README setup, architecture and limitations.
- Remove dead code, unused tables, obsolete model names and misleading comments.

Acceptance:

- All commands in `ACCEPTANCE_TESTS.md` pass.
- Fresh clone/reset can reach a working demo using documented steps.
- No repository search finds obsolete schema/model/cache claims.
- Git worktree contains only intentional source, tests and documentation changes.

## Review gates

A stronger reviewer should inspect after WP-06, WP-09, WP-10, WP-11 and WP-12. These packages contain material modeling or optimisation judgment. Mechanical packages may proceed under the implementation model when their acceptance criteria pass.
