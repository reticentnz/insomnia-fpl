# Insomnia FPL

An FPL planning companion built around deterministic, explainable recommendations. It stores immutable source observations, assembles a timestamped projection catalogue, writes immutable forecast runs, and evaluates executable local plans. It imports a public FPL squad but never changes the manager's official FPL team.

## Run locally

```bash
npm install
npm run db:migrate
npm run dev
```

Then open `http://localhost:4173`. `npm run build` runs the deterministic domain verification and creates a production bundle in `dist/`; the lightweight Node server serves it locally.

## Docker and Unraid

The production image builds the React bundle in a Node build stage and runs only the lightweight application server in the final stage. Runtime secrets are not copied into the image.

Build and run it on any Docker host:

```bash
docker build -t insomnia-fpl:local .
docker run -d \
  --name insomnia-fpl \
  --restart unless-stopped \
  -p 4173:4173 \
  -e DATABASE_URL='file:/app/data/insomnia-fpl.db' \
  -e APP_DATA_DIR='/app/data' \
  -e SIGNAL_INGEST_TOKEN='replace-with-a-long-random-token' \
  -e SIGNAL_CONFIG_FILE='/app/data/signal-config.json' \
  -e FPL_CATALOG_CACHE_FILE='/app/data/cache/projection-catalog.json' \
  -v "$PWD/data:/app/data" \
  insomnia-fpl:local
```

Alternatively, copy `compose.example.yaml` to `compose.yaml`, then run `docker compose up -d --build`. The bind-mounted `./data` directory retains the SQLite database, WAL files and restart cache when the container is stopped or replaced. Ensure it is writable by container UID 1000 before the first start.

The container exposes a liveness check at `/api/health`. From n8n, use `http://insomnia-fpl:4173` when both containers share a user-defined Docker network. Otherwise use the Unraid server's fixed LAN address and mapped port.

The creator-signal endpoint is `POST /api/signals/ingest`. It requires `Authorization: Bearer <SIGNAL_INGEST_TOKEN>` and an `application/json` body. n8n should send one stable video ID plus structured claims; retrying the same payload is idempotent:

```json
{
  "schemaVersion": 1,
  "source": {
    "platform": "YOUTUBE",
    "externalId": "JmJBKn7Zurk",
    "creator": "PL Mate",
    "title": "Ranking your FPL hidden gems",
    "url": "https://www.youtube.com/watch?v=JmJBKn7Zurk"
  },
  "claims": [
    {
      "rawPlayerName": "Kai Havt",
      "clubHint": "Arsenal",
      "category": "ROTATION",
      "sentiment": "NEGATIVE",
      "summary": "Too risky for GW1 due to competition for striker minutes.",
      "timestampSeconds": 122,
      "depthRole": "ROTATION",
      "confidence": 0.8
    }
  ]
}
```

Matched claims become auditable player signals. Uncertain names are returned in the ingestion response and are not retained; correct the player hint and retry the stable claim payload. General opinions remain evidence only; projections change only when a verified claim includes explicit role/minutes fields.

GitHub is optional. The image can be built directly on Unraid from a copied or cloned working tree. For repeatable updates, push the repository to GitHub and publish an image to GitHub Container Registry; Unraid can then pull `ghcr.io/<owner>/<repository>:latest`. Keep database URLs and ingestion tokens in Unraid/n8n secrets, never in GitHub or the image.

## Security & Network Access

> [!WARNING]
> **No Built-in Authentication**: Insomnia FPL does not include user authentication or access controls. It is designed to be executed in a private environment (localhost, home LAN, or secure VPN/Tailscale).

* **Local LAN / VPN Only**: Access the app over your home network (e.g. `http://unraid-ip:4173`) or via Tailscale / WireGuard when remote.
* **Do Not Port-Forward**: Never expose port `4173` directly to the public internet. Anyone with access to the URL can view/edit squad plans and consume any configured LLM API keys.
* **Remote Access via Reverse Proxy**: If you must access it outside your home network, place it behind an authenticating reverse proxy such as **Authelia**, **Authentik**, **Cloudflare Access**, or **Nginx Proxy Manager** with access control enabled.

## Building a GW1 draft

Before the Gameweek 1 deadline the app automatically enters **GW1 Draft** mode. The budget is a hard £100.0m cap and money in the bank is derived from the selected squad rather than entered manually. In **Edit planned squad**, select the players you must own, mark them as locked, and choose **Optimise squad around locks**. The optimiser searches coordinated squad changes using the selected 1/3/5-gameweek horizon, starting-XI and captaincy output, vice-captain reliability, reduced bench weighting, expected minutes and projection uncertainty.

The **Transfers** tab becomes the **GW1 Draft Lab** before the opening deadline and can recommend a multi-player restructure without transfer hits. After that deadline it returns to the in-season direct-transfer workflow, using the manager's bank, free transfers and hit costs. An empty in-season shortlist means no affordable same-position swap cleared the displayed projection threshold; it does not claim that every possible multi-transfer route is inferior.

## Database

The canonical schema is in `db/migrations/001_initial_rebuild.sql`. The app uses SQLite through Node's built-in SQLite driver. Put a local path such as `DATABASE_URL="file:./dev.db"` in the ignored `.env.local` file, then run the checksum-aware migration workflow:

```bash
npm run db:migrate
```

Development data can be explicitly discarded with `npm run db:reset -- --yes-reset-development-data`; the reset script refuses unsafe database paths. Verify the active schema with `npm run db:verify`.

To refresh the live public FPL data and append immutable official observations:

Set `FPL_SEASON` (for example, `2026/27`) or `FPL_SEASON_START_YEAR` before ingesting; the ingestion does not embed a season in application logic.

```bash
npm run ingest:fpl
npm run db:verify
```

To refresh the optional underlying-performance and market feeds:

```bash
ODDS_API_KEY=replace-with-your-key npm run ingest:signals
```

`ingest:signals` pulls Understat EPL player aggregates into auditable historical snapshots and imports de-vigged EPL match-winner probabilities from The Odds API. Understat is used as the attacking-rate input when a snapshot exists; odds are retained for later team-strength adjustments. Both feeds retain the raw response, use a local cache when a refresh fails, and never create verified injury or role overrides.

In Docker, the signal cache defaults to `/app/data/cache/signal-feeds`, which is inside the persistent writable volume. Override it with `SIGNAL_CACHE_DIR` if needed.

The local server exposes the projection-input catalogue at `/api/catalog`. It includes source-specific freshness timestamps, provenance and a cache status. The shared model uses individual fixtures (including blanks and doubles), explicit start/substitute/no-show role probabilities, expected minutes, shrunk per-90 attacking rates, expected goals conceded, saves, cards, penalties, bonus history and 2026/27 defensive-contribution inputs.

The server keeps successful `/api/catalog` assemblies in a keyed memory cache for 60 seconds by default, and persists the latest successful request variant through an atomic rename. If catalogue assembly fails after a restart, an eligible restart entry (up to 24 hours old by default) is returned with `cache.status: "STALE"`; source observation timestamps are never replaced by response time. Set `FPL_CATALOG_CACHE_TTL_MS`, `FPL_CATALOG_CACHE_MAX_STALE_MS`, or `FPL_CATALOG_CACHE_FILE` to override this. The example Docker deployment stores the database and cache together under `/app/data`. League samples are cached for five minutes, request no more than five upstream calls at once, and label effective ownership as a sampled-manager measure when only the first standings page is loaded.

## FPL intelligence layer

`src/intelligence.ts` exposes provenance-aware typed tools such as `getMySquad`, `searchPlayers`, `getPlayerProjection`, `getBestTransfers`, `simulateTransfer`, `getUpgradeOpportunities` and `getCaptainCandidates`. They return source facts and deterministic model outputs separately, making the interfaces suitable for a future MCP wrapper without giving an LLM unrestricted database access.

`src/decision-review.ts` implements a bounded Quant → Skeptic → Arbiter workflow. The default path is deterministic and works without an LLM provider; optional provider callbacks can critique and explain the supplied evidence but cannot replace the underlying calculations.

The `Model Debug` view is intentionally developer-only and is available by adding `?debug=1` to the local URL. It ranks every loaded player and exposes the projection model version, baseline, fixture adjustment, expected-minutes adjustment, attacking contribution, clean-sheet contribution, bonus, card deduction and final xPts across the selected 1/3/5 gameweek horizon. The scorer also handles appearance thresholds, goals conceded, saves, penalty saves/misses, own goals, defensive contributions and official BPS tie allocation.

## Role evidence and squad challenge

The projection model separates a start, substitute appearance and no-show for every player. Verified current evidence can update those probabilities; expired, rejected and merely pending claims cannot. Recent transfers deliberately fall back to a low-confidence role prior until evidence establishes the new depth-chart position. The optimiser chooses a legal XI, captain, vice-captain and bench cover separately for every gameweek in the planning horizon.

On **My Team**, **Challenge squad** uses the OpenAI Responses API with web search and strict structured output to look for current role, injury, set-piece and minutes risks. Set `OPENAI_API_KEY` and optionally `OPENAI_RESEARCH_MODEL` in `.env.local`, or use the app's personal API-key setting. Results are accepted only when their URL appears in the API's actual web-search sources, then stored as `PENDING`. A manager must approve a finding before it can affect projections; the next catalogue and forecast resolve the canonical signal ledger directly. This is intentionally an evidence workflow, not a second optimiser or a mechanism that treats an LLM's prose as truth.

Source priority is official FPL/club/Premier League material first, followed by reputable journalists and established predicted-lineup sources. A commercial editorial feed such as FPL Scout can be added later as a licensed provider, but the architecture does not require one and should not scrape or republish subscriber content. User-submitted feedback is stored as low-confidence `PENDING` evidence through `/api/player-signals`; manual overrides are explicit, fully trusted records rather than silently inferred from chat.

## Learning and backtesting

`npm run ingest:fpl` saves a projection for every upcoming player fixture before the deadline. Once matches exist, it also imports each player's match-level history from the public FPL API. Run:

```bash
npm run backtest
```

This compares eligible pre-deadline projections with actual points and reports sample size, MAE, RMSE, mean bias, interval coverage and rank correlation. Calibration remains `Uncalibrated` with factor `1` until a group has at least 100 observations; applied factors are capped to `0.85–1.15`. Set `FPL_INGEST_MATCH_HISTORY=0` for a lightweight catalogue-only refresh.

## Architecture notes

The calculation boundary is shared across `src/core/scoring.ts`, `src/core/projection.ts`, `src/core/uncertainty.ts`, `src/core/lineup.ts`, `src/core/transfers.ts`, `src/core/optimizer.ts` and `src/core/chips.ts`. `src/server/catalog-service.ts` selects immutable inputs at an explicit `asOf`; `src/server/forecast-service.ts` persists its outputs. `src/integrations.ts` isolates raw FPL responses, while `src/explanations.ts` keeps LLM calls outside deterministic calculations. The server serves `/api/catalog`, manager and plan APIs, recommendations, decision history and backtests; the UI only presents calculated results.

Expensive player/fixture projection is an offline boundary. Each successful ingestion creates an immutable `ForecastRun` and its `PlayerFixtureForecast` rows; recommendation requests read those stored rows and run only the manager-specific, bounded transfer or chip search. A completed recommendation is itself reused when the plan, forecast run, horizon, transfer limit, chip and uncertainty settings are identical. A changed forecast run or planning input creates a new result, preserving both freshness and reproducibility.

The application header shows the operational state of that boundary: forecast ready, processing, stale, failed or missing; generation time; stored player/fixture and gameweek coverage; next scheduled refresh; and the immutable run/model identifier. It refreshes automatically every 30 seconds.

Container startup applies all pending SQL migrations before reporting the database ready. When upgrading an existing container, retain and back up the mounted `/app/data` volume; no separate manual migration command is required under the standard Docker configuration.

## Verification

All tests use saved fixtures or temporary databases and do not require a network connection:

```bash
npm test
npm run typecheck
npm run test:integration
npm run test:e2e
npm run build
npm run db:reset -- --yes-reset-development-data
npm run db:migrate
npm run db:verify
npm run backtest
```

For command-line database verification, set `DATABASE_URL` to a repository-local or application-data SQLite file. The reset command intentionally refuses broad or unresolved paths.

The app intentionally does not authenticate with FPL or perform transfers. Forecasts remain probabilistic: official assists and BPS are consumed from FPL after matches, while future assists and bonus returns are estimated from xA and historical bonus rates.
