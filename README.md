# Insomnia FPL

An FPL planning companion built around deterministic, explainable recommendations. It includes a public squad import, editable bank and free-transfer assumptions, a persisted squad builder with direct player replacement, contextual transfer comparison, legal squad/transfer validation, a recommended XI, captaincy, confirmation and undo for local plan changes, player search and a grounded squad assistant. It never changes the manager's official FPL team.

## Run locally

```bash
npm install
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
  -e SIGNAL_INGEST_TOKEN='replace-with-a-long-random-token' \
  -e SIGNAL_CONFIG_FILE='/app/data/signal-config.json' \
  -e FPL_DATA_CACHE_FILE='/app/data/cache/fpl-data.json' \
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

Uncertain names stay in the Signals tab for manual linking. Confirmed links are remembered as aliases. General opinions remain evidence only; projections change only when a claim includes explicit role/minutes fields.

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

The canonical schema is in `prisma/schema.prisma`. The app uses SQLite through Node's built-in SQLite driver. Put a local path such as `DATABASE_URL="file:./dev.db"` in the ignored `.env.local` file, then run the idempotent schema setup:

```bash
npm run db:push
```

The current schema also contains provenance-aware `PlayerSignal` evidence and a resolved `PlayerOutlook` for each player/gameweek. Signals carry a source URL, confidence, observation time, expiry and review status. `db:push` is intentionally non-destructive; use a reviewed migration workflow before changing production data.

To refresh the live public FPL data and append a player snapshot:

```bash
npm run ingest:fpl
npm run verify:db
```

To refresh the optional underlying-performance and market feeds:

```bash
ODDS_API_KEY=replace-with-your-key npm run ingest:signals
```

`ingest:signals` pulls Understat EPL player aggregates into auditable historical snapshots and imports de-vigged EPL match-winner probabilities from The Odds API. Understat is used as the attacking-rate input when a snapshot exists; odds are retained for later team-strength adjustments. Both feeds retain the raw response, use a local cache when a refresh fails, and never create verified injury or role overrides. Set `FPL_SEASON_START_YEAR` when ingesting a season other than the current calendar-year season.

The local server exposes the refreshed catalog at `/api/fpl-data`. The React UI reads players, fixtures, prices, form and availability from that endpoint and falls back to the demo catalog if the database is temporarily unavailable. The rules-aware model uses individual fixtures (including blanks and doubles), expected minutes, shrunk per-90 attacking rates, expected goals conceded, saves, cards, penalties, bonus history and 2026/27 defensive-contribution inputs.

The server keeps the latest successful `/api/fpl-data` response in `.cache/fpl-data.json`. After the first successful load, restarts serve that snapshot immediately and refresh it from SQLite in the background. The in-memory freshness window defaults to 60 seconds and the restart cache to 24 hours; set `FPL_DATA_CACHE_TTL_MS`, `FPL_DATA_CACHE_MAX_STALE_MS`, or `FPL_DATA_CACHE_FILE` to override them. The example Docker deployment stores the database and cache together under `/app/data`.

## FPL intelligence layer

`src/intelligence.ts` exposes provenance-aware typed tools such as `getMySquad`, `searchPlayers`, `getPlayerProjection`, `getBestTransfers`, `simulateTransfer`, `getUpgradeOpportunities` and `getCaptainCandidates`. They return source facts and deterministic model outputs separately, making the interfaces suitable for a future MCP wrapper without giving an LLM unrestricted database access.

`src/decision-review.ts` implements a bounded Quant → Skeptic → Arbiter workflow. The default path is deterministic and works without an LLM provider; optional provider callbacks can critique and explain the supplied evidence but cannot replace the underlying calculations.

The `Model Debug` view is intentionally developer-only and is available by adding `?debug=1` to the local URL. It ranks every loaded player and exposes the projection model version, baseline, fixture adjustment, expected-minutes adjustment, attacking contribution, clean-sheet contribution, bonus, card deduction and final xPts across the selected 1/3/5 gameweek horizon. The scorer also handles appearance thresholds, goals conceded, saves, penalty saves/misses, own goals, defensive contributions and official BPS tie allocation.

## Role evidence and squad challenge

The projection model separates a start, substitute appearance and no-show for every player. Verified current evidence can update those probabilities; expired, rejected and merely pending claims cannot. Recent transfers deliberately fall back to a low-confidence role prior until evidence establishes the new depth-chart position. The optimiser chooses a legal XI, captain, vice-captain and bench cover separately for every gameweek in the planning horizon.

On **My Team**, **Challenge squad** uses the OpenAI Responses API with web search and strict structured output to look for current role, injury, set-piece and minutes risks. Set `OPENAI_API_KEY` and optionally `OPENAI_RESEARCH_MODEL` in `.env.local`, or use the app's personal API-key setting. Results are accepted only when their URL appears in the API's actual web-search sources, then stored as `PENDING`. A manager must approve a finding before it can affect projections; approval also materializes the resolved role in `PlayerOutlook`. This is intentionally an evidence workflow, not a second optimiser or a mechanism that treats an LLM's prose as truth.

Source priority is official FPL/club/Premier League material first, followed by reputable journalists and established predicted-lineup sources. A commercial editorial feed such as FPL Scout can be added later as a licensed provider, but the architecture does not require one and should not scrape or republish subscriber content. User-submitted feedback is stored as low-confidence `PENDING` evidence through `/api/player-signals`; manual overrides are explicit, fully trusted records rather than silently inferred from chat.

## Learning and backtesting

`npm run ingest:fpl` saves a projection for every upcoming player fixture before the deadline. Once matches exist, it also imports each player's match-level history from the public FPL API. Run:

```bash
npm run backtest
```

This compares saved projections with actual points, reports sample size, MAE, RMSE and bias by position, and stores a bounded position calibration factor after at least 20 observations. The live API applies those factors to future projections. Set `FPL_INGEST_MATCH_HISTORY=0` for a lightweight catalogue-only refresh.

## Architecture notes

The calculation boundary lives in `src/domain.ts`. `src/integrations.ts` isolates raw FPL responses and defines the structured context contract; `src/explanations.ts` builds a grounded prompt and accepts a provider function, keeping LLM calls outside the calculation layer. `scripts/serve.mjs` provides the server-side database adapter at `/api/fpl-data`, while the projection/optimisation functions remain pure. Planning horizons, legality rules, hit costs and roll thresholds are centralized in the domain layer; the UI only presents calculated recommendations.

The app intentionally does not authenticate with FPL or perform transfers. Forecasts remain probabilistic: official assists and BPS are consumed from FPL after matches, while future assists and bonus returns are estimated from xA and historical bonus rates.
