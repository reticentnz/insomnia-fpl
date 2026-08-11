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
