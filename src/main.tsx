import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  bestXI,
  benchOrder,
  buildDraftImprovementPlan,
  buildLegalDefaultSquad,
  buildLegalRemainingSquad,
  computeDraftFingerprint,
  computeDraftPlayerFingerprint,
  draftSquadScore,
  evaluateModeTransition,
  getSquad,
  groupLegalChangeBundles,
  horizonProjection,
  getPlayerUpcomingFixtures,
  initialSquadBank,
  isInitialDraftPeriod,
  isLegalTransfer,
  isPlayerInjured,
  isPlayerFlagged,
  optimizeInitialSquad,
  players as demoPlayers,
  priceMovementAlert,
  netTransfers,
  projectedTeamScore,
  resolvePlanningMode,
  resolveSquadSaveTarget,
  squadIds,
  transferDecision,
  transfers,
  validateInitialSquad,
  validateSquad,
  INITIAL_SQUAD_BUDGET,
  TRANSFER_GAIN_THRESHOLDS,
  calculateChipImpact,
  generateSquadExportText,
  getPlayerFixtureTicker,
  getDifferentialsAndEnablers,
  getCaptaincyBreakdown,
  calculateRivalEO,
  type DifferentialPick,
  type CaptaincyBreakdown,
  type ChipType,
  type ChipImpact,
  getTeamColor,
  getPlayerShirtColor,
  type FixtureTickerItem,
  type DraftImprovementPlan,
  type DraftChangeBundle,
  type Player,
  type Transfer,
} from "./domain";
import {
  fetchLiveCatalog,
  fetchProjectionCatalog,
  fetchPublicSquad,
  parseTeamId,
  fetchLLMExplanation,
  fetchFplAccount,
  getUserProfile,
  saveUserProfile,
  saveUserPreferences,
  saveManagerAssumptions,
  selectPlanRevision,
  deleteUserProfile,
  fetchServerAiConfig,
  saveServerAiConfig,
  challengeSquad,
  SquadChallengeError,
  updatePlayerSignalStatusesBatch,
  createManualPlayerSignal,
  fetchPlayerSignals,
  fetchLeagueDetails,
  type FplAccount,
  type FplLeagueSummary,
  type LeagueDetailsResponse,
  type LeagueRival,
  type SquadChallengeResult,
  fetchAllSignals,
  fetchTeamMarketSnapshots,
  ingestSignalText,
  fetchCreatorClaims,
  resolveCreatorClaim,
  dismissCreatorClaim,
  type CreatorClaim,
  fetchSignalConfig,
  saveSignalConfig,
  type SignalSourceConfig,
  DEFAULT_SIGNAL_SOURCE_CONFIG,
  fetchSystemStatus,
  fetchLatestForecast,
  type ForecastSummary,
  fetchBacktest,
  fetchDecisionHistory,
  createPlanRecommendation,
  recordRecommendationDecision,
  type CanonicalRecommendation,
  type SystemStatus,
  type TeamMarketSnapshot,
  fetchAdminStatus,
  runAdminOperation,
  type AdminStatus,
} from "./integrations";
import { type PlayerSignal, sanitizeExternalUrl } from "./player-signals";
import { createToolContext } from "./intelligence";
import { reviewDecision, type DecisionReview } from "./decision-review";
import { projectionBreakdown } from "./model";
import { deriveForecastReadiness } from "./forecast-status";
import "./styles.css";

type GlyphProps = { size?: number; className?: string };
const glyph = (symbol: string) => (props: GlyphProps) => (
  <span
    className={props.className}
    style={{
      fontSize: props.size ? `${props.size}px` : undefined,
      lineHeight: 1,
    }}
    aria-hidden="true"
  >
    {symbol}
  </span>
);
const ArrowRight = glyph("→"),
  Bot = glyph("✦"),
  ChevronDown = glyph("⌄"),
  Gauge = glyph("◒"),
  ListFilter = glyph("☷"),
  Radio = glyph("◉"),
  Search = glyph("⌕"),
  Shield = glyph("◇"),
  Sparkles = glyph("✧"),
  Trophy = glyph("♛"),
  Users = glyph("♙"),
  Zap = glyph("⚡");
const Settings = glyph("⚙");
let players = demoPlayers;

const primaryIcons = {
  "My Team": Users,
  Transfers: ArrowRight,
  Players: ListFilter,
  Signals: Radio,
  Leagues: Trophy,
  Review: Gauge,
  Ask: Bot,
  Admin: Settings,
};
type ManagerSettings = { bank: number; freeTransfers: number };
type ToastState = { message: string; undo?: boolean } | null;
let activeManagerSettings: ManagerSettings = { bank: 1.2, freeTransfers: 1 };
let activeDraftMode = false;
let activeLockedIds: number[] = [];
let activeDraftPlan: DraftImprovementPlan | null = null;
let activeApplyDraftPlan = () => {};
function PlayerChip({
  p,
  sub = false,
  horizon,
  onClick,
  isSwapSource = false,
  isSwapTarget = false,
  isLocked = false,
}: {
  p: Player;
  sub?: boolean;
  horizon?: number;
  onClick?: () => void;
  isSwapSource?: boolean;
  isSwapTarget?: boolean;
  isLocked?: boolean;
}) {
  const ticker = getPlayerFixtureTicker(p, 5);
  const pAlert = priceMovementAlert(p);

  const swapClass = isSwapSource
    ? " quick-swap-source"
    : isSwapTarget
    ? " quick-swap-target"
    : "";

  const signalActive = (p.roleProfile?.derivedFromSignalIds?.length ?? 0) > 0;
  const startProb = p.roleProfile?.startProbability ?? 1;
  const signalRisk = signalActive && startProb < 0.6;
  const signalBoost = signalActive && startProb >= 0.6;

  return (
    <div
      className={"player-chip " + (sub ? "sub" : "") + swapClass + (isLocked ? " locked-chip" : "")}
      onClick={onClick}
      style={onClick ? { cursor: "pointer" } : undefined}
    >
      <span className="shirt" style={{ background: getPlayerShirtColor(p) }}>
        {p.position}
      </span>
      <span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
          <b>{p.name}</b>
          {isLocked && (
            <span className="chip-lock-badge" title="Locked core player">🔒</span>
          )}
          {pAlert === "RISING_SOON" && (
            <span className="price-trend-badge rising" title="Price rising soon">▲</span>
          )}
          {pAlert === "FALLING_SOON" && (
            <span className="price-trend-badge falling" title="Price falling soon">▼</span>
          )}
          {signalRisk && (
            <span
              className="signal-risk-badge"
              title={`Signal active: ${Math.round(startProb * 100)}% start chance — minutes suppressed in model`}
            >◉</span>
          )}
          {signalBoost && (
            <span
              className="signal-active-badge"
              title={`Signal active: ${Math.round(startProb * 100)}% start chance`}
            >◉</span>
          )}
        </span>
        <small>
          {p.club} · £{p.price.toFixed(1)}m
        </small>
        <div className="fixture-ticker">
          {ticker.map((item, idx) => (
            <span
              key={idx}
              className={`fixture-ticker-pill ${item.difficultyClass}`}
              title={`GW${item.gameweek}: ${item.opponent} (${item.venue}) - FDR ${item.difficulty}`}
            >
              {item.opponent}{item.venue}
            </span>
          ))}
        </div>
      </span>
      <strong>{(horizon == null ? p.projection : horizonProjection(p, horizon)).toFixed(1)}</strong>
    </div>
  );
}

function CaptainBreakdownBar({ breakdown }: { breakdown: CaptaincyBreakdown }) {
  return (
    <div style={{ marginTop: "8px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "10px",
          color: "var(--text-muted)",
        }}
      >
        <span>🎯 Attack: {breakdown.attackingXpts} ({breakdown.attackingPct}%)</span>
        <span>🛡️ Def: {breakdown.defensiveXpts} ({breakdown.defensivePct}%)</span>
        <span>⭐ Bonus: {breakdown.bonusAppearanceXpts}</span>
      </div>
      <div className="captain-breakdown-bar">
        <div
          className="breakdown-segment attacking"
          style={{ width: `${breakdown.attackingPct}%` }}
          title={`Attacking: ${breakdown.attackingXpts} xPts`}
        />
        <div
          className="breakdown-segment defensive"
          style={{ width: `${breakdown.defensivePct}%` }}
          title={`Defensive: ${breakdown.defensiveXpts} xPts`}
        />
        <div
          className="breakdown-segment bonus"
          style={{ width: `${breakdown.bonusAppearancePct}%` }}
          title={`Bonus/App: ${breakdown.bonusAppearanceXpts} xPts`}
        />
      </div>
    </div>
  );
}
function getGreeting(userName: string = "Alex") {
  const hour = new Date().getHours();
  const timeGreeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return userName ? `${timeGreeting}, ${userName}.` : `${timeGreeting}.`;
}
function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (name.trim().slice(0, 2) || "A").toUpperCase();
}

function formatDeadlineText(deadlineIso: string | null): string {
  const targetIso = deadlineIso || "2026-08-21T05:30:00.000Z";
  const deadlineMs = new Date(targetIso).getTime();
  const diffMs = deadlineMs - Date.now();
  if (diffMs <= 0) return "Deadline passed";
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours >= 48) {
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d until deadline`;
  }
  return `${diffHours}h until deadline`;
}

function formatOperationalTime(value?: string | null) {
  if (!value) return "not scheduled";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "unknown";
  return new Date(time).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function ForecastReadinessPanel({ system, forecast, requestedHorizon }: { system: SystemStatus | null; forecast: ForecastSummary | null; requestedHorizon: number }) {
  const readiness = deriveForecastReadiness(system, forecast);
  const copy = {
    READY: { title: "Forecast ready", detail: "Recommendations use this stored offline dataset." },
    RUNNING: { title: "Forecast processing", detail: forecast ? "A refresh is running; the previous successful forecast remains available." : "Player projections are being generated in the background." },
    STALE: { title: "Forecast stale", detail: `The stored inputs are older than ${readiness.staleAfterHours} hours. Recommendations may be out of date.` },
    FAILED: { title: "Forecast refresh failed", detail: forecast ? "The previous successful forecast remains available while the refresh problem is resolved." : system?.message || "No usable forecast is currently available." },
    MISSING: { title: "Forecast missing", detail: "Ingestion has not yet produced a successful offline projection dataset." },
  }[readiness.state];
  return <section className={`forecast-readiness forecast-readiness-${readiness.state.toLowerCase()}`} aria-label="Offline forecast status" role="status">
    <div className="forecast-readiness-primary"><span className="forecast-readiness-dot"/><div><small>OFFLINE PROJECTION STATUS</small><b>{copy.title}</b><p>{copy.detail}</p></div></div>
    <div className="forecast-readiness-metrics">
      <span><small>Generated</small><b>{forecast ? formatOperationalTime(forecast.createdAt) : "—"}</b></span>
      <span><small>Coverage</small><b>{readiness.playerCount ? `${readiness.playerCount} players · ${readiness.fixtureCount} fixtures` : "—"}</b></span>
      <span><small>Gameweeks</small><b>{forecast ? `${readiness.coveredGameweeks}/${requestedHorizon} available` : "—"}</b></span>
      <span><small>Next refresh</small><b>{system?.ingestIntervalHours === 0 ? "Disabled" : formatOperationalTime(system?.nextIngestAt)}</b></span>
    </div>
    {forecast && <code title={forecast.id}>Run {forecast.id.slice(0, 8)} · {forecast.modelVersion}</code>}
  </section>;
}

const adminActionDetails = [
  { id: "fpl-sync", icon: "↻", title: "Sync FPL data", description: "Fetch the official bootstrap, fixtures, player histories, and rebuild the stored forecast." },
  { id: "odds-sync", icon: "◈", title: "Sync betting odds", description: "Fetch current EPL markets and store de-vigged fixture probabilities." },
  { id: "team-refresh", icon: "⚽", title: "Refresh linked team", description: "Re-import the currently linked manager squad, prices, bank, and points." },
  { id: "relink-player-teams", icon: "⤢", title: "Relink players to clubs", description: "Refresh official player-to-club observations, then re-import the linked manager squad." },
];

function AdminView() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(() => sessionStorage.getItem("fpl-admin-token") || "");
  const [starting, setStarting] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setStatus(await fetchAdminStatus()); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Admin status unavailable"); }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(load, status?.operations.some(operation => operation.status === "RUNNING") ? 2_000 : 10_000);
    return () => window.clearInterval(timer);
  }, [load, status?.operations.some(operation => operation.status === "RUNNING")]);
  const run = async (id: string) => {
    setStarting(id); setError(null);
    try {
      if (token) sessionStorage.setItem("fpl-admin-token", token);
      await runAdminOperation(id, token);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Operation failed to start"); }
    finally { setStarting(null); }
  };
  const running = status?.operations.some(operation => operation.status === "RUNNING") || false;
  return <div className="admin-view">
    <section className="admin-summary-grid">
      <div className="admin-metric"><small>Season</small><b>{status?.season || "—"}</b></div>
      <div className="admin-metric"><small>Linked team</small><b>{status?.manager?.teamName || "Not linked"}</b><span>{status?.manager ? `${status.manager.playerCount} players · #${status.manager.teamId}` : "Connect a team from My Team"}</span></div>
      <div className="admin-metric"><small>Unresolved links</small><b>{(status?.unresolved.players || 0) + (status?.unresolved.fixtures || 0)}</b><span>{status?.unresolved.players || 0} players · {status?.unresolved.fixtures || 0} fixtures</span></div>
      <div className="admin-metric"><small>Odds provider</small><b>{status?.oddsConfigured ? "Configured" : "Not configured"}</b><span>{status?.oddsConfigured ? "Ready to sync" : "Set ODDS_API_KEY"}</span></div>
    </section>
    {status?.authenticationRequired && <section className="admin-token-card">
      <div><b>Admin authentication</b><p>Enter the server's admin token to run operations. It stays in this browser tab.</p></div>
      <input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="Admin token" autoComplete="current-password" />
    </section>}
    {error && <div className="admin-error" role="alert">{error}</div>}
    <section className="admin-actions-grid">
      {adminActionDetails.map(action => {
        const operation = status?.operations.find(candidate => candidate.id === action.id);
        const busy = operation?.status === "RUNNING" || starting === action.id;
        return <article className="admin-action-card" key={action.id}>
          <div className="admin-action-icon">{action.icon}</div>
          <div className="admin-action-copy"><h3>{action.title}</h3><p>{action.description}</p></div>
          <div className={`admin-operation-state state-${(operation?.status || "IDLE").toLowerCase()}`}>
            <span>{busy ? "Running" : operation?.status === "SUCCEEDED" ? "Completed" : operation?.status === "FAILED" ? "Failed" : "Ready"}</span>
            {(operation?.message || operation?.error) && <small>{operation.error || operation.message}</small>}
            {operation?.finishedAt && <time>{formatOperationalTime(operation.finishedAt)}</time>}
          </div>
          <button className="dark-btn" disabled={running || Boolean(starting) || (status?.authenticationRequired && !token)} onClick={() => void run(action.id)}>
            {busy ? "Running…" : `Run ${action.title}`}
          </button>
        </article>;
      })}
    </section>
    <section className="admin-feed-card">
      <div className="admin-section-heading"><div><small>INGESTION AUDIT</small><h2>Recent feed runs</h2></div><button className="ghost-btn" onClick={() => void load()}>Refresh</button></div>
      <div className="admin-feed-table" role="table">
        <div className="admin-feed-row admin-feed-header" role="row"><span>Source</span><span>Status</span><span>Started</span><span>Changes</span><span>Links</span></div>
        {status?.feedRuns.length ? status.feedRuns.map(run => <div className="admin-feed-row" role="row" key={run.id} title={run.error || run.id}>
          <b>{run.source.replaceAll("_", " ")}</b><span className={`feed-status feed-${run.status.toLowerCase()}`}>{run.status}</span><span>{formatOperationalTime(run.startedAt)}</span><span>{run.insertedCount} added · {run.updatedCount} updated</span><span>{run.unmatchedCount ? `${run.unmatchedCount} unresolved` : "All linked"}{run.usedCache ? " · cache" : ""}</span>
        </div>) : <p className="admin-empty">No feed runs recorded yet.</p>}
      </div>
    </section>
  </div>;
}

function App() {
  const [tab, setTab] = useState("My Team");
  const [horizon, setHorizon] = useState(5);
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerFilter, setPlayerFilter] = useState("All");
  const [question, setQuestion] = useState("");
  const [submittedQuestion, setSubmittedQuestion] = useState("");
  const [editing, setEditing] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fplAccount, setFplAccount] = useState<FplAccount | null>(null);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [activePlanParentId, setActivePlanParentId] = useState<string | null>(null);
  const [officialSellingPrices, setOfficialSellingPrices] = useState<Record<number, number | null>>({});
  const [profileHydrated, setProfileHydrated] = useState(false);
  const [onboardingModalOpen, setOnboardingModalOpen] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [teamInput, setTeamInput] = useState("");
  const [teamMessage, setTeamMessage] = useState("");
  const [toast, setToast] = useState<ToastState>(null);
  const [previousSquad, setPreviousSquad] = useState<number[] | null>(null);
  const [pendingTransfer, setPendingTransfer] = useState<Transfer | null>(null);
  const [comparison, setComparison] = useState<Transfer | null>(null);
  const [syncingAccount, setSyncingAccount] = useState(false);
  const [userName, setUserName] = useState("Alex");
  const [hadSavedSquad, setHadSavedSquad] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [manager, setManager] = useState<ManagerSettings>({ bank: 1.2, freeTransfers: 1 });
  const [review, setReview] = useState<DecisionReview | null>(null);
  const [explanationReview, setExplanationReview] =
    useState<DecisionReview | null>(null);
  const [explanationTransfer, setExplanationTransfer] =
    useState<Transfer | null>(null);
  const [playerDetail, setPlayerDetail] = useState<Player | null>(null);
  const [livePlayers, setLivePlayers] = useState<Player[] | null>(null);
  const [forecastSummary, setForecastSummary] = useState<ForecastSummary | null>(null);
  const [canonicalRecommendation, setCanonicalRecommendation] = useState<CanonicalRecommendation | null>(null);
  const [canonicalRecommendationLoading, setCanonicalRecommendationLoading] = useState(false);
  const [catalogMode, setCatalogMode] = useState<
    "loading" | "live" | "demo-live" | "demo-conflict" | "demo-offline"
  >("loading");
  const [currentGameweek, setCurrentGameweek] = useState<number | null>(null);
  const [deadlineTime, setDeadlineTime] = useState<string | null>(null);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [llmAnswer, setLlmAnswer] = useState<string | null>(null);
  const [llmProvider, setLlmProvider] = useState<string>(
    "Deterministic Engine",
  );
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  const [analysisNonce, setAnalysisNonce] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [aiProvider, setAiProvider] = useState("gemini");
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [squadChallenge, setSquadChallenge] = useState<SquadChallengeResult | null>(null);
  const [stagedSignalReviews, setStagedSignalReviews] = useState<Record<string, "VERIFIED" | "REJECTED">>({});
  const [applyingBatch, setApplyingBatch] = useState(false);
  const [challengeLoading, setChallengeLoading] = useState(false);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [challengeRawOutput, setChallengeRawOutput] = useState<string>("");
  const [challengeOutputTypes, setChallengeOutputTypes] = useState<string[]>([]);
  const [targetSwapPlayer, setTargetSwapPlayer] = useState<Player | null>(null);
  const [activeChip, setActiveChip] = useState<ChipType>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [copiedExport, setCopiedExport] = useState(false);
  const [initialClear, setInitialClear] = useState(false);
  const [lockedIds, setLockedIds] = useState<number[]>([]);
  const debugEnabled = useMemo(
    () => new URLSearchParams(window.location.search).has("debug"),
    [],
  );
  const icons = debugEnabled
    ? { ...primaryIcons, "Model Debug": Gauge }
    : primaryIcons;
  useEffect(() => {
    if (!livePlayers?.length) { setForecastSummary(null); return; }
    let active = true;
    const refresh = () => fetchLatestForecast(horizon as 1 | 3 | 5).then(value => { if (active) setForecastSummary(value); }).catch(() => { if (active) setForecastSummary(null); });
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [livePlayers, horizon]);
  useEffect(() => { setCanonicalRecommendation(null); }, [activePlanId, horizon]);
  const catalog = useMemo(() => {
    const base = livePlayers && livePlayers.length > 0 ? livePlayers : [];
    if (!forecastSummary || forecastSummary.horizon !== horizon) return base;
    const forecasts = new Map(forecastSummary.players.map(player => [player.playerId, player]));
    return base.map(player => {
      const forecast = forecasts.get(player.id);
      return forecast ? { ...player, storedForecast: { runId: forecastSummary.id, horizon, ...forecast } } : player;
    });
  }, [livePlayers, forecastSummary, horizon]);
  const squad = useMemo(
    () =>
      selectedIds
        .map((id) => catalog.find((p) => p.id === id))
        .filter(Boolean)
        .map((player) => Object.prototype.hasOwnProperty.call(officialSellingPrices, player!.id)
          ? { ...player!, sellingPrice: officialSellingPrices[player!.id] == null ? null : officialSellingPrices[player!.id]! / 10 }
          : player!) as Player[],
    [selectedIds, catalog, officialSellingPrices],
  );
  const [catalogSeason, setCatalogSeason] = useState<string | null>(null);
  const [seasonModeManagerAccountId, setSeasonModeManagerAccountId] = useState<string | null>(null);
  const [seasonModeSeason, setSeasonModeSeason] = useState<string | null>(null);
  const [snapshotMeta, setSnapshotMeta] = useState<{ officialSnapshotId: string; snapshotSeason: string; officialPlayerCount: number; managerAccountId: string } | null>(null);
  const [storedDraftIds, setStoredDraftIds] = useState<number[]>([]);
  const [storedDraftLocks, setStoredDraftLocks] = useState<number[]>([]);
  const [transitionNotice, setTransitionNotice] = useState<string | null>(null);
  const [pendingOfficialTransition, setPendingOfficialTransition] = useState<{
    squadIds: number[];
    planId?: string | null;
    parentPlanId?: string | null;
    sellingPrices?: Record<number, number | null>;
    account?: FplAccount | null;
    snapshotMetadata?: { officialSnapshotId: string; snapshotSeason: string; officialPlayerCount: number; managerAccountId: string } | null;
    planBank?: number | null;
    planFreeTransfers?: number | null;
  } | null>(null);

  const isMetadataLoaded = Boolean(catalog.length > 0 || snapshotMeta != null);
  const currentSeason = catalogSeason || snapshotMeta?.snapshotSeason || "2026/27";
  const hasCurrentSeasonOfficialSquad = Boolean(
    snapshotMeta?.officialSnapshotId &&
    snapshotMeta?.officialPlayerCount === 15 &&
    snapshotMeta?.snapshotSeason === currentSeason
  );
  const activeAccountId = fplAccount?.managerAccountId || fplAccount?.id || snapshotMeta?.managerAccountId || null;
  const planningMode = resolvePlanningMode({
    hasCurrentSeasonOfficialSquad,
    officialSnapshotManagerAccountId: snapshotMeta?.managerAccountId,
    officialSnapshotSeason: snapshotMeta?.snapshotSeason,
    activationManagerAccountId: seasonModeManagerAccountId,
    activationSeason: seasonModeSeason,
    currentSeason,
    activeManagerAccountId: activeAccountId,
    isMetadataLoaded,
  });
  const draftMode = planningMode === "DRAFT";

  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);

  const planningModeRef = useRef(planningMode);
  useEffect(() => { planningModeRef.current = planningMode; }, [planningMode]);

  const effectiveBank = draftMode ? initialSquadBank(squad) : manager.bank;
  const xi = bestXI(horizon, squad);
  const topTransfers = useMemo(
    () =>
      draftMode
        ? []
        : transfers(
            horizon,
            manager.bank,
            manager.freeTransfers,
            squad,
            catalog,
          ),
    [draftMode, horizon, squad, catalog, manager],
  );
  const draftPlan = useMemo(
    () =>
      draftMode && squad.length === 15
        ? buildDraftImprovementPlan(squad, catalog, {
            lockedPlayerIds: lockedIds,
            horizon: horizon as 1 | 3 | 5,
            budget: INITIAL_SQUAD_BUDGET,
          })
        : null,
    [draftMode, squad, catalog, lockedIds, horizon],
  );
  const legalBundles = useMemo(
    () =>
      draftMode && draftPlan
        ? groupLegalChangeBundles(squad, draftPlan.changes, effectiveBank, horizon as 1 | 3 | 5, INITIAL_SQUAD_BUDGET)
        : [],
    [draftMode, draftPlan, squad, effectiveBank, horizon],
  );

  const currentFingerprint = useMemo(
    () => computeDraftPlayerFingerprint(selectedIds),
    [selectedIds],
  );

  useEffect(() => {
    if (!profileHydrated || !draftMode) return;
    if (squadChallenge && (squadChallenge as any).draftRevision) {
      if ((squadChallenge as any).draftRevision !== currentFingerprint) {
        setSquadChallenge(null);
      }
    }
  }, [profileHydrated, draftMode, currentFingerprint]);
  const decision = useMemo(
    () =>
      draftMode
        ? {
            transfer: null,
            roll: !draftPlan,
            reason: draftPlan
              ? `A full-squad restructure adds ${draftPlan.gain} projected points.`
              : "No whole-squad improvement was found within £100.0m.",
            hitCost: 0,
            freeTransfers: 0,
          }
        : transferDecision(
            horizon,
            manager.bank,
            manager.freeTransfers,
            squad,
            catalog,
          ),
    [draftMode, draftPlan, horizon, squad, catalog, manager],
  );

  const chipImpacts = useMemo(
    () => calculateChipImpact(squad, horizon as 1 | 3 | 5),
    [squad, horizon],
  );

  const exportText = useMemo(
    () =>
      generateSquadExportText(
        squad,
        horizon as 1 | 3 | 5,
        manager.bank,
        manager.freeTransfers,
        activeChip,
      ),
    [squad, horizon, manager, activeChip],
  );
  const weakest = decision.transfer;
  const captain = [...xi].sort(
    (a, b) => horizonProjection(b, horizon) - horizonProjection(a, horizon),
  )[0];
  activeManagerSettings = { ...manager, bank: effectiveBank };
  activeDraftMode = draftMode;
  activeLockedIds = lockedIds;
  activeDraftPlan = draftPlan;
  players = catalog;
  useEffect(() => {
    if (!profileHydrated) return;
    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const loadCatalog = async () => {
      try {
        const data = await fetchLiveCatalog(3);
        if (!active) return;
        setLivePlayers(data.players);
        setCapturedAt(data.capturedAt || null);
        if (data.season) setCatalogSeason(data.season);
        if (data.currentGameweek) setCurrentGameweek(data.currentGameweek);
        if (data.deadline) setDeadlineTime(data.deadline);
        const mapped = selectedIds
          .map((id) => data.players.find((p) => p.id === id))
          .filter(Boolean) as Player[];
        const incomingDraftMode = isInitialDraftPeriod(
          data.currentGameweek,
          data.deadline,
        );
        const issues = incomingDraftMode
          ? validateInitialSquad(mapped)
          : validateSquad(mapped, manager.bank);
        if (hadSavedSquad && (mapped.length !== 15 || issues.length)) {
          setCatalogMode("demo-conflict");
        } else {
          setCatalogMode("live");
          if (!hadSavedSquad) {
            const legalPicks = incomingDraftMode
              ? optimizeInitialSquad(data.players, {
                  horizon: 5,
                  budget: INITIAL_SQUAD_BUDGET,
                })
              : buildLegalDefaultSquad(data.players, 100 + manager.bank);
            setSelectedIds(legalPicks.map((p) => p.id));
            setCatalogMode("demo-live");
          }
        }
      } catch {
        if (!active) return;
        fetchSystemStatus()
          .then((sys) => {
            if (!active) return;
            setSystemStatus(sys);
            if (sys.isSeeding || sys.status === "initializing" || sys.status === "seeding") {
              pollTimer = setTimeout(loadCatalog, 3000);
            } else {
              setLivePlayers([]);
              setCatalogMode("demo-offline");
            }
          })
          .catch(() => {
            if (!active) return;
            setLivePlayers([]);
            setCatalogMode("demo-offline");
          });
      }
    };

    loadCatalog();
    return () => {
      active = false;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [profileHydrated]);

  useEffect(() => {
    if (profileHydrated) void saveUserPreferences({ challengeResult: squadChallenge });
  }, [profileHydrated, squadChallenge]);

  useEffect(() => {
    if (profileHydrated) void saveUserPreferences({ stagedReviews: stagedSignalReviews });
  }, [profileHydrated, stagedSignalReviews]);

  useEffect(() => {
    let active = true;
    fetchPlayerSignals()
      .then((signals) => {
        if (!active || !signals.length) return;
        setSquadChallenge((current) => {
          if (current) {
            const map = new Map(signals.map((s) => [s.id, s]));
            return {
              ...current,
              signals: current.signals.map((item) => {
                const match = map.get(item.id);
                return match ? { ...item, status: match.status } : item;
              }),
            };
          }
          const verified = signals.filter(
            (s) => s.status === "VERIFIED" || s.status === "PENDING",
          );
          if (!verified.length) return current;
          return {
            summary: `${verified.length} active evidence finding${verified.length === 1 ? "" : "s"} loaded from database.`,
            provider: "Insomnia FPL Evidence Engine",
            audits: [],
            signals: verified,
            sources: [],
          };
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    getUserProfile().then(({ account, selectedIds: serverIds, preferences, planId, parentPlanId, sellingPrices, snapshotMetadata }) => {
      const prefs = preferences;
      if (account) setFplAccount(account);
      setActivePlanId(planId || null);
      setActivePlanParentId(parentPlanId || null);
      setOfficialSellingPrices(sellingPrices || {});
      setSnapshotMeta(snapshotMetadata || null);

      const storedActivationAccountId = prefs?.seasonModeManagerAccountId || null;
      const storedActivationSeason = prefs?.seasonModeSeason || null;
      const draftIds = prefs?.draftPlayerIds || [];
      const draftLocks = prefs?.draftLockedPlayerIds || [];
      setStoredDraftIds(draftIds);
      setStoredDraftLocks(draftLocks);
      setSeasonModeManagerAccountId(storedActivationAccountId);
      setSeasonModeSeason(storedActivationSeason);

      const activeAccountId = account?.managerAccountId || account?.id || snapshotMetadata?.managerAccountId || null;
      const resolvedSeason = catalogSeason || snapshotMetadata?.snapshotSeason || prefs?.draftSeason || null;

      const effectiveMode = resolvePlanningMode({
        hasCurrentSeasonOfficialSquad: Boolean(
          snapshotMetadata?.officialSnapshotId &&
          snapshotMetadata?.officialPlayerCount === 15 &&
          resolvedSeason &&
          snapshotMetadata?.snapshotSeason === resolvedSeason
        ),
        officialSnapshotManagerAccountId: snapshotMetadata?.managerAccountId,
        officialSnapshotSeason: snapshotMetadata?.snapshotSeason,
        activationManagerAccountId: storedActivationAccountId,
        activationSeason: storedActivationSeason,
        currentSeason: resolvedSeason || "2026/27",
        activeManagerAccountId: activeAccountId,
      });

      if (effectiveMode === "DRAFT") {
        const isCurrentSeasonDraft = !resolvedSeason || prefs?.draftSeason === resolvedSeason;
        const idsToUse = isCurrentSeasonDraft && draftIds.length === 15 ? draftIds : (serverIds || []);
        const locksToUse = isCurrentSeasonDraft && draftIds.length === 15 ? draftLocks : (prefs?.lockedIds || []);
        if (idsToUse.length) {
          setSelectedIds(idsToUse);
          setLockedIds(locksToUse);
          setHadSavedSquad(true);
        }
        const currentFinger = computeDraftPlayerFingerprint(idsToUse);
        const savedChallenge = prefs?.challengeResult as (SquadChallengeResult & { draftRevision?: string }) | null;
        if (savedChallenge && (!savedChallenge.draftRevision || savedChallenge.draftRevision === currentFinger)) {
          setSquadChallenge(savedChallenge);
        } else {
          setSquadChallenge(null);
        }
      } else {
        // SEASON Mode
        const ids = serverIds?.length ? serverIds : (prefs?.selectedIds?.length ? prefs.selectedIds : []);
        if (ids.length) {
          setSelectedIds(ids);
          setHadSavedSquad(true);
        }
        setLockedIds(prefs?.lockedIds || []);
        setSquadChallenge(null);
      }

      if (prefs) {
        setManager({ bank: prefs.bank ?? account?.bank ?? 1.2, freeTransfers: prefs.freeTransfers ?? 1 });
        setUserName(prefs.userName || account?.managerName || "Alex");
        setStagedSignalReviews(effectiveMode === "SEASON" ? {} : (prefs.stagedReviews || {}));
        setAiProvider(account?.aiProvider || "gemini");
        setApiKey("");
        setOnboardingModalOpen(!account && !prefs.onboardingCompleted);
      } else {
        setOnboardingModalOpen(!account);
      }
    }).catch(() => {
      setOnboardingModalOpen(true);
    }).finally(() => setProfileHydrated(true));
  }, []);

  useEffect(() => {
    fetchServerAiConfig().then((cfg) => {
      if (cfg.provider) {
        setAiProvider(cfg.provider);
      }
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!submittedQuestion) {
      setReview(null);
      setLlmAnswer(null);
      setLlmProvider("Deterministic Engine");
      setLlmError(null);
      setLlmLoading(false);
      return;
    }
    let active = true;
    setLlmLoading(true);
    setLlmError(null);
    setLlmAnswer(null);
    setReview(null);
    const localReview = reviewDecision(
      submittedQuestion,
      horizon,
      createToolContext({
        players: catalog,
        squad,
        bank: effectiveBank,
        freeTransfers: draftMode ? 5 : manager.freeTransfers,
        currentGameweek: currentGameweek || 1,
      }),
    )
      .then((result) => {
        if (active) setReview(result);
      })
      .catch(() => {
        if (active) setLlmError("The local analysis could not be completed");
      });
    const llmRequest = fetchLLMExplanation(
      submittedQuestion,
      {
        modelVersion: "v1",
        horizon,
        squad,
        catalog,
        startingXI: xi,
        captain,
        transfers: topTransfers,
        decision,
        bank: effectiveBank,
        freeTransfers: draftMode ? 5 : manager.freeTransfers,
        currentGameweek: currentGameweek || 1,
      },
      apiKey ? { apiKey, provider: aiProvider } : undefined,
    ).then((res) => {
      if (!active) return;
      if (res?.answer) {
        setLlmAnswer(res.answer);
        setLlmProvider(res.provider);
      } else if (res?.error)
        setLlmError(`${res.error}. Showing the local analysis instead`);
    });
    Promise.allSettled([localReview, llmRequest]).then(() => {
      if (active) setLlmLoading(false);
    });
    return () => {
      active = false;
    };
  }, [
    submittedQuestion,
    horizon,
    squad,
    catalog,
    apiKey,
    aiProvider,
    analysisNonce,
    currentGameweek,
    deadlineTime,
    manager,
  ]);
  const answer = review
    ? `${review.arbiter.decision}: ${review.arbiter.mainArgument} ${review.arbiter.strongestCounterargument} Confidence: ${review.arbiter.confidence}.`
    : "";
  const affordableLimit = useMemo(
    () =>
      comparison
        ? comparison.out.price + effectiveBank
        : Math.max(...squad.map((p) => p.price), 0) + effectiveBank,
    [comparison, squad, effectiveBank],
  );
  const filteredPlayers = catalog.filter((p) => {
    const matches =
      p.name.toLowerCase().includes(playerQuery.toLowerCase()) ||
      p.club.toLowerCase().includes(playerQuery.toLowerCase());
    const owned = selectedIds.includes(p.id);
    return (
      matches &&
      (playerFilter === "All" ||
        (playerFilter === "My Squad" && owned) ||
        (playerFilter === "Affordable" && p.price <= affordableLimit) ||
        (playerFilter === "Flagged" && isPlayerFlagged(p)) ||
        playerFilter === p.position)
    );
  });
  useEffect(() => {
    if (!explanationTransfer) {
      setExplanationReview(null);
      return;
    }
    let active = true;
    setExplanationReview(null);
    reviewDecision(
      `Why ${explanationTransfer.in.name}?`,
      horizon,
      createToolContext({
        players: catalog,
        squad,
        bank: effectiveBank,
        freeTransfers: draftMode ? 5 : manager.freeTransfers,
        currentGameweek: currentGameweek || 1,
      }),
      {},
      explanationTransfer,
    ).then((result) => {
      if (active) setExplanationReview(result);
    });
    return () => {
      active = false;
    };
  }, [explanationTransfer, horizon, squad, catalog, currentGameweek, deadlineTime, manager]);
  const saveSquad = async (ids: number[], nextLockedIds = lockedIds) => {
    const priorIds = selectedIds;
    const priorLocks = lockedIds;
    const validLocks = nextLockedIds.filter((id) => ids.includes(id));
    setSelectedIds(ids);
    setLockedIds(validLocks);
    setChallengeError(null);
    setChallengeRawOutput("");
    const saveTarget = resolveSquadSaveTarget({ draftMode });

    if (saveTarget === "USER_PREFERENCES") {
      const mapped = ids.map((id) => catalog.find((p) => p.id === id)).filter(Boolean) as Player[];
      const issues = validateInitialSquad(mapped, INITIAL_SQUAD_BUDGET);
      if (issues.length) {
        setSelectedIds(priorIds);
        setLockedIds(priorLocks);
        setToast({ message: issues[0].detail });
        return;
      }
      const revision = computeDraftFingerprint(ids, validLocks);

      const ok = await saveUserPreferences({
        draftSeason: currentSeason,
        draftPlayerIds: ids,
        draftLockedPlayerIds: validLocks,
        draftRevision: revision,
        draftUpdatedAt: new Date().toISOString(),
      });

      if (ok) {
        setStoredDraftIds(ids);
        setStoredDraftLocks(validLocks);
        setHadSavedSquad(true);
        setToast({ message: "GW1 draft saved — nothing was submitted to FPL." });
        setEditing(false);
      } else {
        setSelectedIds(ids);
        setLockedIds(validLocks);
        setEditing(true);
        setToast({ message: "Draft could not be persisted" });
      }
      return;
    }

    setSquadChallenge(null);
    void saveUserPreferences({ selectedIds: ids, lockedIds: validLocks });
    if (fplAccount) {
      void saveUserProfile(fplAccount, ids, activePlanId, validLocks)
        .then((result) => {
          if (!result || !result.ok) {
            setSelectedIds(priorIds);
            setLockedIds(priorLocks);
            const errMsg = typeof result?.error === 'string' ? result.error : (result?.error as any)?.message || "The plan could not be saved because its economics or squad structure is invalid.";
            setToast({ message: errMsg });
            return;
          }
          if (result.planId) {
            setActivePlanId(result.planId);
            setActivePlanParentId(result.parentPlanId || null);
          }
          if (result.bankTenths != null) setManager((current) => ({ ...current, bank: result.bankTenths! / 10, freeTransfers: result.freeTransfers ?? current.freeTransfers }));
        })
        .catch((error) => {
          setSelectedIds(priorIds);
          setLockedIds(priorLocks);
          setToast({ message: error instanceof Error ? error.message : "Failed to save squad plan." });
        });
    }
    setEditing(false);
  };
  const generateCanonicalRecommendation = async (chip: 'TRIPLE_CAPTAIN' | 'BENCH_BOOST' | 'FREE_HIT' | 'WILDCARD' | null = null) => {
    if (!activePlanId) { setToast({ message: 'Import and confirm an official squad before generating a stored recommendation.' }); return; }
    setCanonicalRecommendationLoading(true);
    try {
      setCanonicalRecommendation(await createPlanRecommendation(activePlanId, { horizon: horizon as 1 | 3 | 5, chip }));
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Recommendation could not be generated.' });
    } finally { setCanonicalRecommendationLoading(false); }
  };
  const applyCanonicalCandidate = async (candidate: CanonicalRecommendation['candidates'][number]) => {
    if (!canonicalRecommendation || !activePlanId) return;
    if (candidate.action === 'CHIP') {
      await recordRecommendationDecision({ recommendationSetId: canonicalRecommendation.id, candidateId: candidate.id, decision: 'ACCEPTED', selectedPlanId: activePlanId, reason: 'Chip plan accepted for manual execution in official FPL' });
      setToast({ message: 'Chip decision recorded. Activate the chip manually in official FPL.' });
      return;
    }
    if (!fplAccount || !candidate.apiMoves?.length) return;
    const replacements = new Map(candidate.apiMoves.map(move => [Number(move.outId), Number(move.inId)]));
    const nextIds = selectedIds.map(id => replacements.get(id) ?? id);
    const nextLocks = lockedIds.filter(id => !replacements.has(id));
    const result = await saveUserProfile(fplAccount, nextIds, activePlanId, nextLocks);
    if (!result.ok || !result.planId) { setToast({ message: result.error || 'The recommended plan could not be saved.' }); return; }
    setPreviousSquad(selectedIds); setSelectedIds(nextIds); setLockedIds(nextLocks); setActivePlanId(result.planId); setActivePlanParentId(result.parentPlanId || null);
    if (result.bankTenths != null) setManager(current => ({ ...current, bank: result.bankTenths! / 10, freeTransfers: result.freeTransfers ?? current.freeTransfers }));
    await recordRecommendationDecision({ recommendationSetId: canonicalRecommendation.id, candidateId: candidate.id, decision: 'ACCEPTED', selectedPlanId: result.planId, reason: 'Applied from the stored recommendation surface' });
    setToast({ message: `Stored ${candidate.apiMoves.length}-move plan applied locally; your official FPL team was not changed.`, undo: true });
  };
  const dismissCanonicalCandidate = async (candidate: CanonicalRecommendation['candidates'][number], decision: 'REJECTED' | 'IGNORED') => {
    if (!canonicalRecommendation) return;
    await recordRecommendationDecision({ recommendationSetId: canonicalRecommendation.id, candidateId: candidate.id, decision, reason: 'Recorded from the recommendation surface' });
    setToast({ message: `${decision === 'REJECTED' ? 'Rejected' : 'Ignored'} recommendation recorded in Review.` });
  };
  const requestTransfer = (outId: number, inId: number) => {
    const out = squad.find((p) => p.id === outId);
    const incoming = catalog.find((p) => p.id === inId);
    if (
      !out ||
      !incoming ||
      !isLegalTransfer(squad, out, incoming, effectiveBank)
    ) {
      setToast({
        message:
          "That change is not legal with your current budget and squad rules.",
      });
      return;
    }
    const match = topTransfers.find(
      (t) => t.out.id === outId && t.in.id === inId,
    );
    setPendingTransfer(
      match || {
        out,
        in: incoming,
        gain: +(
          horizonProjection(incoming, horizon) - horizonProjection(out, horizon)
        ).toFixed(1),
        net: +(
          horizonProjection(incoming, horizon) -
          horizonProjection(out, horizon) -
          (draftMode || manager.freeTransfers > 0 ? 0 : 4)
        ).toFixed(1),
        priceDelta: +(incoming.price - out.price).toFixed(1),
        hitCost: draftMode || manager.freeTransfers > 0 ? 0 : 4,
        outProjection: +horizonProjection(out, horizon).toFixed(1),
        inProjection: +horizonProjection(incoming, horizon).toFixed(1),
      },
    );
  };
  const confirmTransfer = () => {
    if (!pendingTransfer) return;
    setPreviousSquad(selectedIds);
    const next = selectedIds.map((id) =>
      id === pendingTransfer.out.id ? pendingTransfer.in.id : id,
    );
    saveSquad(
      next,
      lockedIds.filter((id) => id !== pendingTransfer.out.id),
    );
    setExplanationTransfer(null);
    setPendingTransfer(null);
    setToast({
      message: `Plan updated: ${pendingTransfer.out.name} → ${pendingTransfer.in.name}. Your official FPL team was not changed.`,
      undo: true,
    });
  };
  const applyDraftPlan = () => {
    if (!draftPlan) return;
    setPreviousSquad(selectedIds);
    saveSquad(
      draftPlan.squad.map((player) => player.id),
      lockedIds,
    );
    setToast({
      message: `GW1 draft re-optimised: ${draftPlan.changes.length} change${draftPlan.changes.length === 1 ? "" : "s"} for +${draftPlan.gain} projected points.`,
      undo: true,
    });
  };
  const applyDraftBundle = (bundle: DraftChangeBundle) => {
    if (!bundle || !bundle.changes.length) return;
    setPreviousSquad(selectedIds);
    const swapMap = new Map(bundle.changes.map((c) => [c.out.id, c.in.id]));
    const nextIds = selectedIds.map((id) => swapMap.get(id) ?? id);
    saveSquad(nextIds, lockedIds);
    setToast({
      message: `Bundle applied: ${bundle.label} (+${bundle.netGain} pts).`,
      undo: true,
    });
  };
  activeApplyDraftPlan = applyDraftPlan;
  const challengeNonceRef = useRef(0);
  const runSquadChallenge = async () => {
    if (!squad.length) return;
    const startFingerprint = computeDraftPlayerFingerprint(selectedIds);
    const nonce = challengeNonceRef.current + 1;
    challengeNonceRef.current = nonce;

    setChallengeLoading(true);
    setChallengeError(null);
    setChallengeRawOutput("");
    setChallengeOutputTypes([]);
    setSquadChallenge(null);
    setStagedSignalReviews({});

    try {
      const result = await challengeSquad(
        squad.map((player) => player.id),
        horizon,
        {
          apiKey: apiKey || undefined,
          provider: aiProvider,
          startingPlayerIds: xi.map((player) => player.id),
        },
      );
      if (
        challengeNonceRef.current !== nonce ||
        planningModeRef.current === "SEASON" ||
        computeDraftPlayerFingerprint(selectedIdsRef.current) !== startFingerprint
      ) {
        return;
      }
      setSquadChallenge({ ...result, draftRevision: startFingerprint } as any);
    } catch (error) {
      if (challengeNonceRef.current !== nonce) return;
      setChallengeError(
        error instanceof Error ? error.message : "Squad challenge failed",
      );
      if (error instanceof SquadChallengeError) {
        setChallengeRawOutput(error.rawOutput);
        setChallengeOutputTypes(error.outputTypes);
      }
    } finally {
      if (challengeNonceRef.current === nonce) {
        setChallengeLoading(false);
      }
    }
  };
  const undoTransfer = async () => {
    if (activePlanParentId) {
      const result = await selectPlanRevision(activePlanParentId);
      if (result.ok && result.plan) {
        const plan = result.plan;
        setSelectedIds(plan.players.map((player: { fplId: number }) => Number(player.fplId)));
        setLockedIds(plan.players.filter((player: { locked: boolean }) => player.locked).map((player: { fplId: number }) => Number(player.fplId)));
        setActivePlanId(plan.id);
        setActivePlanParentId(plan.parentPlanId || null);
        if (plan.bankTenths != null) setManager((current) => ({ ...current, bank: Number(plan.bankTenths) / 10, freeTransfers: Number(plan.freeTransfers) }));
        setPreviousSquad(null);
        setToast({ message: "Exact parent plan restored." });
        return;
      }
    }
    if (previousSquad) {
      saveSquad(previousSquad);
      setPreviousSquad(null);
      setToast({ message: "Planned squad restored." });
    }
  };
  const saveManager = (next: ManagerSettings) => {
    const applied = fplAccount ? { ...next, bank: manager.bank } : next;
    setManager(applied);
    if (fplAccount) void saveManagerAssumptions(fplAccount.teamId, { freeTransfers: applied.freeTransfers });
    else void saveUserPreferences(applied);
    setSettingsOpen(false);
  };
  const compareTransfer = (t: Transfer) => {
    setComparison(t);
    setPlayerFilter(t.in.position);
    setPlayerQuery("");
    setTab("Players");
    setExplanationTransfer(null);
  };
  const repairLiveSquad = () => {
    if (!livePlayers) return;
    const legal = draftMode
      ? optimizeInitialSquad(livePlayers, {
          lockedPlayerIds: lockedIds,
          horizon: horizon as 1 | 3 | 5,
          budget: INITIAL_SQUAD_BUDGET,
        })
      : buildLegalDefaultSquad(livePlayers, 100 + manager.bank);
    saveSquad(legal.map((p) => p.id));
    setCatalogMode("live");
    setToast({
      message:
        "A new live-data starter squad is ready. Review it before using any recommendation.",
    });
  };
  // Stage a signal review locally — no network call, no model recalculation
  const reviewSquadSignal = (
    signal: PlayerSignal,
    status: "VERIFIED" | "REJECTED",
  ) => {
    setStagedSignalReviews((prev) => {
      // Toggling the same staged status = undo the stage
      if (prev[signal.id] === status) {
        const next = { ...prev };
        delete next[signal.id];
        return next;
      }
      return { ...prev, [signal.id]: status };
    });
  };

  const unstageSignalReview = (signalId: string | number) => {
    setStagedSignalReviews((prev) => {
      const next = { ...prev };
      delete next[signalId];
      return next;
    });
  };

  const applyBatchReview = async () => {
    const requestedUpdates = Object.entries(stagedSignalReviews).map(([id, status]) => ({
      id,
      status,
    }));
    if (!requestedUpdates.length) return;
    setApplyingBatch(true);
    try {
      // A challenge can survive longer than the database row set it came from
      // it came from. Reconcile IDs before submitting so one stale review does
      // not make an otherwise valid batch appear to do nothing.
      let updates = requestedUpdates;
      let staleReviewCount = 0;
      try {
        const currentSignals = await fetchAllSignals({ limit: 500 });
        const liveIds = new Set(currentSignals.map((signal) => signal.id));
        const staleIds = requestedUpdates.filter((update) => !liveIds.has(update.id)).map((update) => update.id);
        staleReviewCount = staleIds.length;
        updates = requestedUpdates.filter((update) => liveIds.has(update.id));
        if (staleIds.length) {
          setStagedSignalReviews((current) => {
            const next = { ...current };
            staleIds.forEach((id) => delete next[id]);
            return next;
          });
          setSquadChallenge((current) => current
            ? { ...current, signals: current.signals.filter((signal) => liveIds.has(signal.id)) }
            : current);
          if (!updates.length) {
            throw new Error("These reviews belong to an older database session and are no longer available. Run the challenge again to create current evidence.");
          }
        }
      } catch (error) {
        // Preserve normal offline/error handling, but don't let a failed
        // reconciliation request prevent the batch endpoint from being tried.
        if (error instanceof Error && error.message.includes("older database session")) throw error;
      }
      const updatedSignals = await updatePlayerSignalStatusesBatch(updates);
      // Apply the server-confirmed statuses back into local state
      const statusMap = new Map(updatedSignals.map((s) => [s.id, s.status]));
      setSquadChallenge((current) =>
        current
          ? {
              ...current,
              signals: current.signals.map((item) =>
                statusMap.has(item.id) ? { ...item, status: statusMap.get(item.id)! } : item,
              ),
            }
          : current,
      );
      setStagedSignalReviews({});
      const data = await fetchLiveCatalog();
      setLivePlayers(data.players);
      setCapturedAt(data.capturedAt || null);
      const approvedCount = updates.filter((u) => u.status === "VERIFIED").length;
      const rejectedCount = updates.filter((u) => u.status === "REJECTED").length;
      const parts = [];
      if (approvedCount) parts.push(`${approvedCount} approved`);
      if (rejectedCount) parts.push(`${rejectedCount} rejected`);
      if (staleReviewCount) parts.push(`${staleReviewCount} stale review${staleReviewCount === 1 ? "" : "s"} removed`);
      setToast({
        message: `${parts.join(", ")} · Projections refreshed.`,
      });
    } catch (error) {
      setChallengeError(
        error instanceof Error ? error.message : "Could not apply evidence changes",
      );
    } finally {
      setApplyingBatch(false);
    }
  };
  const handleManualOverride = async (
    playerId: number,
    startProbability: number,
    note?: string,
  ) => {
    try {
      await createManualPlayerSignal(playerId, startProbability, note);
      const data = await fetchLiveCatalog();
      setLivePlayers(data.players);
      setCapturedAt(data.capturedAt || null);
      setToast({
        message: `Updated start probability to ${Math.round(startProbability * 100)}% and recalculated projections.`,
      });
    } catch (error) {
      setChallengeError(
        error instanceof Error ? error.message : "Could not set manual override",
      );
    }
  };
  const syncAccount = async (targetTeamId?: number) => {
    const idToUse = targetTeamId || fplAccount?.teamId || parseTeamId(teamInput);
    if (!idToUse) {
      setTeamMessage("Enter a numeric team ID or an FPL team URL.");
      return;
    }
    setSyncingAccount(true);
    setImporting(true);
    setTeamMessage("Fetching latest FPL account & team details...");
    try {
      const res = await fetchFplAccount(idToUse, currentGameweek || 1);
      const hydratedIds = res.selectedIds.filter((id) => catalog.some((x) => x.id === id));
      const prof = await getUserProfile();
      const hasOfficialSquad = Boolean(prof.snapshotMetadata?.officialSnapshotId && prof.snapshotMetadata?.officialPlayerCount === 15);
      const isDraftDirty = editing || computeDraftPlayerFingerprint(selectedIds) !== computeDraftPlayerFingerprint(storedDraftIds);
      const transition = evaluateModeTransition({
        currentMode: planningMode === "SEASON" ? "SEASON" : "DRAFT",
        hasOfficialSquad,
        isEditorDirty: isDraftDirty,
      });

      if (transition.requiresPrompt) {
        setPendingOfficialTransition({
          squadIds: hydratedIds,
          planId: res.planId,
          parentPlanId: res.parentPlanId,
          sellingPrices: res.sellingPrices,
          account: res.account,
          snapshotMetadata: prof.snapshotMetadata,
          planBank: res.planBank,
          planFreeTransfers: res.planFreeTransfers,
        });
      } else {
        if (prof.snapshotMetadata) {
          setSnapshotMeta(prof.snapshotMetadata);
          setSeasonModeManagerAccountId(prof.snapshotMetadata.managerAccountId);
          setSeasonModeSeason(prof.snapshotMetadata.snapshotSeason);
        }
        setFplAccount(res.account);
        setActivePlanId(res.planId || null);
        setActivePlanParentId(res.parentPlanId || null);
        setOfficialSellingPrices(res.sellingPrices);
        setManager({ bank: res.planBank ?? res.account.bank, freeTransfers: res.planFreeTransfers });
        if (res.account.managerName) {
          setUserName(res.account.managerName);
        }
        if (hydratedIds.length) {
          setSelectedIds(hydratedIds);
          setHadSavedSquad(true);
        }
        setSquadChallenge(null);
        setStagedSignalReviews({});
        setLockedIds([]);
      }

      setToast({
        message: res.notice || `FPL Account Synced: ${res.account.teamName} (${res.account.totalPoints} pts, GW${res.account.currentGameweek}: ${res.account.gameweekPoints} pts)`,
      });
      setImportModalOpen(false);
      setTeamInput("");
      setTeamMessage("");
    } catch (error) {
      setTeamMessage(error instanceof Error ? error.message : "Could not sync FPL account. Please check the Team ID or build your squad manually.");
    } finally {
      setSyncingAccount(false);
      setImporting(false);
    }
  };

  const doImport = () => syncAccount();

  const unlinkAccount = async () => {
    if (!(await deleteUserProfile())) {
      setToast({ message: "The FPL account could not be unlinked." });
      return;
    }
    setFplAccount(null);
    setActivePlanId(null);
    setActivePlanParentId(null);
    setOfficialSellingPrices({});
    setSnapshotMeta(null);
    setSeasonModeManagerAccountId(null);
    setSeasonModeSeason(null);
    setSelectedIds([]);
    setLockedIds([]);
    setHadSavedSquad(false);
    setImportModalOpen(false);
    setToast({ message: "Season FPL account unlinked." });
  };
  useEffect(() => {
    let active = true;
    const refresh = () => fetchSystemStatus().then((status) => { if (active) setSystemStatus(status); });
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const handleOnboardingImport = async (teamIdStr: string) => {
    const idNum = parseTeamId(teamIdStr);
    if (!idNum) {
      return { success: false, error: "Please enter a numeric Team ID or official FPL URL." };
    }
    try {
      const res = await fetchFplAccount(idNum, currentGameweek || 1);
      const prof = await getUserProfile();
      const hydratedIds = res.selectedIds.filter((id) => catalog.some((x) => x.id === id));
      const hasOfficialSquad = Boolean(prof.snapshotMetadata?.officialSnapshotId && prof.snapshotMetadata?.officialPlayerCount === 15);
      const isDraftDirty = editing || computeDraftPlayerFingerprint(selectedIds) !== computeDraftPlayerFingerprint(storedDraftIds);
      const transition = evaluateModeTransition({
        currentMode: planningMode === "SEASON" ? "SEASON" : "DRAFT",
        hasOfficialSquad,
        isEditorDirty: isDraftDirty,
      });

      if (transition.requiresPrompt) {
        setPendingOfficialTransition({
          squadIds: hydratedIds,
          planId: res.planId,
          parentPlanId: res.parentPlanId,
          sellingPrices: res.sellingPrices,
          account: res.account,
          snapshotMetadata: prof.snapshotMetadata,
          planBank: res.planBank,
          planFreeTransfers: res.planFreeTransfers,
        });
      } else {
        if (prof.snapshotMetadata) {
          setSnapshotMeta(prof.snapshotMetadata);
          setSeasonModeManagerAccountId(prof.snapshotMetadata.managerAccountId);
          setSeasonModeSeason(prof.snapshotMetadata.snapshotSeason);
        }
        setFplAccount(res.account);
        setActivePlanId(res.planId || null);
        setActivePlanParentId(res.parentPlanId || null);
        setOfficialSellingPrices(res.sellingPrices);
        setManager({ bank: res.planBank ?? res.account.bank, freeTransfers: res.planFreeTransfers });
        if (hydratedIds.length) {
          setSelectedIds(hydratedIds);
          setHadSavedSquad(true);
        }
        setSquadChallenge(null);
        setStagedSignalReviews({});
        setLockedIds([]);
      }
      return { success: true, managerName: res.account.managerName, notice: res.notice };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Could not find FPL account with that ID." };
    }
  };

  const handleOnboardingComplete = (data: { managerName: string; apiKey?: string; provider?: string }) => {
    setUserName(data.managerName);
    void saveUserPreferences({ userName: data.managerName, onboardingCompleted: true });
    setOnboardingModalOpen(false);
    setToast({ message: `Welcome to Insomnia FPL, ${data.managerName}!` });
  };

  const handleOnboardingSkip = () => {
    void saveUserPreferences({ onboardingCompleted: true });
    setOnboardingModalOpen(false);
    setToast({ message: "Welcome! Exploring with demo squad." });
  };

  if (catalogMode === "loading") return <LoadingScreen />;
  const syncText =
    catalogMode === "live"
      ? capturedAt
        ? `Updated ${new Date(capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : "Live data ready"
        : catalogMode === "demo-conflict"
        ? "Saved squad needs review"
        : catalogMode === "demo-live"
          ? "Demo squad (explicit)"
        : "Database offline (0 players)";
  return (
    <div className="app">
      {systemStatus?.isSeeding && (
        <div className="seeding-banner">
          <Sparkles size={14} /> Initial live Premier League data is currently seeding in the background...
        </div>
      )}
      <aside className="app-sidebar">
        <div className="brand">
          <div className="brand-mark">⚽</div>
          <div>
            <b>INSOMNIA FPL</b>
            <small>Team planner</small>
          </div>
        </div>
        {fplAccount && (
          <div className="patch-sidebar-compact">
            <div className="patch-sidebar-top">
              <span className="patch-sidebar-name" title={fplAccount.teamName}>
                ⚽ {fplAccount.teamName}
              </span>
              <button
                className="ghost-btn icon-only"
                style={{ padding: "2px 6px", fontSize: "11px" }}
                onClick={() => syncAccount()}
                disabled={syncingAccount}
                title="Sync FPL Account"
              >
                <span className={syncingAccount ? "spin" : ""}>↻</span>
              </button>
            </div>
            <div className="patch-sidebar-stats">
              <div className="patch-sidebar-stat-item">
                <small>Total</small>
                <b>{fplAccount.totalPoints} pts</b>
              </div>
              <div className="patch-sidebar-stat-item">
                <small>GW{fplAccount.currentGameweek}</small>
                <b>{fplAccount.gameweekPoints} pts</b>
              </div>
            </div>
          </div>
        )}
        <nav aria-label="Primary navigation">
          {Object.entries(icons).map(([label, Icon]) => (
            <button
              aria-label={label}
              className={tab === label ? "active" : ""}
              onClick={() => setTab(label)}
              key={label}
            >
              <Icon size={17} />
              <span className="nav-label">{label}</span>
              {label === "Transfers" && topTransfers.length > 0 && (
                <span className="nav-badge">{topTransfers.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="aside-bottom">
          <div className="status-dot" />
          <span>{syncText}</span>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <div className={`planning-mode-badge ${planningMode === "LOADING" ? "loading-mode" : draftMode ? "draft-mode" : "season-mode"}`}>
              <span className="badge-pill">
                {planningMode === "LOADING"
                  ? "LOADING METADATA..."
                  : draftMode
                    ? "GW1 DRAFT MODE"
                    : "LIVE SEASON MODE"}
              </span>
              <span className="badge-text">
                {planningMode === "LOADING"
                  ? "Fetching server configuration and snapshot metadata."
                  : draftMode
                    ? "Build and test your initial team. Changes are not submitted to FPL."
                    : "Planning from your imported official FPL squad."}
              </span>
            </div>
            <p className="eyebrow">
              GAMEWEEK {currentGameweek ?? 1} <span>·</span>{" "}
              {formatDeadlineText(deadlineTime)}
            </p>
            <h1>{tab === "My Team" ? getGreeting(userName) : tab}</h1>
            <p className="muted">
              {tab === "Admin"
                ? "Run and audit data maintenance tasks from one place."
                : tab === "My Team"
                ? draftMode
                  ? draftPlan
                    ? "A coordinated GW1 restructure improves this draft."
                    : "Your locked-core draft is optimised within the £100m cap."
                  : decision.roll
                    ? "Your current plan looks strong. Rolling is the best move."
                    : "One move leads your plan this week."
                : draftMode
                  ? "Build freely before the GW1 deadline; no transfer hits apply."
                  : "Plan with projections, then make the final change on the official FPL site."}
            </p>
          </div>
          <button
            className="avatar"
            aria-label="Change profile name"
            title="Change your name"
            onClick={() => {
              const n = prompt("Enter your name:", userName);
              if (n && n.trim()) {
                setUserName(n.trim());
                void saveUserPreferences({ userName: n.trim() });
              }
            }}
          >
            {getInitials(userName)}
          </button>
        </header>
        {transitionNotice && (
          <div className="transition-banner-card">
            <span>{transitionNotice}</span>
            <button className="ghost-btn" onClick={() => setTransitionNotice(null)}>
              Dismiss
            </button>
          </div>
        )}
        {pendingOfficialTransition && (
          <div className="transition-banner-card dirty-prompt">
            <div>
              <b>Official team detected</b> — finish or discard your edits to enter Live Season Mode.
            </div>
            <div className="transition-banner-actions">
              <button
                className="dark-btn"
                onClick={() => {
                  const trans = pendingOfficialTransition;
                  if (!trans) return;
                  if (trans.snapshotMetadata) setSnapshotMeta(trans.snapshotMetadata);
                  if (trans.account) setFplAccount(trans.account);
                  const activeAccId = trans.account?.managerAccountId || trans.account?.id || trans.snapshotMetadata?.managerAccountId || null;
                  setSeasonModeManagerAccountId(activeAccId);
                  setSeasonModeSeason(currentSeason);
                  void saveUserPreferences({ seasonModeManagerAccountId: activeAccId, seasonModeSeason: currentSeason });
                  if (trans.planId) setActivePlanId(trans.planId);
                  if (trans.parentPlanId) setActivePlanParentId(trans.parentPlanId);
                  if (trans.sellingPrices) setOfficialSellingPrices(trans.sellingPrices);
                  if (trans.planBank != null || trans.account?.bank != null) {
                    setManager({ bank: trans.planBank ?? trans.account?.bank ?? 0, freeTransfers: trans.planFreeTransfers ?? 1 });
                  }
                  setSelectedIds(trans.squadIds);
                  setLockedIds([]);
                  setSquadChallenge(null);
                  setStagedSignalReviews({});
                  setEditing(false);
                  setPendingOfficialTransition(null);
                  setTransitionNotice(`Live Season Mode Activated — Official squad imported for Season ${currentSeason}.`);
                }}
              >
                Switch to Live Season Mode (Discard Edits)
              </button>
              <button
                className="ghost-btn"
                onClick={() => setPendingOfficialTransition(null)}
              >
                Keep Editing GW1 Draft
              </button>
            </div>
          </div>
        )}
        <ForecastReadinessPanel system={systemStatus} forecast={forecastSummary} requestedHorizon={horizon} />
        {catalogMode === "demo-conflict" && (
          <div className="validation-warning conflict-banner">
            <Shield size={16} />
            <span>
              <b>
                Your saved squad does not match the latest player catalogue.
              </b>{" "}
              It has not been replaced. Continue with the saved demo snapshot or
              start a reviewed live squad.
            </span>
            <button onClick={repairLiveSquad}>Create live starter squad</button>
          </div>
        )}

        {catalogMode === "demo-offline" && catalog.length === 0 && (
          <div className="validation-warning conflict-banner">
            <Shield size={16} />
            <span>
              <b>Database unavailable:</b> Could not reach player database. No
              players are currently loaded.
            </span>
          </div>
        )}
        {(tab === "My Team" || tab === "Transfers") && (
          <FplAccountPatch
            account={fplAccount}
            onSync={() => syncAccount()}
            isSyncing={syncingAccount}
            onChangeAccount={() => {
              setTeamMessage("");
              setImportModalOpen(true);
            }}
          />
        )}
        {tab !== "Ask" && tab !== "Model Debug" && tab !== "Leagues" && tab !== "Signals" && tab !== "Admin" && (
          <>
            <PlanControls
              horizon={horizon}
              setHorizon={setHorizon}
              manager={manager}
              draftMode={draftMode}
              derivedBank={effectiveBank}
              onSettings={() => setSettingsOpen(true)}
              onImport={() => {
                setTeamMessage("");
                setImportModalOpen(true);
              }}
              onEdit={() => {
                setInitialClear(false);
                setEditing(true);
              }}
              onExport={() => setExportModalOpen(true)}
            />
            {(tab === "My Team" || tab === "Transfers") && (
              <ChipPlannerBar
                chips={chipImpacts}
                activeChip={activeChip}
                onSelectChip={setActiveChip}
              />
            )}
          </>
        )}
        {tab === "Admin" ? (
          <AdminView />
        ) : tab === "Players" ? (
          <PlayersV2
            filtered={filteredPlayers}
            query={playerQuery}
            setQuery={setPlayerQuery}
            filter={playerFilter}
            setFilter={setPlayerFilter}
            horizon={horizon}
            ownedIds={selectedIds}
            onSelect={setPlayerDetail}
            comparison={comparison}
            onClearComparison={() => setComparison(null)}
            affordableLimit={affordableLimit}
          />
        ) : tab === "Ask" ? (
          <AskV2
            question={question}
            setQuestion={setQuestion}
            onSubmitQuestion={(q) => {
              setSubmittedQuestion(q);
              setAnalysisNonce((n) => n + 1);
            }}
            answer={answer}
            review={review}
            llmAnswer={llmAnswer}
            llmProvider={llmProvider}
            llmError={llmError}
            llmLoading={llmLoading}
            onOpenAiConfig={() => setAiModalOpen(true)}
            catalog={catalog}
            squad={squad}
            horizon={horizon}
            onSelectPlayer={setPlayerDetail}
            onApplyTransfer={requestTransfer}
          />
        ) : tab === "Model Debug" ? (
          <ModelDebug horizon={horizon} />
        ) : tab === "My Team" ? (
          <MyTeamV2
            squad={squad}
            xi={xi}
            horizon={horizon}
            captain={captain}
            bank={effectiveBank}
            onEdit={() => {
              setInitialClear(false);
              setEditing(true);
            }}
            onSelectPlayer={setPlayerDetail}
            challenge={squadChallenge}
            challengeLoading={challengeLoading}
            challengeError={challengeError}
            challengeRawOutput={challengeRawOutput}
            challengeOutputTypes={challengeOutputTypes}
            onChallenge={runSquadChallenge}
            onReviewSignal={reviewSquadSignal}
            stagedSignalReviews={stagedSignalReviews}
            onUnstageSignal={unstageSignalReview}
            onManualOverride={handleManualOverride}
            weakest={weakest}
            decision={decision}
            freeTransfers={manager.freeTransfers}
            draftMode={draftMode}
            draftPlan={draftPlan}
            legalBundles={legalBundles}
            onApplyDraft={applyDraftPlan}
            onApplyBundle={applyDraftBundle}
            onWhy={setExplanationTransfer}
            setTab={(t) => {
              setTab(t);
              if (t !== "Transfers") setTargetSwapPlayer(null);
            }}
            onReplacePlayer={(p) => {
              setTargetSwapPlayer(p);
              setTab("Transfers");
            }}
          />
        ) : tab === "Leagues" ? (
          <LeaguesView
            fplAccount={fplAccount}
            currentGameweek={currentGameweek ?? 1}
            catalog={catalog}
            userSquad={squad}
            onSyncAccount={(id) => syncAccount(id)}
          />
        ) : tab === "Review" ? (
          <ReviewView />
        ) : tab === "Signals" ? (
          <SignalsTab
            catalog={catalog}
            currentGameweek={currentGameweek ?? 1}
            onSelectPlayer={setPlayerDetail}
            onReviewSignal={reviewSquadSignal}
            stagedSignalReviews={stagedSignalReviews}
            onUnstageSignal={unstageSignalReview}
            onApplyBatch={applyBatchReview}
            applyingBatch={applyingBatch}
          />
        ) : tab === "Transfers" ? (
          <TransfersV2
            data={topTransfers}
            horizon={horizon}
            onWhy={setExplanationTransfer}
            onApply={requestTransfer}
            manager={manager}
            targetSwapPlayer={targetSwapPlayer}
            onClearTargetSwapPlayer={() => setTargetSwapPlayer(null)}
            squad={squad}
            catalog={catalog}
            effectiveBank={effectiveBank}
            canonicalRecommendation={canonicalRecommendation}
            canonicalLoading={canonicalRecommendationLoading}
            onGenerateCanonical={generateCanonicalRecommendation}
            onApplyCanonical={applyCanonicalCandidate}
            onDismissCanonical={dismissCanonicalCandidate}
          />
        ) : null}
      </main>
      {toast && (
        <div className="swap-toast-banner global-swap-toast" role="status">
          <span>{toast.message}</span>
          {toast.undo && <button onClick={undoTransfer}>Undo</button>}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            ×
          </button>
        </div>
      )}
      {Object.keys(stagedSignalReviews).length > 0 && (
        <div className="staged-review-bar" role="status" aria-live="polite">
          <div className="staged-review-info">
            <span className="staged-review-badge">{Object.keys(stagedSignalReviews).length}</span>
            <span>
              {Object.keys(stagedSignalReviews).length === 1 ? "review" : "reviews"} staged
              {" · "}
              <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: "13px" }}>model not yet updated</span>
            </span>
          </div>
          <div className="staged-review-actions">
            <button
              className="ghost-btn"
              disabled={applyingBatch}
              onClick={() => setStagedSignalReviews({})}
            >
              Discard
            </button>
            <button
              className="apply-staged-btn"
              disabled={applyingBatch}
              onClick={applyBatchReview}
            >
              {applyingBatch ? "Applying…" : "Apply Changes & Refresh Projections"}
            </button>
          </div>
        </div>
      )}
      {editing && (
        <SquadEditor
          catalog={catalog}
          selectedIds={selectedIds}
          lockedIds={lockedIds}
          horizon={horizon}
          initialClear={initialClear}
          bank={manager.bank}
          draftMode={draftMode}
          onSave={saveSquad}
          onClose={() => setEditing(false)}
        />
      )}{" "}
      {importModalOpen && (
        <ImportModal
          value={teamInput}
          setValue={setTeamInput}
          onImport={doImport}
          message={teamMessage}
          loading={importing}
          account={fplAccount}
          onUnlink={unlinkAccount}
          onClose={() => {
            setImportModalOpen(false);
            setTeamMessage("");
          }}
        />
      )}
      {settingsOpen && (
        <ManagerSettingsModal
          value={manager}
          onSave={saveManager}
          onClose={() => setSettingsOpen(false)}
          onReopenOnboarding={() => {
            setSettingsOpen(false);
            setOnboardingModalOpen(true);
          }}
        />
      )}
      {onboardingModalOpen && (
        <OnboardingWizardModal
          onComplete={handleOnboardingComplete}
          onSkip={handleOnboardingSkip}
          onImportTeam={handleOnboardingImport}
        />
      )}
      {exportModalOpen && (
        <ExportModal
          text={exportText}
          onClose={() => {
            setExportModalOpen(false);
            setCopiedExport(false);
          }}
          onCopy={() => {
            navigator.clipboard.writeText(exportText);
            setCopiedExport(true);
            setTimeout(() => setCopiedExport(false), 2500);
          }}
          copied={copiedExport}
        />
      )}{" "}
      {explanationTransfer && (
        <WhyDrawer
          transfer={explanationTransfer}
          review={explanationReview}
          horizon={horizon}
          onClose={() => setExplanationTransfer(null)}
          onCompare={() => compareTransfer(explanationTransfer)}
          onApplyTransfer={requestTransfer}
        />
      )}{" "}
      {pendingTransfer && (
        <TransferConfirmModal
          transfer={pendingTransfer}
          horizon={horizon}
          bank={effectiveBank}
          freeTransfers={draftMode ? 5 : manager.freeTransfers}
          onConfirm={confirmTransfer}
          onClose={() => setPendingTransfer(null)}
        />
      )}{" "}
      {playerDetail && (
        <PlayerDrawer
          player={playerDetail}
          horizon={horizon}
          bank={effectiveBank}
          squad={squad}
          catalog={catalog}
          onClose={() => setPlayerDetail(null)}
          onAsk={(p) => {
            setPlayerDetail(null);
            const q = `Tell me about ${p.name}`;
            setQuestion(q);
            setSubmittedQuestion(q);
            setTab("Ask");
          }}
          onReviewTransfer={(t) => {
            setPlayerDetail(null);
            setExplanationTransfer(t);
          }}
        />
      )}{" "}
      {aiModalOpen && (
        <AiKeyModal
          apiKey={apiKey}
          setApiKey={setApiKey}
          provider={aiProvider}
          setProvider={setAiProvider}
          fplAccount={fplAccount}
          setFplAccount={setFplAccount}
          selectedIds={selectedIds}
          onClose={() => setAiModalOpen(false)}
        />
      )}
    </div>
  );
}
function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div className="brand-mark">⚽</div>
      <div>
        <p className="eyebrow">INSOMNIA FPL</p>
        <h1>Preparing your latest plan…</h1>
        <p className="muted">
          Loading the player catalogue before showing recommendations.
        </p>
      </div>
      <div className="loading-skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function PlanControls({
  horizon,
  setHorizon,
  manager,
  draftMode = activeDraftMode,
  derivedBank = activeManagerSettings.bank,
  onSettings,
  onImport,
  onEdit,
  onExport,
}: {
  horizon: number;
  setHorizon: (n: 1 | 3 | 5) => void;
  manager: ManagerSettings;
  draftMode?: boolean;
  derivedBank?: number;
  onSettings: () => void;
  onImport: () => void;
  onEdit: () => void;
  onExport?: () => void;
}) {
  const [pendingHorizon, setPendingHorizon] = useState<number | null>(null);

  useEffect(() => {
    if (pendingHorizon === horizon) {
      setPendingHorizon(null);
    }
  }, [horizon, pendingHorizon]);

  const handleSelect = (n: 1 | 3 | 5) => {
    if (n === horizon || pendingHorizon !== null) return;
    setPendingHorizon(n);
    setTimeout(() => {
      setHorizon(n);
    }, 20);
  };

  return (
    <div className="horizon-row plan-controls">
      <div className="control-group">
        <span className="muted">Horizon</span>
        <div className="segmented">
          {[1, 3, 5].map((n) => {
            const isPendingThis = pendingHorizon === n;
            const isSelected = horizon === n;
            return (
              <button
                aria-pressed={horizon === n}
                disabled={pendingHorizon !== null}
                onClick={() => handleSelect(n as 1 | 3 | 5)}
                className={`${isSelected ? "selected" : ""} ${
                  isPendingThis ? "loading" : ""
                }`}
                key={n}
              >
                {isPendingThis && (
                  <span className="horizon-button-spinner" aria-hidden="true" />
                )}
                <span>{n === 1 ? "1 GW" : `${n} GWs`}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="manager-assumptions">
        {draftMode ? (
          <>
            <div className="assumption-chip">
              <span>GW1 budget</span>
              <b>£100.0m</b>
            </div>
            <div className="assumption-chip">
              <span>Derived bank</span>
              <b>£{derivedBank.toFixed(1)}m</b>
            </div>
          </>
        ) : (
          <>
            <button className="assumption-chip" onClick={onSettings}>
              <span>Bank</span>
              <b>£{manager.bank.toFixed(1)}m</b>
            </button>
            <button className="assumption-chip" onClick={onSettings}>
              <span>Free transfers</span>
              <b>{manager.freeTransfers}</b>
            </button>
          </>
        )}
      </div>
      <div className="plan-actions">
        <button className="ghost-btn" onClick={onImport}>
          Import squad <ChevronDown size={14} />
        </button>
        <button className="ghost-btn" onClick={onEdit}>
          Edit planned squad
        </button>
        {onExport && (
          <button className="ghost-btn" onClick={onExport}>
            Export plan
          </button>
        )}
      </div>
    </div>
  );
}

function ChipPlannerBar({
  chips,
  activeChip,
  onSelectChip,
}: {
  chips: ChipImpact[];
  activeChip: ChipType;
  onSelectChip: (c: ChipType) => void;
}) {
  return (
    <div className="chip-planner-bar">
      <span className="chip-planner-title">⚡ Chip Planner</span>
      <div className="chip-options">
        {chips.map((item) => {
          const isActive = activeChip === item.chip;
          return (
            <button
              key={item.chip}
              className={`chip-btn ${isActive ? "active" : ""}`}
              onClick={() => onSelectChip(isActive ? null : item.chip)}
              title={`${item.description} - ${item.notes}`}
            >
              <span>{item.name}</span>
              {item.projectedGain === null ? <span className="chip-gain-tag">Unavailable</span> : <span className="chip-gain-tag">+{item.projectedGain} xPts</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ExportModal({
  text,
  onClose,
  onCopy,
  copied,
}: {
  text: string;
  onClose: () => void;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="export-modal-backdrop" onClick={onClose}>
      <div className="export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="export-modal-header">
          <span className="export-modal-title">⚡ Export Squad & Plan</span>
          <button className="ghost-btn" onClick={onClose}>✕</button>
        </div>
        <textarea className="export-textarea" readOnly value={text} />
        <div className="export-actions">
          <button className="ghost-btn" onClick={onClose}>Close</button>
          <button className="primary-btn" onClick={onCopy}>
            {copied ? "✓ Copied to Clipboard!" : "Copy Summary"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ManagerSettingsModal({
  value,
  onSave,
  onClose,
  onReopenOnboarding,
}: {
  value: ManagerSettings;
  onSave: (v: ManagerSettings) => void;
  onClose: () => void;
  onReopenOnboarding?: () => void;
}) {
  const [bank, setBank] = useState(String(value.bank));
  const [freeTransfers, setFreeTransfers] = useState(
    String(value.freeTransfers),
  );
  const parsedBank = Math.max(0, Math.min(20, Number(bank) || 0));
  const parsedTransfers = Math.max(
    0,
    Math.min(5, Math.round(Number(freeTransfers) || 0)),
  );
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">PLAN ASSUMPTIONS</p>
            <h2 id="settings-title">Your manager details</h2>
            <p className="muted">
              Public squad imports cannot read these private values. Keep them
              current so affordability and hit costs are accurate.
            </p>
          </div>
          <button
            onClick={onClose}
            className="close"
            aria-label="Close manager details"
          >
            ×
          </button>
        </div>
        <div className="settings-grid">
          <label>
            Money in the bank{" "}
            <span className="input-with-unit">
              <input
                inputMode="decimal"
                value={bank}
                onChange={(e) => setBank(e.target.value)}
              />
              <b>£m</b>
            </span>
          </label>
          <label>
            Free transfers available{" "}
            <input
              inputMode="numeric"
              value={freeTransfers}
              onChange={(e) => setFreeTransfers(e.target.value)}
            />
          </label>
        </div>
        <p className="import-note">
          <Shield size={14} /> Recommendations use these values only for your
          local plan. Insomnia FPL never changes your official team.
        </p>
        <div className="modal-foot">
          {onReopenOnboarding && (
            <button
              className="ghost-btn"
              onClick={onReopenOnboarding}
              style={{ marginRight: "auto" }}
              type="button"
            >
              ✨ Setup Guide
            </button>
          )}
          <button className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="dark-btn"
            onClick={() =>
              onSave({ bank: parsedBank, freeTransfers: parsedTransfers })
            }
          >
            Save details
          </button>
        </div>
      </div>
    </div>
  );
}

function OnboardingWizardModal({
  onComplete,
  onSkip,
  onImportTeam,
}: {
  onComplete: (data: { managerName: string; apiKey?: string; provider?: string }) => void;
  onSkip: () => void;
  onImportTeam: (teamIdStr: string) => Promise<{ success: boolean; managerName?: string; error?: string; notice?: string }>;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [teamInput, setTeamInput] = useState("");
  const [managerName, setManagerName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState("openai");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [syncNotice, setSyncNotice] = useState("");

  const handleImport = async () => {
    if (!teamInput.trim()) {
      setErrorMsg("Please enter an FPL Team ID or team URL.");
      return;
    }
    setLoading(true);
    setErrorMsg("");
    setSyncNotice("");
    const res = await onImportTeam(teamInput);
    setLoading(false);
    if (res.success) {
      if (res.managerName && !managerName) {
        setManagerName(res.managerName);
      }
      setSyncNotice(res.notice || "");
      setStep(2);
    } else {
      setErrorMsg(res.error || "Could not fetch FPL team. Verify your Team ID.");
    }
  };

  const handleFinish = () => {
    onComplete({
      managerName: managerName.trim() || "Alex",
      apiKey: apiKey.trim() || undefined,
      provider,
    });
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className="onboarding-header">
          <div className="onboarding-badge">
            <Sparkles size={14} /> WELCOME TO INSOMNIA FPL
          </div>
          <h2 id="onboarding-title">
            {step === 1 ? "Sync Your FPL Squad" : "Customize Your Experience"}
          </h2>
          <p className="muted">
            {step === 1
              ? "Import your official 15-man squad to unlock personalized transfer recommendations, fixture difficulty, and captaincy advice."
              : "Set your preferred manager name and optional AI credentials for web-search squad research."}
          </p>
          <div className="onboarding-steps-indicator">
            <span className={`step-dot ${step === 1 ? "active" : "done"}`}>1. Squad Sync</span>
            <span className="step-line" />
            <span className={`step-dot ${step === 2 ? "active" : ""}`}>2. Settings & AI</span>
          </div>
        </div>

        {step === 1 ? (
          <div className="onboarding-body">
            <label className="onboarding-field">
              <span>FPL Team ID or URL</span>
              <input
                type="text"
                placeholder="e.g. 123456 or https://fantasy.premierleague.com/entry/123456/..."
                value={teamInput}
                onChange={(e) => {
                  setTeamInput(e.target.value);
                  setErrorMsg("");
                }}
                onKeyDown={(e) => e.key === "Enter" && handleImport()}
                disabled={loading}
              />
            </label>
            {errorMsg && <p className="onboarding-error">{errorMsg}</p>}
            <div className="onboarding-tip">
              <Shield size={14} /> <strong>Private & Safe:</strong> Insomnia FPL reads public league data only and never alters your official squad.
            </div>
            <div className="modal-foot onboarding-actions">
              <button className="ghost-btn" onClick={onSkip} type="button">
                Skip & Explore Demo Squad
              </button>

              <button className="dark-btn" onClick={handleImport} disabled={loading} type="button">
                {loading ? "Syncing..." : "Sync Squad →"}
              </button>
            </div>
          </div>
        ) : (
          <div className="onboarding-body">
            {syncNotice && <p className="onboarding-notice">{syncNotice}</p>}
            <div className="settings-grid">
              <label>
                Manager Name
                <input
                  type="text"
                  placeholder="e.g. Alex"
                  value={managerName}
                  onChange={(e) => setManagerName(e.target.value)}
                />
              </label>

              <label>
                LLM Provider (Optional)
                <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="openai">OpenAI (GPT-4o)</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="anthropic">Anthropic Claude</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="ollama">Local Ollama</option>
                </select>
              </label>

              <label style={{ gridColumn: "1 / -1" }}>
                AI API Key (Optional)
                <input
                  type="password"
                  placeholder="sk-... or AIzaSy..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <span className="field-subtext">
                  Enables web-search squad risk challenges and natural language explanations. Deterministic math engine works automatically without a key.
                </span>
              </label>
            </div>

            <div className="onboarding-features-summary">
              <div className="feature-chip">⚡ Grounded Projections</div>
              <div className="feature-chip">🛡️ Legal Transfer Validation</div>
              <div className="feature-chip">✦ Skeptic Squad Challenge</div>
            </div>

            <div className="modal-foot onboarding-actions">
              <button className="ghost-btn" onClick={() => setStep(1)} type="button">
                ← Back
              </button>
              <button className="dark-btn" onClick={handleFinish} type="button">
                Get Started →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TransferConfirmModal({
  transfer,
  horizon,
  bank,
  freeTransfers,
  onConfirm,
  onClose,
}: {
  transfer: Transfer;
  horizon: number;
  bank: number;
  freeTransfers: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const bankAfter = bank - transfer.priceDelta;
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal confirm-transfer-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-transfer-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">UPDATE YOUR PLAN</p>
            <h2 id="confirm-transfer-title">
              Save {transfer.out.name} → {transfer.in.name}?
            </h2>
            <p className="muted">
              Review the impact before changing your locally saved squad.
            </p>
          </div>
          <button
            onClick={onClose}
            className="close"
            aria-label="Close transfer confirmation"
          >
            ×
          </button>
        </div>
        <div className="confirm-transfer-players">
          <div>
            <span className="red-tag">OUT</span>
            <b>{transfer.out.name}</b>
            <small>
              {transfer.out.club} · £{transfer.out.price.toFixed(1)}m ·{" "}
              {horizonProjection(transfer.out, horizon).toFixed(1)} pts
            </small>
          </div>
          <ArrowRight size={22} />
          <div>
            <span className="green-tag">IN</span>
            <b>{transfer.in.name}</b>
            <small>
              {transfer.in.club} · £{transfer.in.price.toFixed(1)}m ·{" "}
              {horizonProjection(transfer.in, horizon).toFixed(1)} pts
            </small>
          </div>
        </div>
        <div className="confirm-impact-grid">
          <span>
            <small>Projected gain</small>
            <b className="positive">+{transfer.net.toFixed(1)} pts</b>
          </span>
          <span>
            <small>Bank after</small>
            <b>£{bankAfter.toFixed(1)}m</b>
          </span>
          <span>
            <small>Transfer cost</small>
            <b>{freeTransfers > 0 ? "Free" : "-4 point hit"}</b>
          </span>
        </div>
        <div className="official-team-note">
          <Shield size={16} />
          <span>
            <b>This updates your Insomnia FPL plan only.</b> You still need to make
            the transfer on the official FPL site.
          </span>
        </div>
        <div className="modal-foot">
          <button className="ghost-btn" onClick={onClose}>
            Keep current plan
          </button>
          <button className="dark-btn" onClick={onConfirm}>
            Update planned squad
          </button>
        </div>
      </div>
    </div>
  );
}

function Dashboard({
  squad,
  xi,
  horizon,
  weakest,
  setTab,
  onEdit,
  decision,
}: {
  squad: Player[];
  xi: Player[];
  horizon: number;
  weakest: any;
  setTab: (s: string) => void;
  onEdit: () => void;
  decision: any;
}) {
  const starters = new Set(xi.map((p) => p.id));
  const captain = [...xi].sort((a, b) => b.projection - a.projection)[0];
  const vice = [...xi].sort((a, b) => b.projection - a.projection)[1];
  const issues = validateSquad(squad, 1.2);
  return (
    <div className="content">
      <section className="hero-grid">
        <div className="hero-card">
          <div className="card-top">
            <span className="label">PROJECTED TEAM SCORE</span>
            <span className="pill green">
              <Zap size={13} /> +6.2 vs last week
            </span>
          </div>
          <div className="big-number">
            {xi.reduce((sum, p) => sum + p.projection, 0).toFixed(1)}{" "}
            <small>pts</small>
          </div>
          <div className="score-bars">
            <span style={{ width: "74%" }} />
            <span style={{ width: "52%" }} />
            <span style={{ width: "35%" }} />
          </div>
          <div className="bar-labels">
            <span>
              Attack <b>28.8</b>
            </span>
            <span>
              Midfield <b>24.5</b>
            </span>
            <span>
              Defence <b>11.7</b>
            </span>
          </div>
        </div>
        <div className="recommend-card">
          <div className="card-top">
            <span className="label">TOP RECOMMENDATION</span>
            <span className={"pill " + (decision.roll ? "green" : "amber")}>
              {decision.roll ? "ROLL TRANSFER" : "UPGRADE OPPORTUNITY"}
            </span>
          </div>
          {weakest ? (
            <div className="rec-transfer">
              <div>
                <strong>{weakest.out.name}</strong>
                <small>SELL · £{weakest.out.price.toFixed(1)}m</small>
              </div>
              <ArrowRight size={18} />
              <div>
                <strong>{weakest.in.name}</strong>
                <small>BUY · £{weakest.in.price.toFixed(1)}m</small>
              </div>
            </div>
          ) : (
            <div className="rec-transfer">
              <strong>Keep your transfer</strong>
            </div>
          )}
          <div className="rec-foot">
            <b>{decision.roll ? "ROLL" : `+${weakest?.net}`}</b>{" "}
            {decision.reason}{" "}
            <button onClick={() => setTab("Transfers")}>
              See why <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </section>
      {issues.length > 0 && (
        <div className="validation-warning">
          <Shield size={15} />
          <span>
            <b>Squad needs attention:</b> {issues[0].detail}
          </span>
          <button onClick={onEdit}>Fix squad</button>
        </div>
      )}
      <section className="main-grid">
        <div className="panel squad-panel">
          <div className="panel-head">
            <div>
              <h2>Best XI</h2>
              <p>Optimised for next gameweek</p>
            </div>
            <button className="text-btn" onClick={onEdit}>
              Edit team <ArrowRight size={14} />
            </button>
          </div>
          <div className="pitch">
            <div className="pitch-row">
              {xi
                .filter((p) => p.position === "GK")
                .map((p) => (
                  <PlayerChip p={p} horizon={horizon} key={p.id} />
                ))}
            </div>
            <div className="pitch-row">
              {xi
                .filter((p) => p.position === "DEF")
                .map((p) => (
                  <PlayerChip p={p} horizon={horizon} key={p.id} />
                ))}
            </div>
            <div className="pitch-row">
              {xi
                .filter((p) => p.position === "MID")
                .map((p) => (
                  <PlayerChip p={p} horizon={horizon} key={p.id} />
                ))}
            </div>
            <div className="pitch-row">
              {xi
                .filter((p) => p.position === "FWD")
                .map((p) => (
                  <PlayerChip p={p} horizon={horizon} key={p.id} />
                ))}
            </div>
          </div>
          <div className="bench">
            <span>BENCH ORDER</span>
            {benchOrder(horizon, squad, xi).map((p) => (
                <PlayerChip p={p} sub horizon={horizon} key={p.id} />
              ))}
          </div>
        </div>
        <div className="side-stack">
          <div className="panel captain-card">
            <div className="panel-head">
              <div>
                <h2>Captaincy</h2>
                <p>Next gameweek</p>
              </div>
              <Trophy className="gold" size={20} />
            </div>
            <div className="captain">
              <div className="captain-badge">C</div>
              <div>
                <b>{captain?.name}</b>
                <small>
                  Captain · {captain?.projection.toFixed(1)} base pts
                </small>
              </div>
              <span>2×</span>
            </div>
            <div className="captain vice">
              <div className="captain-badge">V</div>
              <div>
                <b>{vice?.name}</b>
                <small>
                  Vice-captain · {vice?.projection.toFixed(1)} base pts
                </small>
              </div>
            </div>
          </div>
          <div className="panel ask-card">
            <Sparkles size={18} className="sparkle" />
            <h2>Ask your squad</h2>
            <p>Get a grounded explanation for any decision.</p>
            <button onClick={() => setTab("Ask")} className="dark-btn">
              Ask Insomnia FPL <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function getSquadEditorLineup(squad: Player[], horizon: number): Player[] {
  const full = bestXI(horizon, squad);
  if (full.length === 11) return full;

  const gks = squad
    .filter((p) => p.position === "GK")
    .sort((a, b) => horizonProjection(b, horizon) - horizonProjection(a, horizon));
  const defs = squad
    .filter((p) => p.position === "DEF")
    .sort((a, b) => horizonProjection(b, horizon) - horizonProjection(a, horizon));
  const mids = squad
    .filter((p) => p.position === "MID")
    .sort((a, b) => horizonProjection(b, horizon) - horizonProjection(a, horizon));
  const fwds = squad
    .filter((p) => p.position === "FWD")
    .sort((a, b) => horizonProjection(b, horizon) - horizonProjection(a, horizon));

  const starters: Player[] = [];
  if (gks.length > 0) {
    starters.push(gks[0]);
  }

  const outfield = [...defs, ...mids, ...fwds].sort(
    (a, b) => horizonProjection(b, horizon) - horizonProjection(a, horizon)
  );

  let defCount = 0;
  let midCount = 0;
  let fwdCount = 0;
  let outfieldStarters = 0;

  for (const p of outfield) {
    if (outfieldStarters >= 10) break;
    if (p.position === "DEF" && defCount < 5) {
      starters.push(p);
      defCount++;
      outfieldStarters++;
    } else if (p.position === "MID" && midCount < 5) {
      starters.push(p);
      midCount++;
      outfieldStarters++;
    } else if (p.position === "FWD" && fwdCount < 3) {
      starters.push(p);
      fwdCount++;
      outfieldStarters++;
    }
  }

  return starters;
}

function SquadEditor({
  catalog,
  selectedIds,
  lockedIds: initialLockedIds = activeLockedIds,
  horizon = 1,
  initialClear = false,
  bank,
  draftMode = activeDraftMode,
  onSave,
  onClose,
}: {
  catalog: Player[];
  selectedIds: number[];
  lockedIds?: number[];
  horizon?: number;
  initialClear?: boolean;
  bank: number;
  draftMode?: boolean;
  onSave: (ids: number[], lockedIds?: number[]) => void;
  onClose: () => void;
}) {
  const [ids, setIds] = useState<number[]>(() =>
    initialClear ? [] : selectedIds,
  );
  const [editorLockedIds, setEditorLockedIds] = useState<number[]>(() =>
    initialClear
      ? []
      : initialLockedIds.filter((id) => selectedIds.includes(id)),
  );
  const [q, setQ] = useState("");
  const [posFilter, setPosFilter] = useState<string>("All");
  const [sortBy, setSortBy] = useState<
    "pts" | "price-desc" | "price-asc" | "name"
  >("pts");
  const [pendingIncoming, setPendingIncoming] = useState<Player | null>(null);

  const currentSquad = useMemo(
    () =>
      ids
        .map((id) => catalog.find((p) => p.id === id))
        .filter(Boolean) as Player[],
    [ids, catalog],
  );
  const issues = useMemo(
    () =>
      draftMode
        ? validateInitialSquad(currentSquad)
        : validateSquad(currentSquad, bank),
    [currentSquad, bank, draftMode],
  );
  const totalPrice = useMemo(
    () => currentSquad.reduce((sum, p) => sum + p.price, 0),
    [currentSquad],
  );

  const currentXI = useMemo(
    () => getSquadEditorLineup(currentSquad, horizon),
    [horizon, currentSquad],
  );

  const editorBench = useMemo(() => {
    const startersSet = new Set(currentXI.map((p) => p.id));
    const bench = currentSquad.filter((p) => !startersSet.has(p.id));
    const subGk = bench.find((p) => p.position === "GK");
    const subOutfield = bench
      .filter((p) => p.position !== "GK")
      .sort((a, b) => horizonProjection(b, horizon) - horizonProjection(a, horizon));
    return subGk ? [subGk, ...subOutfield] : subOutfield;
  }, [currentSquad, currentXI, horizon]);

  const projectedScore = useMemo(() => {
    if (currentXI.length === 0) return 0;
    const baseSum = currentXI.reduce(
      (sum, p) => sum + horizonProjection(p, horizon),
      0,
    );
    const capt = [...currentXI].sort(
      (a, b) => horizonProjection(b, horizon) - horizonProjection(a, horizon),
    )[0];
    return baseSum + (capt ? horizonProjection(capt, horizon) : 0);
  }, [currentXI, horizon]);

  const posCounts = useMemo(
    () => ({
      GK: currentSquad.filter((p) => p.position === "GK").length,
      DEF: currentSquad.filter((p) => p.position === "DEF").length,
      MID: currentSquad.filter((p) => p.position === "MID").length,
      FWD: currentSquad.filter((p) => p.position === "FWD").length,
    }),
    [currentSquad],
  );

  const filtered = useMemo(() => {
    const list = catalog.filter((p) => {
      const matches =
        p.name.toLowerCase().includes(q.toLowerCase()) ||
        p.club.toLowerCase().includes(q.toLowerCase());
      const posMatch =
        posFilter === "All" ||
        (posFilter === "Selected" && ids.includes(p.id)) ||
        p.position === posFilter;
      return matches && posMatch;
    });
    return list.sort((a, b) => {
      if (sortBy === "pts")
        return horizonProjection(b, horizon) - horizonProjection(a, horizon);
      if (sortBy === "price-desc") return b.price - a.price;
      if (sortBy === "price-asc") return a.price - b.price;
      return a.name.localeCompare(b.name);
    });
  }, [catalog, q, posFilter, ids, sortBy, horizon]);

  const toggle = (id: number) => {
    const player = catalog.find((p) => p.id === id);
    if (!player) return;
    if (ids.includes(id)) {
      setIds((x) => x.filter((i) => i !== id));
      setEditorLockedIds((x) => x.filter((i) => i !== id));
      return;
    }
    if (ids.length >= 15) {
      setPendingIncoming(player);
      return;
    }
    setIds((x) => [...x, id]);
  };
  const replacePlayer = (outId: number) => {
    if (!pendingIncoming) return;
    setIds((x) => x.map((id) => (id === outId ? pendingIncoming.id : id)));
    setEditorLockedIds((x) => x.filter((id) => id !== outId));
    setPendingIncoming(null);
  };
  const clearSquad = () => {
    setIds([]);
    setEditorLockedIds([]);
  };
  const toggleLock = (id: number) =>
    setEditorLockedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  const autoFillBest = () =>
    setIds(
      (draftMode
        ? optimizeInitialSquad(catalog, {
            lockedPlayerIds: editorLockedIds,
            horizon: horizon as 1 | 3 | 5,
            budget: INITIAL_SQUAD_BUDGET,
          })
        : buildLegalDefaultSquad(catalog, 100 + bank)
      ).map((p) => p.id),
    );
  const autoFillRemaining = () => {
    const preserve = [...new Set([...editorLockedIds, ...ids])];
    setEditorLockedIds(preserve);
    setIds(
      (draftMode
        ? optimizeInitialSquad(catalog, {
            lockedPlayerIds: preserve,
            horizon: horizon as 1 | 3 | 5,
            budget: INITIAL_SQUAD_BUDGET,
          })
        : buildLegalRemainingSquad(ids, catalog, horizon, 100 + bank)
      ).map((p) => p.id),
    );
  };

  const formationString = useMemo(() => {
    if (currentXI.length === 0) return "Empty";
    const defs = currentXI.filter((p) => p.position === "DEF").length;
    const mids = currentXI.filter((p) => p.position === "MID").length;
    const fwds = currentXI.filter((p) => p.position === "FWD").length;
    if (currentXI.length < 11) {
      return `${defs}-${mids}-${fwds} (${currentXI.length}/11 starters)`;
    }
    return `${defs}-${mids}-${fwds}`;
  }, [currentXI]);

  return (
    <div className="modal-backdrop">
      <div
        className="modal squad-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="squad-editor-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">PLANNED SQUAD</p>
            <h2 id="squad-editor-title">
              {initialClear
                ? "Build a new 15-player squad"
                : "Edit your planned squad"}
            </h2>
            <p className="muted">
              Choose a player at 15/15 to start a direct replacement, or remove
              players to rebuild several positions.
            </p>
          </div>
          <button
            onClick={onClose}
            className="close"
            aria-label="Close squad editor"
          >
            ×
          </button>
        </div>

        <div className="editor-summary-card">
          <div className="summary-stat-group">
            <div className="summary-stat">
              <span className="stat-label">SQUAD PLAYERS</span>
              <span className={`stat-val ${ids.length === 15 ? "valid" : ""}`}>
                {ids.length}/15
              </span>
            </div>
            <div className="summary-stat">
              <span className="stat-label">SQUAD COST</span>
              <span
                className={`stat-val ${totalPrice > (draftMode ? INITIAL_SQUAD_BUDGET : 100 + bank) ? "error" : ""}`}
              >
                £{totalPrice.toFixed(1)}m{" "}
                <small>
                  / £
                  {(draftMode ? INITIAL_SQUAD_BUDGET : 100 + bank).toFixed(1)}m
                </small>
              </span>
            </div>
            <div className="summary-stat highlight">
              <span className="stat-label">GW{horizon} PROJECTED SCORE</span>
              <span className="stat-val score">
                ⚡ {projectedScore.toFixed(1)} pts
              </span>
            </div>
          </div>
          <div className="pos-counters">
            <span className={`pos-pill ${posCounts.GK === 2 ? "full" : ""}`}>
              GK {posCounts.GK}/2
            </span>
            <span className={`pos-pill ${posCounts.DEF === 5 ? "full" : ""}`}>
              DEF {posCounts.DEF}/5
            </span>
            <span className={`pos-pill ${posCounts.MID === 5 ? "full" : ""}`}>
              MID {posCounts.MID}/5
            </span>
            <span className={`pos-pill ${posCounts.FWD === 3 ? "full" : ""}`}>
              FWD {posCounts.FWD}/3
            </span>
          </div>
          <div className="editor-quick-actions">
            <button className="clear-btn" onClick={clearSquad}>
              Start over
            </button>
            <button className="preset-btn" onClick={autoFillBest}>
              {draftMode
                ? "Optimise squad around locks"
                : "Build best 15-player squad"}
            </button>
            {ids.length > 0 && ids.length < 15 && (
              <button className="fill-btn" onClick={autoFillRemaining}>
                Auto-fill remaining ({15 - ids.length})
              </button>
            )}
          </div>
        </div>

        <div className="squad-editor-layout">
          <div className="squad-editor-catalog-pane">
            {draftMode && ids.length > 0 && (
              <div className="locked-player-panel">
                <div>
                  <b>Locked core</b>
                  <small>
                    {" "}
                    Locked players are preserved when the GW1 optimiser rebuilds the
                    squad.
                  </small>
                </div>
                <div className="locked-player-list">
                  {currentSquad.map((player) => (
                    <button
                      type="button"
                      className={
                        editorLockedIds.includes(player.id) ? "locked" : ""
                      }
                      onClick={() => toggleLock(player.id)}
                      key={player.id}
                    >
                      {editorLockedIds.includes(player.id) ? "🔒" : "○"}{" "}
                      {player.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="editor-tools">
              <div className="tools-row">
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search player or club…"
                  className="search-input"
                />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  className="sort-select"
                >
                  <option value="pts">Sort by GW{horizon} Points</option>
                  <option value="price-desc">Sort by Price (High to Low)</option>
                  <option value="price-asc">Sort by Price (Low to High)</option>
                  <option value="name">Sort by Name</option>
                </select>
              </div>
              <div className="player-filters" style={{ marginBottom: 0 }}>
                {["All", "Selected", "GK", "DEF", "MID", "FWD"].map((x) => (
                  <button
                    className={posFilter === x ? "selected" : ""}
                    onClick={() => setPosFilter(x)}
                    key={x}
                  >
                    {x}
                  </button>
                ))}
              </div>
            </div>

            {pendingIncoming && (
              <div
                className="replacement-picker"
                role="region"
                aria-label={`Choose a player to replace with ${pendingIncoming.name}`}
              >
                <div>
                  <span className="green-tag">IN</span>
                  <b>{pendingIncoming.name}</b>
                  <small>Select the {pendingIncoming.position} to replace</small>
                </div>
                <div className="replacement-options">
                  {currentSquad
                    .filter((p) => p.position === pendingIncoming.position)
                    .map((out) => (
                      <button key={out.id} onClick={() => replacePlayer(out.id)}>
                        <span className="red-tag">OUT</span>
                        {out.name}
                        <b>
                          {(horizonProjection(pendingIncoming, horizon) -
                            horizonProjection(out, horizon) >=
                          0
                            ? "+"
                            : "") +
                            (
                              horizonProjection(pendingIncoming, horizon) -
                              horizonProjection(out, horizon)
                            ).toFixed(1)}{" "}
                          pts
                        </b>
                      </button>
                    ))}
                </div>
                <button
                  className="close"
                  aria-label="Cancel replacement"
                  onClick={() => setPendingIncoming(null)}
                >
                  ×
                </button>
              </div>
            )}
            <div className="editor-grid">
              {filtered.map((p) => {
                const isPicked = ids.includes(p.id);
                const proj = horizonProjection(p, horizon);
                return (
                  <button
                    className={"editor-player " + (isPicked ? "picked" : "")}
                    onClick={() => toggle(p.id)}
                    key={p.id}
                  >
                    <span className="mini-shirt" style={{ background: getPlayerShirtColor(p) }}>
                      {p.position}
                    </span>
                    <div className="player-info">
                      <b>{p.name}</b>
                      <small>
                        {p.club} · £{p.price.toFixed(1)}m
                      </small>
                    </div>
                    <div className="player-proj">
                      <strong>
                        {proj.toFixed(1)} <small>pts</small>
                      </strong>
                      <span className="check">{isPicked ? "✓" : "+"}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="squad-editor-pitch-pane">
            <div className="editor-pitch-card">
              <div className="editor-pitch-head">
                <div>
                  <span className="eyebrow">FORMATION PREVIEW</span>
                  <h3>{formationString} Lineup</h3>
                </div>
                <div className="pitch-score-badge">
                  <span>Starting XI</span>
                  <strong>⚡ {currentXI.reduce((sum, p) => sum + horizonProjection(p, horizon), 0).toFixed(1)} pts</strong>
                </div>
              </div>

              <div className="pitch editor-pitch">
                {["GK", "DEF", "MID", "FWD"].map((pos) => (
                  <div className="pitch-row" key={pos}>
                    {currentXI
                      .filter((p) => p.position === pos)
                      .map((p) => (
                        <PlayerChip
                          p={p}
                          horizon={horizon}
                          isLocked={editorLockedIds.includes(p.id)}
                          onClick={() => toggleLock(p.id)}
                          key={p.id}
                        />
                      ))}
                  </div>
                ))}
              </div>

              <div className="bench editor-pitch-bench">
                <div className="editor-bench-title">BENCH (SUB ORDER)</div>
                <div className="editor-bench-list">
                  {editorBench.map((p) => (
                    <PlayerChip
                      p={p}
                      sub
                      horizon={horizon}
                      isLocked={editorLockedIds.includes(p.id)}
                      onClick={() => toggleLock(p.id)}
                      key={p.id}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {issues.length > 0 && (
          <div className="editor-issues">
            {issues.slice(0, 3).map((x) => (
              <div key={x.rule}>
                {x.rule}: {x.detail}
              </div>
            ))}
          </div>
        )}
        <div className="modal-foot">
          <button className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="dark-btn"
            disabled={ids.length !== 15 || issues.length > 0}
            onClick={() => onSave(ids, editorLockedIds)}
          >
            {draftMode ? "Save GW1 Draft" : "Save Plan"}
          </button>
        </div>
      </div>
    </div>
  );
}
function FplAccountPatch({
  account,
  onSync,
  isSyncing,
  onChangeAccount,
}: {
  account: FplAccount | null;
  onSync: () => void;
  isSyncing: boolean;
  onChangeAccount: () => void;
}) {
  if (!account) {
    return (
      <div className="fpl-account-patch empty-state">
        <div className="patch-header">
          <div className="patch-team-info">
            <div className="patch-badge-crest">⚽</div>
            <div className="patch-meta">
              <span className="patch-eyebrow">SEASON FPL ACCOUNT</span>
              <h2 className="team-name">No FPL Account Saved</h2>
              <div className="manager-sub">
                <span>Save your FPL Team ID to download your team name and track stats</span>
              </div>
            </div>
          </div>
          <div className="patch-header-actions">
            <button className="sync-btn primary" onClick={onChangeAccount}>
              <span>Save Season Account</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  const timeAgo = account.lastSynced
    ? (() => {
        const diffSec = Math.floor(
          (Date.now() - new Date(account.lastSynced).getTime()) / 1000,
        );
        if (diffSec < 60) return "Just now";
        if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
        return `${Math.floor(diffSec / 3600)}h ago`;
      })()
    : "";

  return (
    <div className="fpl-account-patch">
      <div className="patch-header">
        <div className="patch-team-info">
          <div className="patch-badge-crest">⚽</div>
          <div className="patch-meta">
            <div className="patch-title-row">
              <span className="patch-eyebrow">SAVED SEASON FPL ACCOUNT</span>
              {account.overallRank && (
                <span className="rank-badge">Rank #{account.overallRank.toLocaleString()}</span>
              )}
            </div>
            <h2 className="team-name">{account.teamName}</h2>
            <div className="manager-sub">
              {account.managerName && (
                <span className="manager-name">{account.managerName}</span>
              )}
              <span className="team-id">ID: {account.teamId}</span>
              {timeAgo && <span className="synced-time">Synced {timeAgo}</span>}
            </div>
          </div>
        </div>
        <div className="patch-header-actions">
          <button
            className={`sync-btn ${isSyncing ? "syncing" : ""}`}
            onClick={onSync}
            disabled={isSyncing}
            title="Sync latest FPL team stats and squad"
          >
            <span className={`sync-icon ${isSyncing ? "spin" : ""}`}>↻</span>
            <span>{isSyncing ? "Syncing..." : "Sync Account"}</span>
          </button>
          <button
            className="ghost-btn"
            onClick={onChangeAccount}
            title="Change or update saved account"
            style={{ fontSize: "12px", padding: "7px 12px" }}
          >
            Manage Account
          </button>
        </div>
      </div>

      <div className="patch-grid">
        <div className="patch-card">
          <span className="patch-card-label">TOTAL POINTS</span>
          <div className="patch-card-val-group">
            <span className="patch-card-value highlight-gold">
              {account.totalPoints.toLocaleString()}
            </span>
            <span className="patch-card-unit">pts</span>
          </div>
          <span className="patch-card-sub">Overall Season Score</span>
        </div>

        <div className="patch-card">
          <span className="patch-card-label">GAME WEEK POINTS</span>
          <div className="patch-card-val-group">
            <span className="patch-card-value highlight-cyan">
              {account.gameweekPoints}
            </span>
            <span className="patch-card-unit">pts</span>
          </div>
          <span className="patch-card-sub">Gameweek {account.currentGameweek}</span>
        </div>

        <div className="patch-card">
          <span className="patch-card-label">SQUAD VALUE</span>
          <div className="patch-card-val-group">
            <span className="patch-card-value">
              £{account.squadValue.toFixed(1)}m
            </span>
          </div>
          <span className="patch-card-sub">
            In Bank: £{account.bank.toFixed(1)}m
          </span>
        </div>

        <div className="patch-card">
          <span className="patch-card-label">TRANSFERS</span>
          <div className="patch-card-val-group">
            <span className="patch-card-value">
              {account.totalTransfers}
            </span>
            <span className="patch-card-unit">made</span>
          </div>
          <span className="patch-card-sub">
            GW{account.currentGameweek}: {account.eventTransfers} made {account.transfersCost > 0 ? `(-${account.transfersCost}pts)` : '(0 hit)'}
          </span>
        </div>
      </div>
    </div>
  );
}

function ImportModal({
  value,
  setValue,
  onImport,
  message,
  loading,
  onClose,
  account,
  onUnlink,
}: {
  value: string;
  setValue: (s: string) => void;
  onImport: () => void;
  message: string;
  loading: boolean;
  onClose: () => void;
  account?: FplAccount | null;
  onUnlink?: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <div
        className="modal import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">FPL SEASON ACCOUNT</p>
            <h2 id="import-title">
              {account ? "Sync or Update FPL Account" : "Save Your Season FPL Account"}
            </h2>
            <p className="muted">
              Enter your numeric FPL Team ID or paste your public team URL.
            </p>
          </div>
          <button
            onClick={onClose}
            className="close"
            aria-label="Close modal"
          >
            ×
          </button>
        </div>

        {account && (
          <div style={{ marginBottom: "18px", padding: "14px", background: "rgba(0,255,135,0.06)", borderRadius: "10px", border: "1px solid rgba(0,255,135,0.2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
              <span style={{ fontWeight: 700, color: "#ffffff", fontSize: "15px" }}>⚽ {account.teamName}</span>
              <span style={{ fontSize: "11px", color: "var(--accent-emerald)" }}>ID: {account.teamId}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px", fontSize: "12px", textTransform: "uppercase" }}>
              <div>
                <small style={{ color: "var(--text-muted)", display: "block" }}>Total Pts</small>
                <b style={{ color: "#f59e0b", fontSize: "14px" }}>{account.totalPoints}</b>
              </div>
              <div>
                <small style={{ color: "var(--text-muted)", display: "block" }}>GW Pts</small>
                <b style={{ color: "#38bdf8", fontSize: "14px" }}>{account.gameweekPoints}</b>
              </div>
              <div>
                <small style={{ color: "var(--text-muted)", display: "block" }}>Squad Value</small>
                <b style={{ color: "#ffffff", fontSize: "14px" }}>£{account.squadValue.toFixed(1)}m</b>
              </div>
              <div>
                <small style={{ color: "var(--text-muted)", display: "block" }}>Transfers</small>
                <b style={{ color: "#ffffff", fontSize: "14px" }}>{account.totalTransfers}</b>
              </div>
            </div>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!loading) onImport();
          }}
        >
          <label className="field-label">
            Team ID or public URL
            <input
              className="import-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={account ? `Current: ${account.teamId}` : "e.g. 1234567 or fantasy.premierleague.com/entry/1234567"}
              disabled={loading}
              autoFocus
            />
          </label>
          <p className="import-note">
            <Shield size={14} /> Saving downloads your team name, total points, game week points, squad value, transfers, and imports your squad picks.
          </p>
          {message && (
            <div className="editor-issues" role="status">
              {message}
            </div>
          )}
          <div className="modal-foot">
            {account && onUnlink && (
              <button
                type="button"
                className="ghost-btn"
                onClick={onUnlink}
                disabled={loading}
                style={{ color: "#f87171", marginRight: "auto" }}
              >
                Unlink Account
              </button>
            )}
            <button
              type="button"
              className="ghost-btn"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </button>
            <button type="submit" className="dark-btn" disabled={loading}>
              {loading ? "Saving & Syncing..." : account ? "Sync / Update Account" : "Save & Download Team"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Transfers({ data, horizon }: { data: any[]; horizon: number }) {
  return (
    <div className="content">
      <div className="page-intro">
        <div>
          <p className="eyebrow">TRANSFER LAB</p>
          <h2>Moves that improve your team</h2>
          <p className="muted">
            Ranked by net marginal gain after transfer costs over the next{" "}
            {horizon} gameweeks.
          </p>
        </div>
        <div className="filter-pill">
          <Gauge size={15} /> 1 free transfer
        </div>
      </div>
      <div className="panel transfer-list">
        {data.slice(0, 8).map((t, i) => (
          <div className="transfer-row" key={t.out.id + "-" + t.in.id}>
            <span className="rank">{String(i + 1).padStart(2, "0")}</span>
            <div className="transfer-player">
              <span className="mini-shirt" style={{ background: getPlayerShirtColor(t.out) }}>
                {t.out.position}
              </span>
              <div>
                <b>{t.out.name}</b>
                <small>
                  {t.out.club} · £{t.out.price.toFixed(1)}m
                </small>
              </div>
            </div>
            <ArrowRight size={17} className="arrow-muted" />
            <div className="transfer-player">
              <span className="mini-shirt" style={{ background: getPlayerShirtColor(t.in) }}>
                {t.in.position}
              </span>
              <div>
                <b>{t.in.name}</b>
                <small>
                  {t.in.club} · £{t.in.price.toFixed(1)}m
                </small>
              </div>
            </div>
            <span className="fixture">{t.in.fixture}</span>
            <div className="gain">
              <b>+{t.net}</b>
              <small>net pts</small>
            </div>
            <button className="why-btn">Why?</button>
          </div>
        ))}
        {data.length === 0 && (
          <div className="empty">No legal upgrades found for this horizon.</div>
        )}
      </div>
    </div>
  );
}
function Players({
  filtered,
  search,
  setSearch,
  horizon,
}: {
  filtered: Player[];
  search: string;
  setSearch: (s: string) => void;
  horizon: number;
}) {
  return (
    <div className="content">
      <div className="page-intro">
        <div>
          <p className="eyebrow">PLAYER POOL</p>
          <h2>Find your next edge</h2>
          <p className="muted">
            Every projection is an estimate, refreshed from the latest snapshot.
          </p>
        </div>
        <div className="search">
          <Search size={16} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search player or club"
          />
        </div>
      </div>
      <div className="panel table shortlist-table">
        <div className="tr th shortlist-tr">
          <span>PLAYER</span>
          <span>FIXTURES</span>
          <span className="th-right">FORM</span>
          <span className="th-right">MINUTES</span>
          <span className="th-right">{horizon}-GW PROJ.</span>
          <span className="th-right">VALUE</span>
        </div>
        {filtered.map((p) => (
          <div className="tr shortlist-tr" key={p.id}>
            <div className="name-cell">
              <span className="mini-shirt" style={{ background: getPlayerShirtColor(p) }}>
                {p.position}
              </span>
              <div>
                <b>{p.name}</b>
                <small>
                  {p.club} · £{p.price.toFixed(1)}m
                </small>
              </div>
            </div>
            <span className="fixture fixture-strip">
              {getPlayerUpcomingFixtures(p, horizon).map((f, idx) => (
                <span
                  key={`${f.gameweek}-${f.opponent}-${idx}`}
                  className={`fdr-pill fdr-${f.difficulty}`}
                  title={`GW${f.gameweek}: vs ${f.opponent} (${f.venue}) - FDR ${f.difficulty}`}
                >
                  {f.opponent} ({f.venue})
                </span>
              ))}
            </span>
            <span className="col-numeric">{p.form.toFixed(1)}</span>
            <span className="col-numeric">{p.minutes}%</span>
            <span className="col-numeric col-proj">
              <b>{horizonProjection(p, horizon).toFixed(1)}</b> pts
            </span>
            <span className="value col-numeric">{(p.projection / p.price).toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
function ReviewView() {
  const [backtest, setBacktest] = useState<any>(null);
  const [decisions, setDecisions] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all([fetchBacktest(), fetchDecisionHistory()]).then(([nextBacktest, nextDecisions]) => {
      if (active) { setBacktest(nextBacktest); setDecisions(nextDecisions); }
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Review data unavailable'); });
    return () => { active = false; };
  }, []);
  return (
    <div className="content">
      <div className="page-intro"><div><p className="eyebrow">MEASUREMENT · SAVED EVIDENCE</p><h2>Decision and model review</h2><p className="muted">Forecast accuracy and saved manager choices remain separate; retrospective differences are not causal proof.</p></div></div>
      {error && <div className="panel"><p className="muted">{error}</p></div>}
      {backtest && <div className="panel">
        <div className="panel-head"><div><h2>Backtest status</h2><p>{backtest.observationCount ? `${backtest.observationCount} eligible pre-deadline observations` : 'Insufficient sample: no completed eligible forecasts yet.'}</p></div><span className={`pill ${backtest.status === 'CALIBRATED' ? 'green' : 'amber'}`}>{backtest.status === 'CALIBRATED' ? 'CALIBRATED' : 'UNCALIBRATED'}</span></div>
        {backtest.models?.map((model: any) => <div className="review-strip" key={model.modelVersion}><span><b>Model</b>{model.modelVersion}</span><span><b>Sample</b>{model.observationCount}</span><span><b>Training cutoff</b>{model.trainingCutoff || '—'}</span><span><b>MAE</b>{Number(model.summary?.mae || 0).toFixed(2)}</span><span><b>Coverage</b>{Math.round(Number(model.summary?.intervalCoverage || 0) * 100)}%</span></div>)}
      </div>}
      <div className="panel">
        <div className="panel-head"><div><h2>Decision history</h2><p>Expected values at decision time versus realized saved-plan outcomes.</p></div><span className="filter-pill">{decisions.length} records</span></div>
        {!decisions.length ? <p className="muted">No accepted, rejected, ignored, or custom decisions have been recorded yet.</p> : decisions.map(decision => <div className="review-card" key={decision.id}>
          <div className="card-agent-header"><b>{decision.decision}</b><span className="pill">{decision.outcome?.status || 'PENDING'}</span></div>
          <p>Expected candidate gain: {decision.expectedCandidateGain == null ? '—' : Number(decision.expectedCandidateGain).toFixed(2)} pts · Realized manager decision result: {decision.realizedPointsDelta == null ? 'Pending' : `${Number(decision.realizedPointsDelta).toFixed(2)} pts`}</p>
          <small>Model forecast error: {decision.outcome?.modelForecastError == null ? 'Pending' : Number(decision.outcome.modelForecastError).toFixed(2)} · {decision.outcome?.wording}</small>
        </div>)}
      </div>
    </div>
  );
}

function ModelDebug({ horizon }: { horizon: number }) {
  const [catalogue, setCatalogue] = useState<Awaited<ReturnType<typeof fetchProjectionCatalog>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; fetchProjectionCatalog().then(value => { if (active) setCatalogue(value); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Catalogue unavailable'); }); return () => { active = false; }; }, []);
  const rows = catalogue?.players || [];
  return (
    <div className="content">
      <div className="page-intro">
        <div>
          <p className="eyebrow">
            DEVELOPER DIAGNOSTICS · CATALOGUE INPUTS
          </p>
          <h2>Projection breakdown</h2>
          <p className="muted">
            Deliberately dense. Use this page to find football-stupid
            assumptions before trusting recommendations.
          </p>
        </div>
        <div className="filter-pill">
          {rows.length} players · selected {horizon} GW
        </div>
      </div>
      {catalogue && <p className="muted" aria-label="Catalogue source freshness">
        {Object.entries(catalogue.freshness).map(([source, freshness]) => `${source}: ${freshness.status === 'FRESH' ? 'Fresh' : freshness.status === 'STALE' ? 'Stale' : 'Missing'}`).join(' · ')}
      </p>}
      <div className="panel debug-table">
        <div className="debug-row debug-head">
          <span>PLAYER</span>
          <span>OFFICIAL</span><span>UNDERLYING</span><span>SIGNALS</span><span>FIXTURES</span><span>MARKET</span><span>PROVENANCE</span>
        </div>
        {error && <p className="muted">{error}</p>}
        {rows.map((player) => (
          <div className="debug-row" key={player.id}>
            <div className="debug-name">
              <b>{player.name}</b>
              <small>
                {player.team.shortName} · FPL #{player.fplId}
              </small>
            </div>
            <span>{player.provenance.officialObservationId}</span>
            <span>{player.provenance.underlyingObservationId || '—'}</span>
            <span>{player.roleSignals.map(signal => signal.id).join(', ') || '—'}</span>
            <span>{player.fixtures.length}</span>
            <span>{player.fixtures.some(fixture => fixture.market) ? 'selected' : '—'}</span>
            <strong>{player.provenance.manualOverrideSignalIds.length ? 'manual override' : 'standard'}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
function EvidencePanel({
  squad,
  horizon = 3,
  auditTargetCount,
  result,
  loading,
  error,
  rawOutput,
  outputTypes,
  onChallenge,
  onReviewSignal,
  stagedSignalReviews,
  onUnstageSignal,
  onSelectPlayer,
  setTab,
  onManualOverride,
  onReplacePlayer,
}: {
  squad: Player[];
  horizon?: number;
  auditTargetCount: number;
  result: SquadChallengeResult | null;
  loading: boolean;
  error: string | null;
  rawOutput: string;
  outputTypes: string[];
  onChallenge: () => void;
  onReviewSignal: (
    signal: PlayerSignal,
    status: "VERIFIED" | "REJECTED",
  ) => void;
  stagedSignalReviews: Record<string, "VERIFIED" | "REJECTED">;
  onUnstageSignal: (signalId: string | number) => void;
  onSelectPlayer?: (p: Player) => void;
  setTab?: (tab: string) => void;
  onManualOverride?: (playerId: number, startProbability: number, note?: string) => void;
  onReplacePlayer?: (p: Player) => void;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [reviewingSignalId, setReviewingSignalId] = useState<string | number | null>(null);
  const [activeOverridePlayerId, setActiveOverridePlayerId] = useState<number | null>(null);

  useEffect(() => {
    if (!loading) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [loading]);

  const playerName = (id: number) =>
    squad.find((player) => player.id === id)?.name || `Player ${id}`;

  const verifiedSignals = useMemo(() => {
    return result?.signals?.filter((s) => s.status === "VERIFIED") || [];
  }, [result]);

  return (
    <section className="panel evidence-panel">
      <div className="panel-head">
        <div>
          <h2>Challenge this squad with current evidence</h2>
          <p>
            Searches current sources for role, injury and minutes risks. Findings
            remain pending until you approve them.
          </p>
        </div>
        <button
          className="dark-btn"
          onClick={onChallenge}
          disabled={loading}
          aria-busy={loading}
        >
          {loading && <span className="llm-spinner llm-spinner-small" aria-hidden="true" />}
          {loading ? "Researching…" : result ? "Run again" : "Challenge squad"}
        </button>
      </div>

      {loading && (
        <div className="evidence-loading" role="status" aria-live="polite">
          <span className="llm-spinner" aria-hidden="true" />
          <div>
            <b>Reviewing current sources…</b>
            <small>
              {elapsedSeconds}s elapsed · checking starts, injuries, roles and
              set pieces. The research continues as a background job if it takes longer.
            </small>
            <div className="research-progress" aria-hidden="true"><span /></div>
            <small>
              Auditing up to {auditTargetCount} high-risk player{auditTargetCount === 1 ? "" : "s"}; searches are capped to control time and cost.
            </small>
          </div>
        </div>
      )}

      {error && <p className="evidence-error">{error}</p>}
      {error && rawOutput && (
        <details className="research-debug-output">
          <summary>Inspect raw model output</summary>
          {!!outputTypes.length && <small>Response blocks: {outputTypes.join(", ")}</small>}
          <pre>{rawOutput}</pre>
        </details>
      )}

      {!loading && result && (
        <>
          <p className="evidence-summary">{result.summary}</p>
          {result.provenanceWarning && <p className="evidence-warning">{result.provenanceWarning}</p>}

          {result.usage && (
            <div className="research-usage">
              <span><b>{result.usage.totalTokens.toLocaleString()}</b> total tokens</span>
              <span>{result.usage.inputTokens.toLocaleString()} input</span>
              <span>{result.usage.outputTokens.toLocaleString()} output</span>
              <span>{result.usage.webSearchCalls} web search{result.usage.webSearchCalls === 1 ? "" : "es"}</span>
              <span>
                {result.usage.estimatedCostUsd == null
                  ? "Cost unavailable for custom model"
                  : `Estimated cost $${result.usage.estimatedCostUsd.toFixed(4)} USD`}
              </span>
            </div>
          )}

          {/* Post-approval Next Steps Banner */}
          {verifiedSignals.length > 0 && (
            <div className="post-approval-banner">
              <div>
                <div className="post-approval-header">
                  <span className="pill green">✓ PROJECTIONS UPDATED</span>
                  <b>{verifiedSignals.length} Evidence Finding{verifiedSignals.length === 1 ? "" : "s"} Approved</b>
                </div>
                <p className="post-approval-desc">
                  Projections have been recalculated across the engine. Demoted players (e.g. Dubravka at 10% start chance) have been automatically moved to your bench if a better starter is in your 15. Your 15-player roster stays intact until you make a transfer.
                </p>
              </div>
              <div className="post-approval-actions">
                {setTab && (
                  <button
                    className="emerald-btn"
                    onClick={() => {
                      const demoted = squad.find((p) => {
                        const sig = verifiedSignals.find((s) => s.playerId === p.id);
                        return sig && sig.value.startProbability !== undefined && sig.value.startProbability < 0.5;
                      }) || squad.find((p) => verifiedSignals.some((s) => s.playerId === p.id));
                      if (demoted && onReplacePlayer) {
                        onReplacePlayer(demoted);
                      } else {
                        setTab("Transfers");
                      }
                    }}
                  >
                    🔄 Find Replacement Transfer
                  </button>
                )}
              </div>
            </div>
          )}

          {!!result.rejectedSignalCount && (
            <p className="muted">
              {result.rejectedSignalCount} proposed claim
              {result.rejectedSignalCount === 1 ? " was" : "s were"} discarded
              because the cited URL could not be verified against research sources.
            </p>
          )}

          {!!result.audits?.length && (
            <div className="audit-coverage">
              <div className="audit-coverage-head">
                <b>Priority audit coverage</b>
                <small>{result.audits.length} players checked</small>
              </div>

              {/* Explanatory Callout for Audit Coverage */}
              <details className="audit-info-details">
                <summary className="audit-info-summary">
                  💡 Why are some players marked "NO CHANGE"? Do I need to action rotation risks? ▾
                </summary>
                <div className="audit-info-body">
                  <p>
                    <b>1. Baseline vs New News:</b> <i>NO CHANGE</i> means our audit found no <u>new</u> breaking news or injury updates today. For rotation players (like Hughes), the baseline model already accounts for their expected start chance (~55%). Only NEW source-backed findings generate an approval prompt.
                  </p>
                  <p>
                    <b>2. Actioning Rotation Risk:</b> If you want to replace a rotation risk or override their start chance manually, click <b>Transfer</b> or <b>Set Start %</b> on their card below.
                  </p>
                </div>
              </details>

              <div className="audit-grid">
                {result.audits.map((audit) => {
                  const player = squad.find((p) => p.id === audit.playerId);
                  const xPts = player ? horizonProjection(player, horizon) : null;
                  const startPct = player?.roleProfile?.startProbability !== undefined
                    ? Math.round(player.roleProfile.startProbability * 100)
                    : null;
                  const isRotation = audit.expectedRole === "ROTATION";

                  return (
                    <div className="audit-row" key={audit.playerId}>
                      <span>
                        <b>{playerName(audit.playerId)} {player ? `(${player.position})` : ""}</b>
                        {xPts !== null && (
                          <small style={{ color: "#38bdf8", fontWeight: 600 }}>
                            {xPts.toFixed(1)} xPts ({startPct}% start chance)
                          </small>
                        )}
                        <small>{audit.evidenceSummary}</small>
                      </span>

                      <div className="audit-row-right">
                        <span
                          className={`pill ${
                            audit.outcome === "MATERIAL_RISK"
                              ? "amber"
                              : isRotation
                                ? "slate-amber"
                                : audit.outcome === "NO_MATERIAL_RISK"
                                  ? "green"
                                  : ""
                          }`}
                        >
                          {audit.outcome === "MATERIAL_RISK"
                            ? `REVIEW · ${String(audit.expectedRole).replace(/_/g, " ")}`
                            : isRotation
                              ? `BASELINE · ROTATION`
                              : audit.outcome === "INSUFFICIENT_EVIDENCE"
                                ? `NO SIGNAL · ${String(audit.expectedRole).replace(/_/g, " ")}`
                                : `NO CHANGE · ${String(audit.expectedRole).replace(/_/g, " ")}`}
                        </span>

                        <div style={{ display: "flex", gap: "4px", marginTop: "4px" }}>
                          {setTab && (
                            <button
                              className="ghost-btn-xs"
                              title={`Find transfer to replace ${playerName(audit.playerId)}`}
                              onClick={() => setTab("Transfers")}
                            >
                              Transfer
                            </button>
                          )}
                          {onManualOverride && (
                            <button
                              className="ghost-btn-xs"
                              title="Set custom start probability"
                              onClick={() =>
                                setActiveOverridePlayerId(
                                  activeOverridePlayerId === audit.playerId ? null : audit.playerId
                                )
                              }
                            >
                              Set Start %
                            </button>
                          )}
                        </div>

                        {activeOverridePlayerId === audit.playerId && onManualOverride && (
                          <div style={{ display: "flex", gap: "4px", marginTop: "6px", flexWrap: "wrap" }}>
                            <button
                              className="ghost-btn-xs"
                              style={{ background: "rgba(16,185,129,0.2)" }}
                              onClick={() => {
                                onManualOverride(audit.playerId, 0.9, "Manual override: 90% starter");
                                setActiveOverridePlayerId(null);
                              }}
                            >
                              90% Start
                            </button>
                            <button
                              className="ghost-btn-xs"
                              style={{ background: "rgba(245,158,11,0.2)" }}
                              onClick={() => {
                                onManualOverride(audit.playerId, 0.5, "Manual override: 50% rotation");
                                setActiveOverridePlayerId(null);
                              }}
                            >
                              50% Start
                            </button>
                            <button
                              className="ghost-btn-xs"
                              style={{ background: "rgba(239,68,68,0.2)" }}
                              onClick={() => {
                                onManualOverride(audit.playerId, 0.1, "Manual override: 10% backup");
                                setActiveOverridePlayerId(null);
                              }}
                            >
                              10% Start
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!result.signals.length && (
            <p className="muted" style={{ marginTop: "12px" }}>
              There is nothing to approve, so this run cannot change any player projection.
            </p>
          )}

          <div className="evidence-list">
            {result.signals.map((signal) => {
              const player = squad.find((p) => p.id === signal.playerId);
              const xPts = player ? horizonProjection(player, horizon) : null;
              const rawProb = signal.value?.startProbability;
              const normProb = typeof rawProb === "number" ? (rawProb > 1 ? rawProb / 100 : rawProb) : null;
              const proposedProb = normProb !== null ? Math.round(normProb * 100) : null;
              const stagedStatus = stagedSignalReviews[signal.id];
              const effectiveStatus = stagedStatus || signal.status;

              return (
                <article className="evidence-item" key={signal.id}>
                  <div style={{ flex: 1 }}>
                    <div className="evidence-title">
                      <b>
                        {playerName(signal.playerId)} {player ? `(${player.position})` : ""}
                      </b>
                      {xPts !== null && (
                        <span style={{ fontSize: "13px", color: "#38bdf8", fontWeight: 600 }}>
                          {xPts.toFixed(1)} xPts over {horizon} GWs
                        </span>
                      )}
                      <span
                        className={`pill ${
                          effectiveStatus === "VERIFIED"
                            ? "green"
                            : effectiveStatus === "REJECTED"
                              ? "red"
                              : "amber"
                        }`}
                      >
                        {stagedStatus ? `STAGED: ${stagedStatus === "VERIFIED" ? "APPROVE" : "REJECT"}` : effectiveStatus === "VERIFIED" ? "✓ VERIFIED · PROJECTIONS UPDATED" : effectiveStatus}
                      </span>
                    </div>

                    <p>{signal.evidenceSummary}</p>

                    <small>
                      {signal.sourceType.replace(/_/g, " ")} · {Math.round(signal.confidence * 100)}% confidence
                      {proposedProb !== null ? ` · proposed start chance ${proposedProb}%` : ""}
                    </small>

                    {effectiveStatus === "VERIFIED" && !stagedStatus && xPts !== null && (
                      <div className="evidence-impact-tag">
                        ✓ Applied to model: {proposedProb !== null ? `${proposedProb}% start chance` : "Role updated"} → {xPts.toFixed(1)} xPts over {horizon} GWs
                      </div>
                    )}

                    {sanitizeExternalUrl(signal.sourceUrl) && (
                      <a href={sanitizeExternalUrl(signal.sourceUrl)!} target="_blank" rel="noreferrer">
                        Open source ↗
                      </a>
                    )}
                  </div>

                  <div className="evidence-actions">
                    {stagedStatus ? (
                      <div className="staged-signal-action">
                        <span className={`staged-pill ${stagedStatus === "REJECTED" ? "rejected" : ""}`}>STAGED: {stagedStatus === "VERIFIED" ? "APPROVE" : "REJECT"}</span>
                        <button className="undo-staged-btn" onClick={() => onUnstageSignal(signal.id)}>Undo</button>
                      </div>
                    ) : signal.status === "PENDING" && (
                      <>
                        <button
                          className="dark-btn"
                          disabled={false}
                          onClick={async () => {
                            setReviewingSignalId(signal.id);
                            try {
                              onReviewSignal(signal, "VERIFIED");
                            } finally {
                              setReviewingSignalId(null);
                            }
                          }}
                        >
                          Approve & Update
                        </button>
                        <button
                          className="ghost-btn"
                          disabled={false}
                          onClick={async () => {
                            setReviewingSignalId(signal.id);
                            try {
                              onReviewSignal(signal, "REJECTED");
                            } finally {
                              setReviewingSignalId(null);
                            }
                          }}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {!stagedStatus && effectiveStatus === "VERIFIED" && (
                      <>
                        {setTab && (
                          <button
                            className="dark-btn"
                            onClick={() => {
                              if (player && onReplacePlayer) {
                                onReplacePlayer(player);
                              } else {
                                setTab("Transfers");
                              }
                            }}
                          >
                            🔄 Replace Player
                          </button>
                        )}
                        <button
                          className="ghost-btn"
                          onClick={() => onReviewSignal(signal, "REJECTED")}
                        >
                          Reset
                        </button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function MyTeamV2({
  squad,
  xi,
  horizon,
  captain,
  bank = activeManagerSettings.bank,
  onEdit,
  onSelectPlayer,
  challenge,
  challengeLoading,
  challengeError,
  challengeRawOutput,
  challengeOutputTypes,
  onChallenge,
  onReviewSignal,
  stagedSignalReviews,
  onUnstageSignal,
  onManualOverride,
  weakest,
  decision,
  freeTransfers,
  draftMode,
  draftPlan,
  legalBundles = [],
  onApplyDraft,
  onApplyBundle,
  onWhy,
  setTab,
  onReplacePlayer,
}: {
  squad: Player[];
  xi: Player[];
  horizon: number;
  captain: Player | null;
  bank?: number;
  onEdit: () => void;
  onSelectPlayer: (p: Player) => void;
  challenge: SquadChallengeResult | null;
  challengeLoading: boolean;
  challengeError: string | null;
  challengeRawOutput: string;
  challengeOutputTypes: string[];
  onChallenge: () => void;
  onReviewSignal: (
    signal: PlayerSignal,
    status: "VERIFIED" | "REJECTED",
  ) => void;
  stagedSignalReviews: Record<string, "VERIFIED" | "REJECTED">;
  onUnstageSignal: (signalId: string | number) => void;
  onManualOverride?: (
    playerId: number,
    startProbability: number,
    note?: string,
  ) => void;
  weakest: Transfer | null;
  decision: { roll: boolean };
  freeTransfers: number;
  draftMode: boolean;
  draftPlan: DraftImprovementPlan | null;
  legalBundles?: DraftChangeBundle[];
  onApplyDraft: () => void;
  onApplyBundle?: (bundle: DraftChangeBundle) => void;
  onWhy: (transfer: Transfer) => void;
  setTab: (tab: string) => void;
  onReplacePlayer?: (p: Player) => void;
}) {
  const starters = new Set(xi.map((p) => p.id));
  const bench = benchOrder(horizon, squad, xi);
  const auditTargetCount = Math.min(
    6,
    squad.filter(
      (player) =>
        (starters.has(player.id) && player.position === "GK") ||
        (player.position === "GK" && player.price <= 4.5) ||
        (player.status && player.status !== "a") ||
        !!player.news ||
        player.roleProfile?.confidence === "LOW" ||
        player.transferredRecently ||
        (player.roleProfile?.startProbability ?? 1) < 0.85 ||
        (starters.has(player.id) && player.price <= 6),
    ).length,
  );
  const vice = [...xi]
    .filter((p) => p.id !== captain?.id)
    .sort(
      (a, b) => horizonProjection(b, horizon) - horizonProjection(a, horizon),
    )[0];
  const issues = draftMode
    ? validateInitialSquad(squad)
    : validateSquad(squad, bank);
  const squadValue = squad.reduce((sum, p) => sum + p.price, 0);
  const totalScore = projectedTeamScore(
    horizon,
    squad,
    captain?.id,
    vice?.id,
  ).total;
  const posCounts = {
    GK: squad.filter((p) => p.position === "GK").length,
    DEF: squad.filter((p) => p.position === "DEF").length,
    MID: squad.filter((p) => p.position === "MID").length,
    FWD: squad.filter((p) => p.position === "FWD").length,
  };

  return (
    <div className="content my-team-page">
      <section className="panel recommend-card primary-recommend team-verdict">
        <div className="card-top">
          <span className="label">THIS WEEK'S VERDICT</span>
          <span className={"pill " + (decision.roll ? "green" : "amber")}>
            {draftMode
              ? draftPlan
                ? "DRAFT IMPROVEMENT"
                : "DRAFT OPTIMISED"
              : decision.roll
                ? "ROLL TRANSFER"
                : "RECOMMENDED MOVE"}
          </span>
        </div>
        <h2>
          {draftMode
            ? draftPlan
              ? `Re-optimise ${draftPlan.changes.length} squad places`
              : "No better £100m structure found"
            : weakest
              ? `${weakest.out.name} → ${weakest.in.name}`
              : "Roll your transfer"}
        </h2>
        <p className="recommend-gain">
          {draftMode
            ? draftPlan
              ? `+${draftPlan.gain} lineup-aware objective points over ${horizon} GWs`
              : "The whole-squad search preserved your locks and respected the hard budget cap."
            : weakest
              ? `+${weakest.net} projected points over ${horizon} GWs`
              : `No direct swap clears the ${TRANSFER_GAIN_THRESHOLDS[(horizon >= 5 ? 5 : horizon >= 3 ? 3 : 1) as 1 | 3 | 5].toFixed(1)}-point threshold.`}
        </p>
        <div className="recommend-meta">
          <span>
            {draftMode
              ? "Unlimited GW1 edits"
              : `${freeTransfers} free transfer${freeTransfers === 1 ? "" : "s"}`}
          </span>
          <span>£{bank.toFixed(1)}m in bank</span>
          <span>{horizon}-GW horizon</span>
        </div>
        {weakest && !draftMode && (
          <div className="recommend-actions">
            <button className="dark-btn" onClick={() => onWhy(weakest)}>
              Why this move? <ArrowRight size={14} />
            </button>
            <button className="ghost-btn" onClick={() => setTab("Transfers")}>
              Compare transfers
            </button>
          </div>
        )}
        {draftMode && draftPlan && (
          <div style={{ marginTop: "14px" }}>
            <div className="recommend-actions">
              <button className="dark-btn" onClick={onApplyDraft}>
                Apply full restructure (+{draftPlan.gain} pts)
              </button>
              <button className="ghost-btn" onClick={() => setTab("Transfers")}>
                Review all changes
              </button>
            </div>
            {legalBundles.length > 0 && onApplyBundle && (
              <div className="bundle-card-list">
                <span className="label" style={{ fontSize: "10px", marginTop: "12px", display: "block" }}>
                  LEGAL BUDGET-LINKED CHANGE BUNDLES
                </span>
                {legalBundles.map((bundle: DraftChangeBundle) => (
                  <div key={bundle.id} className="bundle-card">
                    <div className="bundle-card-info">
                      <span className="bundle-card-title">{bundle.label}</span>
                      <span className="bundle-card-meta">
                        +{bundle.netGain} pts · Cost: {bundle.netCost > 0 ? `+£${bundle.netCost}m` : `£${bundle.netCost}m`}
                      </span>
                    </div>
                    <button className="ghost-btn" onClick={() => onApplyBundle(bundle)}>
                      Apply bundle
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
      <div className="hero-grid" style={{ marginBottom: "20px" }}>
        <div className="hero-card">
          <div className="card-top">
            <span className="label">PLANNED SQUAD VALUE</span>
            <span className="pill green">£{bank.toFixed(1)}m in bank</span>
          </div>
          <div className="big-number">
            £{squadValue.toFixed(1)}
            <small>m</small>
          </div>
          <div className="bar-labels" style={{ marginTop: "12px" }}>
            <span>
              Squad size: <b>{squad.length}/15</b>
            </span>
            <span>
              Structure:{" "}
              <b>
                {posCounts.GK}GK · {posCounts.DEF}DEF · {posCounts.MID}MID ·{" "}
                {posCounts.FWD}FWD
              </b>
            </span>
          </div>
        </div>
        <div className="recommend-card">
          <div className="card-top">
            <span className="label">STARTING XI PROJECTION</span>
            <span className="pill green">{horizon} GW Horizon</span>
          </div>
          <div className="big-number">
            {totalScore.toFixed(1)} <small>pts</small>
          </div>
          <div className="rec-foot" style={{ marginTop: "8px" }}>
            <span>
              Captain: <b>{captain?.name || "—"}</b> · Vice:{" "}
              <b>{vice?.name || "—"}</b>
            </span>
          </div>
        </div>
      </div>
      <section className="main-grid" style={{ marginBottom: "24px" }}>
        <div className="panel squad-panel">
          <div className="panel-head">
            <div>
              <h2>Recommended XI & Bench</h2>
              <p>Model-selected lineup for the next {horizon} GW(s)</p>
            </div>
            <button className="text-btn" onClick={onEdit}>
              Edit planned squad <ArrowRight size={14} />
            </button>
          </div>
          <div className="pitch">
            {["GK", "DEF", "MID", "FWD"].map((pos) => (
              <div className="pitch-row" key={pos}>
                {xi
                  .filter((p) => p.position === pos)
                  .map((p) => (
                    <button
                      className="player-chip"
                      onClick={() => onSelectPlayer(p)}
                      key={p.id}
                    >
                      <span className="shirt" style={{ background: getPlayerShirtColor(p) }}>
                        {p.position}
                      </span>
                      <span>
                        <b>{p.name}</b>
                        <small>
                          {p.club} · £{p.price.toFixed(1)}m
                        </small>
                      </span>
                      <strong>
                        {horizonProjection(p, horizon).toFixed(1)}
                      </strong>
                    </button>
                  ))}
              </div>
            ))}
          </div>
          <div className="bench">
            <span>BENCH ORDER</span>
            {bench.map((p) => (
              <button
                className="player-chip sub"
                onClick={() => onSelectPlayer(p)}
                key={p.id}
              >
                <span className="shirt" style={{ background: getPlayerShirtColor(p) }}>
                  {p.position}
                </span>
                <span>
                  <b>{p.name}</b>
                  <small>
                    {p.club} · £{p.price.toFixed(1)}m
                  </small>
                </span>
                <strong>{horizonProjection(p, horizon).toFixed(1)}</strong>
              </button>
            ))}
          </div>
        </div>
        <div className="side-stack">
          <div className="panel captain-card">
            <div className="panel-head">
              <div>
                <h2>Armband Roles</h2>
                <p>Captain & Vice Captain</p>
              </div>
              <Trophy className="gold" size={20} />
            </div>
            <div className="captain" style={{ marginBottom: "10px" }}>
              <div className="captain-badge">C</div>
              <div>
                <b>{captain?.name}</b>
                <small>
                  Captain ·{" "}
                  {captain
                    ? (horizonProjection(captain, horizon) * 2).toFixed(1)
                    : "0"}{" "}
                  pts (2× multiplier)
                </small>
              </div>
              <span>2×</span>
            </div>
            <div className="captain vice">
              <div className="captain-badge">V</div>
              <div>
                <b>{vice?.name}</b>
                <small>
                  Vice-captain ·{" "}
                  {vice ? horizonProjection(vice, horizon).toFixed(1) : "0"}{" "}
                  base pts
                </small>
              </div>
            </div>
          </div>
          <div className="panel priority-card squad-health">
            <div className="panel-head">
              <div>
                <h2>Squad Rules & Health</h2>
                <p>
                  {issues.length ? "Attention needed" : "All rules compliant"}
                </p>
              </div>
              <Shield size={19} />
            </div>
            {issues.length ? (
              <>
                <p style={{ color: "#ef4444", fontSize: "13px" }}>
                  {issues[0].detail}
                </p>
                <button className="text-btn" onClick={onEdit}>
                  Fix squad <ArrowRight size={14} />
                </button>
              </>
            ) : (
              <p className="health-ok">
                ✓ 15-player squad legal · Max 3 per club ok
              </p>
            )}
          </div>
        </div>
      </section>
      <EvidencePanel
        squad={squad}
        horizon={horizon}
        auditTargetCount={auditTargetCount}
        result={challenge}
        loading={challengeLoading}
        error={challengeError}
        rawOutput={challengeRawOutput}
        outputTypes={challengeOutputTypes}
        onChallenge={onChallenge}
        onReviewSignal={onReviewSignal}
        stagedSignalReviews={stagedSignalReviews}
        onUnstageSignal={onUnstageSignal}
        onSelectPlayer={onSelectPlayer}
        setTab={setTab}
        onManualOverride={onManualOverride}
        onReplacePlayer={onReplacePlayer}
      />
      <div className="panel table squad-table" style={{ marginTop: "20px" }}>
        <div className="panel-head" style={{ padding: "16px 20px 0" }}>
          <div>
            <h2>Full Squad Roster ({squad.length}/15)</h2>
            <p>Click any player to view detailed breakdown & projections</p>
          </div>
        </div>
        <div className="tr th squad-roster-tr" style={{ marginTop: "12px" }}>
          <span>PLAYER</span>
          <span>SQUAD ROLE</span>
          <span>FIXTURES</span>
          <span className="th-right">FORM</span>
          <span className="th-right">MINUTES</span>
          <span className="th-right">{horizon}-GW PROJ.</span>
          <span className="th-right">VALUE</span>
        </div>
        {squad.map((p) => {
          const isStarter = starters.has(p.id);
          const isCapt = p.id === captain?.id;
          const isVice = p.id === vice?.id;
          return (
            <button
              className="tr player-row squad-roster-tr"
              onClick={() => onSelectPlayer(p)}
              key={p.id}
            >
              <div className="name-cell">
                <span className="mini-shirt" style={{ background: getPlayerShirtColor(p) }}>
                  {p.position}
                </span>
                <div>
                  <b>{p.name}</b>
                  <small>
                    {p.club} · £{p.price.toFixed(1)}m
                  </small>
                </div>
              </div>
              <span className="role-cell">
                {isCapt ? (
                  <span className="price-pill green">Captain (C)</span>
                ) : isVice ? (
                  <span className="price-pill amber">Vice (V)</span>
                ) : isStarter ? (
                  <span className="price-pill">Starter</span>
                ) : (
                  <span className="price-pill red">Bench</span>
                )}
              </span>
              <span className="fixture fixture-strip">
                {getPlayerUpcomingFixtures(p, horizon).map((f, idx) => (
                  <span
                    key={`${f.gameweek}-${f.opponent}-${idx}`}
                    className={`fdr-pill fdr-${f.difficulty}`}
                    title={`GW${f.gameweek}: vs ${f.opponent} (${f.venue}) - FDR ${f.difficulty}`}
                  >
                    {f.opponent} ({f.venue})
                  </span>
                ))}
              </span>
              <span className="col-numeric">{p.form.toFixed(1)}</span>
              <span className="col-numeric">{p.minutes}%</span>
              <span className="col-numeric col-proj">
                <b>{horizonProjection(p, horizon).toFixed(1)}</b> pts
              </span>
              <span className="value col-numeric">
                {(horizonProjection(p, horizon) / p.price).toFixed(2)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SignalsTab({
  catalog,
  currentGameweek,
  onSelectPlayer,
  onReviewSignal,
  stagedSignalReviews,
  onUnstageSignal,
  onApplyBatch,
  applyingBatch,
}: {
  catalog: Player[];
  currentGameweek: number;
  onSelectPlayer: (p: Player) => void;
  onReviewSignal: (signal: PlayerSignal, status: "VERIFIED" | "REJECTED") => void;
  stagedSignalReviews: Record<string, "VERIFIED" | "REJECTED">;
  onUnstageSignal: (signalId: string | number) => void;
  onApplyBatch: () => void;
  applyingBatch: boolean;
}) {
  const [signals, setSignals] = useState<PlayerSignal[]>([]);
  const [marketSnapshots, setMarketSnapshots] = useState<TeamMarketSnapshot[]>([]);
  const [creatorClaims, setCreatorClaims] = useState<CreatorClaim[]>([]);
  const [claimSelections, setClaimSelections] = useState<Record<string, number>>({});
  const [claimReviewingId, setClaimReviewingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [playerQuery, setPlayerQuery] = useState("");
  const [ingestOpen, setIngestOpen] = useState(false);
  const [ingestText, setIngestText] = useState("");
  const [ingestUrl, setIngestUrl] = useState("");
  const [ingestLoading, setIngestLoading] = useState(false);
  const [ingestResult, setIngestResult] = useState<string | null>(null);
  const [signalConfig, setSignalConfig] = useState<SignalSourceConfig>({ ...DEFAULT_SIGNAL_SOURCE_CONFIG });
  const [configSaving, setConfigSaving] = useState(false);
  const [trustOpen, setTrustOpen] = useState(false);
  const ingestEndpoint = `${window.location.origin}/api/signals/ingest`;

  const playerMap = useMemo(() => {
    const m = new Map<number, Player>();
    catalog.forEach((p) => m.set(p.id, p));
    return m;
  }, [catalog]);

  const loadSignals = useCallback(() => {
    setLoading(true);
    fetchAllSignals({ limit: 300 })
      .then((s) => setSignals(s))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadCreatorClaims = useCallback(() => {
    fetchCreatorClaims().then((claims) => {
      setCreatorClaims(claims);
      setClaimSelections(Object.fromEntries(claims.map((claim) => [claim.id, claim.matchCandidates[0]?.playerId || 0])));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    loadSignals();
    loadCreatorClaims();
    fetchTeamMarketSnapshots().then(setMarketSnapshots).catch(() => {});
    fetchSignalConfig().then(setSignalConfig).catch(() => {});
  }, [loadSignals, loadCreatorClaims]);

  async function handleSaveConfig(updated: SignalSourceConfig) {
    setConfigSaving(true);
    try {
      const saved = await saveSignalConfig(updated);
      setSignalConfig(saved);
    } catch {}
    finally { setConfigSaving(false); }
  }

  const sourceTypes = useMemo(() => {
    const seen = new Set<string>();
    signals.forEach((s) => seen.add(s.sourceType));
    return Array.from(seen).sort();
  }, [signals]);

  const filtered = useMemo(() => {
    let result = signals;
    if (sourceFilter) result = result.filter((s) => s.sourceType === sourceFilter);
    if (statusFilter) result = result.filter((s) => s.status === statusFilter);
    if (playerQuery.trim()) {
      const q = playerQuery.trim().toLowerCase();
      result = result.filter((s) => {
        const p = playerMap.get(s.playerId);
        return (
          p?.name.toLowerCase().includes(q) ||
          s.evidenceSummary.toLowerCase().includes(q)
        );
      });
    }
    return result;
  }, [signals, sourceFilter, statusFilter, playerQuery, playerMap]);

  function relativeTime(iso: string) {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function sourceLabel(type: string) {
    return type.replace(/_/g, " ");
  }

  function sourceBadgeClass(type: string) {
    if (type === "YOUTUBE_TRANSCRIPT") return "source-badge youtube";
    if (type === "JOURNALIST") return "source-badge journalist";
    if (type === "LLM_RESEARCH") return "source-badge llm";
    if (type === "OFFICIAL_FPL" || type === "OFFICIAL_PL" || type === "OFFICIAL_CLUB") return "source-badge official";
    if (type === "PREDICTED_LINEUP") return "source-badge lineup";
    if (type === "SCRAPE") return "source-badge scrape";
    if (type === "MANUAL_OVERRIDE" || type === "USER_FEEDBACK") return "source-badge manual";
    return "source-badge";
  }

  function statusClass(status: string) {
    if (status === "VERIFIED") return "pill green";
    if (status === "REJECTED") return "pill red";
    if (status === "EXPIRED") return "pill";
    return "pill amber";
  }

  function marketPercent(value: number | null) {
    return value == null ? "—" : `${Math.round(value * 100)}%`;
  }

  function marketFavourite(snapshot: TeamMarketSnapshot) {
    const options = [
      { label: snapshot.homeTeam, value: snapshot.homeWinProb },
      { label: "Draw", value: snapshot.drawProb },
      { label: snapshot.awayTeam, value: snapshot.awayWinProb },
    ].filter((option): option is { label: string; value: number } => option.value != null);
    return options.sort((left, right) => right.value - left.value)[0];
  }

  function handleReview(signal: PlayerSignal, status: "VERIFIED" | "REJECTED") {
    onReviewSignal(signal, status);
  }

  async function handleIngest() {
    if (!ingestText.trim()) return;
    setIngestLoading(true);
    setIngestResult(null);
    try {
      const result = await ingestSignalText({
        text: ingestText,
        sourceUrl: ingestUrl || undefined,
      });
      if (result.created === 0) {
        setIngestResult("No players found in that text. Try including player names.");
      } else {
        setIngestResult(
          `✓ Created ${result.created} pending signal${result.created === 1 ? "" : "s"} for: ${result.signals
            .map((s) => playerMap.get(s.playerId)?.name || `Player #${s.playerId}`)
            .join(", ")}`
        );
        setIngestText("");
        setIngestUrl("");
        loadSignals();
      }
    } catch (e) {
      setIngestResult(`Error: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setIngestLoading(false);
    }
  }

  const pendingCount = signals.filter((s) => s.status === "PENDING").length;
  const unresolvedClaims = creatorClaims.filter((claim) => claim.matchStatus === "UNRESOLVED" || claim.matchStatus === "AMBIGUOUS");

  async function handleResolveClaim(claim: CreatorClaim) {
    const playerId=claimSelections[claim.id];
    if(!playerId)return;
    setClaimReviewingId(claim.id);
    try {
      await resolveCreatorClaim(claim.id,playerId,true);
      loadCreatorClaims();loadSignals();
    } finally { setClaimReviewingId(null); }
  }

  async function handleDismissClaim(claim: CreatorClaim) {
    setClaimReviewingId(claim.id);
    try { await dismissCreatorClaim(claim.id); loadCreatorClaims(); }
    finally { setClaimReviewingId(null); }
  }


  return (
    <div className="content signals-page">
      <div className="page-intro">
        <p>
          All intelligence flowing into the model — YouTube transcripts, scrapes, pundit tips, and
          AI research findings. Review pending signals to update player projections.
        </p>
        {pendingCount > 0 && (
          <span className="pill amber" style={{ fontSize: "13px" }}>
            {pendingCount} pending review
          </span>
        )}
      </div>

      {unresolvedClaims.length > 0 && (
        <section className="claim-review-panel">
          <div className="claim-review-heading">
            <div><b>Names needing review</b><p>{unresolvedClaims.length} transcript claim{unresolvedClaims.length === 1 ? "" : "s"} could not be linked safely.</p></div>
          </div>
          {unresolvedClaims.map((claim) => (
            <article className="claim-review-row" key={claim.id}>
              <div className="claim-review-copy">
                <span className="pill amber">{claim.matchStatus}</span>
                <b>“{claim.rawPlayerName}”</b>
                <span>{claim.creator} · {claim.category}{claim.clubHint ? ` · club hint ${claim.clubHint}` : ""}</span>
                <p>{claim.summary}</p>
              </div>
              <div className="claim-review-actions">
                <select value={claimSelections[claim.id] || 0} onChange={(event)=>setClaimSelections((current)=>({...current,[claim.id]:Number(event.target.value)}))}>
                  <option value={0}>Choose player…</option>
                  {catalog.map((player)=><option key={player.id} value={player.id}>{player.name} · {player.club} · {player.position}</option>)}
                </select>
                <button className="dark-btn" disabled={!claimSelections[claim.id] || claimReviewingId===claim.id} onClick={()=>handleResolveClaim(claim)}>Link & create evidence</button>
                <button className="ghost-btn" disabled={claimReviewingId===claim.id} onClick={()=>handleDismissClaim(claim)}>Dismiss</button>
              </div>
            </article>
          ))}
        </section>
      )}

      <section className="market-context-panel">
        <div className="market-context-heading">
          <div>
            <span className="eyebrow">MARKET CONTEXT</span>
            <h2>Match outlook</h2>
            <p>Read-only bookmaker consensus. This data is not part of the evidence approval queue.</p>
          </div>
          <span className="market-context-source">The Odds API · de-vigged</span>
        </div>
        {marketSnapshots.length ? (
          <div className="market-context-grid">
            {marketSnapshots.map((snapshot) => {
              const favourite = marketFavourite(snapshot);
              return (
                <article className="market-context-card" key={`${snapshot.externalEventId}-${snapshot.capturedAt}`}>
                  <div className="market-context-fixture">
                    <b>{snapshot.homeTeam}</b><span>vs</span><b>{snapshot.awayTeam}</b>
                  </div>
                  <div className="market-context-kickoff">
                    {snapshot.kickoff ? new Date(snapshot.kickoff).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Kickoff pending"}
                  </div>
                  <div className="market-probabilities">
                    <span><small>HOME</small><strong>{marketPercent(snapshot.homeWinProb)}</strong></span>
                    <span><small>DRAW</small><strong>{marketPercent(snapshot.drawProb)}</strong></span>
                    <span><small>AWAY</small><strong>{marketPercent(snapshot.awayWinProb)}</strong></span>
                  </div>
                  <div className="market-context-favourite">Favourite: <b>{favourite?.label || "Unavailable"}</b>{favourite ? ` · ${marketPercent(favourite.value)}` : ""}</div>
                  <div className="market-context-updated">Updated {relativeTime(snapshot.capturedAt)}</div>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="market-context-empty">No odds snapshots available. Run <code>npm run ingest:signals</code> with <code>ODDS_API_KEY</code> configured.</p>
        )}
      </section>

      {/* Filter bar */}
      <div className="signals-filter-bar">
        <div className="filter-chips">
          <button
            className={`filter-chip${!sourceFilter ? " active" : ""}`}
            onClick={() => setSourceFilter("")}
          >
            All sources
          </button>
          {sourceTypes.map((t) => (
            <button
              key={t}
              className={`filter-chip${sourceFilter === t ? " active" : ""}`}
              onClick={() => setSourceFilter(sourceFilter === t ? "" : t)}
            >
              <span className={sourceBadgeClass(t)} />
              {sourceLabel(t)}
            </button>
          ))}
        </div>
        <div className="filter-chips">
          {(["", "PENDING", "VERIFIED", "REJECTED", "EXPIRED"] as const).map((s) => (
            <button
              key={s}
              className={`filter-chip${statusFilter === s ? " active" : ""}`}
              onClick={() => setStatusFilter(s)}
            >
              {s || "All statuses"}
            </button>
          ))}
        </div>
        <div className="signals-search">
          <input
            type="search"
            placeholder="Filter by player or keyword…"
            value={playerQuery}
            onChange={(e) => setPlayerQuery(e.target.value)}
            className="signals-search-input"
          />
        </div>
      </div>

      {/* n8n info card */}
      <div className="n8n-info-card">
        <div className="n8n-info-icon">📡</div>
        <div>
          <b>n8n creator-signal ingestion</b>
          <p>
            Send structured creator/video metadata and a <code>claims[]</code> array from n8n. The request requires <code>Authorization: Bearer $SIGNAL_INGEST_TOKEN</code>. Names are linked using club, position, price, and remembered aliases; evidence is created as{" "}
            <span className="pill amber" style={{ fontSize: "11px", padding: "1px 6px" }}>PENDING</span>{" "}
            unless the source is set to auto-approve below.
          </p>
          <div className="n8n-endpoint-row">
            <code className="n8n-endpoint">{ingestEndpoint}</code>
            <button
              className="ghost-btn"
              style={{ fontSize: "12px", padding: "4px 10px" }}
              onClick={() => navigator.clipboard.writeText(ingestEndpoint)}
            >
              Copy
            </button>
          </div>
        </div>
      </div>

      {/* Source trust settings */}
      <div className="ingest-drawer">
        <button
          className={`ingest-toggle${trustOpen ? " open" : ""}`}
          onClick={() => setTrustOpen(!trustOpen)}
        >
          <span>⚙ Source trust settings</span>
          <span className="ingest-toggle-chevron">{trustOpen ? "▲" : "▼"}</span>
        </button>
        {trustOpen && (
          <div className="ingest-body">
            <p className="muted" style={{ fontSize: "13px", marginBottom: "12px" }}>
              Auto-approve sources you trust to bypass manual review. Signals with confidence below the threshold stay PENDING.
            </p>
            <div className="trust-table">
              <div className="trust-table-header">
                <span>Source</span>
                <span>Auto-approve</span>
                <span>Min. confidence</span>
              </div>
              {Object.entries(signalConfig).map(([sourceType, entry]) => (
                <div key={sourceType} className="trust-table-row">
                  <span className="trust-source-label">
                    <span className={`source-badge ${
                      sourceType === "YOUTUBE_TRANSCRIPT" ? "youtube" :
                      sourceType === "JOURNALIST" ? "journalist" :
                      sourceType === "LLM_RESEARCH" ? "llm" :
                      sourceType.startsWith("OFFICIAL") ? "official" :
                      sourceType === "PREDICTED_LINEUP" ? "lineup" :
                      sourceType === "SCRAPE" ? "scrape" : "manual"
                    }`} style={{ width: 18, height: 18 }} />
                    {sourceType.replace(/_/g, " ")}
                  </span>
                  <span>
                    <label className="trust-toggle">
                      <input
                        type="checkbox"
                        checked={entry.autoApprove}
                        disabled={sourceType === "MANUAL_OVERRIDE"}
                        onChange={(e) => {
                          const updated = {
                            ...signalConfig,
                            [sourceType]: { ...entry, autoApprove: e.target.checked },
                          };
                          handleSaveConfig(updated);
                        }}
                      />
                      <span className="trust-toggle-track" />
                    </label>
                  </span>
                  <span className="trust-threshold-cell">
                    <input
                      type="range"
                      min={0} max={100} step={5}
                      value={Math.round(entry.confidenceThreshold * 100)}
                      className="trust-threshold-slider"
                      disabled={sourceType === "MANUAL_OVERRIDE"}
                      onChange={(e) => {
                        const updated = {
                          ...signalConfig,
                          [sourceType]: { ...entry, confidenceThreshold: Number(e.target.value) / 100 },
                        };
                        setSignalConfig(updated);
                      }}
                      onMouseUp={() => handleSaveConfig(signalConfig)}
                      onTouchEnd={() => handleSaveConfig(signalConfig)}
                    />
                    <span className="trust-threshold-label">
                      {Math.round(entry.confidenceThreshold * 100)}%
                    </span>
                  </span>
                </div>
              ))}
            </div>
            {configSaving && <p className="muted" style={{ fontSize: "12px", marginTop: "8px" }}>Saving…</p>}
          </div>
        )}
      </div>

      {/* Quick-add panel */}
      <div className="ingest-drawer">
        <button
          className={`ingest-toggle${ingestOpen ? " open" : ""}`}
          onClick={() => setIngestOpen(!ingestOpen)}
        >
          <span>✏ Add signal manually</span>
          <span className="ingest-toggle-chevron">{ingestOpen ? "▲" : "▼"}</span>
        </button>
        {ingestOpen && (
          <div className="ingest-body">
            <p className="muted" style={{ fontSize: "13px", marginBottom: "10px" }}>
              Paste a quote, tweet, article excerpt, or note. Player names will be auto-resolved.
            </p>
            <textarea
              className="ingest-textarea"
              placeholder="e.g. 'Salah is a doubt for the weekend, Klopp says he trained lightly today…'"
              value={ingestText}
              onChange={(e) => setIngestText(e.target.value)}
              rows={4}
            />
            <input
              type="url"
              className="ingest-url-input"
              placeholder="Source URL (optional)"
              value={ingestUrl}
              onChange={(e) => setIngestUrl(e.target.value)}
            />
            {ingestResult && (
              <p
                className={`ingest-result${ingestResult.startsWith("✓") ? " success" : " error"}`}
              >
                {ingestResult}
              </p>
            )}
            <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
              <button
                className="dark-btn"
                onClick={handleIngest}
                disabled={ingestLoading || !ingestText.trim()}
              >
                {ingestLoading ? "Resolving…" : "Create signal"}
              </button>
              <button className="ghost-btn" onClick={() => { setIngestText(""); setIngestUrl(""); setIngestResult(null); }}>
                Clear
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Feed */}
      {loading ? (
        <div className="signal-feed-empty">
          <div className="loading-dot-row">
            <span /><span /><span />
          </div>
          <p className="muted">Loading signals…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="signal-feed-empty">
          <p className="muted">
            {signals.length === 0
              ? "No signals yet. Run a Squad Challenge or connect your n8n workflow to start ingesting intelligence."
              : "No signals match the current filters."}
          </p>
        </div>
      ) : (
        <div className="signal-feed">
          {filtered.map((signal) => {
            const player = playerMap.get(signal.playerId);
            const rawProb = signal.value?.startProbability;
            const normProb = typeof rawProb === "number" ? (rawProb > 1 ? rawProb / 100 : rawProb) : null;
            const proposedProb = normProb !== null ? Math.round(normProb * 100) : null;
            const stagedStatus = stagedSignalReviews[signal.id];
            const effectiveStatus = stagedStatus || signal.status;

            return (
              <article key={signal.id} className={`signal-card status-${effectiveStatus.toLowerCase()}${stagedStatus ? " is-staged" : ""}`}>
                <div className="signal-card-header">
                  <div className="signal-source-group">
                    <span className={sourceBadgeClass(signal.sourceType)}>
                      {signal.sourceType === "YOUTUBE_TRANSCRIPT" ? "▶" :
                       signal.sourceType === "LLM_RESEARCH" ? "✦" :
                       signal.sourceType === "JOURNALIST" ? "📰" :
                       signal.sourceType === "PREDICTED_LINEUP" ? "☰" :
                       signal.sourceType === "SCRAPE" ? "⬇" :
                       signal.sourceType === "OFFICIAL_FPL" ? "⚽" :
                       signal.sourceType === "MANUAL_OVERRIDE" ? "✎" : "◉"}
                    </span>
                    <span className="signal-source-label">{sourceLabel(signal.sourceType)}</span>
                  </div>
                  <div className="signal-meta-right">
                    <span className="signal-time">{relativeTime(signal.observedAt)}</span>
                    <span className={stagedStatus ? `staged-pill ${stagedStatus === "REJECTED" ? "rejected" : ""}` : statusClass(effectiveStatus)}>
                      {stagedStatus ? `STAGED: ${stagedStatus === "VERIFIED" ? "APPROVE" : "REJECT"}` : effectiveStatus === "VERIFIED" ? "✓ APPROVED" : effectiveStatus}
                    </span>
                  </div>
                </div>

                <div className="signal-card-body">
                  {player ? (
                    <button
                      className="signal-player-chip"
                      onClick={() => onSelectPlayer(player)}
                    >
                      <b>{player.name}</b>
                      <span className="signal-player-meta">
                        {player.position} · {player.club}
                      </span>
                    </button>
                  ) : (
                    <span className="signal-player-chip unknown">
                      Player #{signal.playerId}
                    </span>
                  )}
                  <p className="signal-evidence">{signal.evidenceSummary}</p>
                  <div className="signal-footer">
                    <span className="signal-confidence">
                      {Math.round(signal.confidence * 100)}% confidence
                      {proposedProb !== null ? ` · proposed start chance ${proposedProb}%` : ""}
                      {signal.gameweek ? ` · GW${signal.gameweek}` : ""}
                    </span>
                    {sanitizeExternalUrl(signal.sourceUrl) && (
                      <a
                        href={sanitizeExternalUrl(signal.sourceUrl)!}
                        target="_blank"
                        rel="noreferrer"
                        className="signal-source-link"
                      >
                        Source ↗
                      </a>
                    )}
                  </div>
                </div>

                {stagedStatus ? (
                  <div className="signal-actions">
                    <span className={`staged-pill ${stagedStatus === "REJECTED" ? "rejected" : ""}`}>STAGED: {stagedStatus === "VERIFIED" ? "APPROVE" : "REJECT"}</span>
                    <button className="undo-staged-btn" onClick={() => onUnstageSignal(signal.id)}>Undo</button>
                  </div>
                ) : signal.status === "PENDING" && (
                  <div className="signal-actions">
                    <button
                      className="dark-btn"
                      disabled={applyingBatch}
                      onClick={() => handleReview(signal, "VERIFIED")}
                    >
                      ✓ Approve evidence
                    </button>
                    <button
                      className="ghost-btn"
                      disabled={applyingBatch}
                      onClick={() => handleReview(signal, "REJECTED")}
                    >
                      Reject
                    </button>
                  </div>
                )}
                {!stagedStatus && effectiveStatus === "VERIFIED" && (
                  <div className="signal-actions">
                    <button
                      className="ghost-btn"
                      disabled={applyingBatch}
                      onClick={() => handleReview(signal, "REJECTED")}
                    >
                      Remove evidence
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── SignalRiskStrip ────────────────────────────────────────────────────────────
function SignalRiskStrip({ players }: { players: Player[] }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const atRisk = players.filter(
    (p) => (p.roleProfile?.derivedFromSignalIds?.length ?? 0) > 0 && (p.roleProfile?.startProbability ?? 1) < 0.6
  );
  if (!atRisk.length) return null;
  return (
    <div className="signal-risk-strip">
      <span className="signal-risk-strip-icon">◉</span>
      <div className="signal-risk-strip-body">
        <b>Signal minute risk detected</b>
        <p>
          {atRisk.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ", "}
              <b>{p.name}</b>{" "}
              <span className="signal-risk-pct">
                ({Math.round((p.roleProfile?.startProbability ?? 0) * 100)}% start)
              </span>
            </span>
          ))}{" "}
          — projections already reduced. Consider replacing these players.
        </p>
      </div>
      <button
        className="ghost-btn"
        style={{ fontSize: "11px", padding: "3px 8px", flexShrink: 0 }}
        onClick={() => setDismissed(true)}
      >
        Dismiss
      </button>
    </div>
  );
}

function LeaguesView({
  fplAccount,
  currentGameweek,
  catalog,
  userSquad,
  onSyncAccount,
}: {
  fplAccount: FplAccount | null;
  currentGameweek: number;
  catalog: Player[];
  userSquad: Player[];
  onSyncAccount?: (id?: number) => void;
}) {
  const [fetchedLeagues, setFetchedLeagues] = useState<FplLeagueSummary[]>([]);
  const [discoveringLeagues, setDiscoveringLeagues] = useState<boolean>(false);
  const autoDiscoveryAttemptRef = useRef<string | null>(null);
  const [teamInput, setTeamInput] = useState<string>("");

  const [savedDefaultId, setSavedDefaultId] = useState<number | null>(null);

  useEffect(() => {
    getUserProfile().then(({ preferences }) => {
      setSavedDefaultId(preferences?.defaultLeagueId ?? null);
    }).catch(() => {});
  }, []);

  const userLeagues = useMemo(() => {
    if (fplAccount?.leagues?.classic && fplAccount.leagues.classic.length > 0) {
      return fplAccount.leagues.classic;
    }
    return fetchedLeagues;
  }, [fplAccount, fetchedLeagues]);

  const initialLeagueId = useMemo(() => {
    if (savedDefaultId && userLeagues.some((lg) => lg.id === savedDefaultId)) {
      return savedDefaultId;
    }
    return userLeagues.length > 0 ? userLeagues[0].id : null;
  }, [savedDefaultId, userLeagues]);

  const [selectedLeagueId, setSelectedLeagueId] = useState<number | null>(initialLeagueId);
  const [customLeagueInput, setCustomLeagueInput] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<LeagueDetailsResponse | null>(null);
  const [subTab, setSubTab] = useState<"standings" | "eo" | "chips">("standings");
  const [inspectingRival, setInspectingRival] = useState<LeagueRival | null>(null);
  const [searchFilter, setSearchFilter] = useState<string>("");
  const [eoFilter, setEoFilter] = useState<"all" | "owned" | "unowned" | "differentials">("all");

  const activeLeagueId = selectedLeagueId;

  // Auto-discover leagues if teamId exists in fplAccount but leagues array wasn't pre-loaded
  useEffect(() => {
    if (!fplAccount?.teamId || userLeagues.length > 0) return;

    const attemptKey = `${fplAccount.teamId}:${currentGameweek}`;
    if (autoDiscoveryAttemptRef.current === attemptKey) return;
    autoDiscoveryAttemptRef.current = attemptKey;

    let active = true;
    setDiscoveringLeagues(true);
    setError(null);
    fetchFplAccount(fplAccount.teamId, currentGameweek)
      .then((res) => {
        if (!active) return;
        const list = res.account.leagues?.classic ?? [];
        setFetchedLeagues(list);
        if (list.length === 0) {
          setError("No classic mini-leagues were found for this FPL account. You can still load one by League ID.");
          return;
        }
        setSelectedLeagueId((current) => {
          if (current) return current;
          return savedDefaultId && list.some((league) => league.id === savedDefaultId)
            ? savedDefaultId
            : list[0].id;
        });
      })
      .catch((reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Could not discover leagues for this FPL account.");
        }
      })
      .finally(() => {
        if (active) setDiscoveringLeagues(false);
      });

    return () => {
      active = false;
    };
  }, [fplAccount?.teamId, userLeagues.length, currentGameweek, savedDefaultId]);

  const loadLeague = useCallback(async (id: number) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchLeagueDetails(id, currentGameweek);
      setDetails(data);
    } catch (err) {
      setError((err as Error)?.message || "Failed to load league details.");
      setDetails(null);
    } finally {
      setLoading(false);
    }
  }, [currentGameweek]);

  useEffect(() => {
    if (activeLeagueId) {
      loadLeague(activeLeagueId);
    }
  }, [activeLeagueId, loadLeague]);

  // Handle case where user account updates or synced leagues load
  useEffect(() => {
    if (!selectedLeagueId && userLeagues.length > 0) {
      const def = savedDefaultId && userLeagues.some((x) => x.id === savedDefaultId) ? savedDefaultId : userLeagues[0].id;
      setSelectedLeagueId(def);
    }
  }, [userLeagues, selectedLeagueId, savedDefaultId]);

  const handleSetDefault = () => {
    if (selectedLeagueId) {
      void saveUserPreferences({ defaultLeagueId: selectedLeagueId });
      setSavedDefaultId(selectedLeagueId);
    }
  };

  const handleCustomSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInt(customLeagueInput.trim(), 10);
    if (parsed && !isNaN(parsed)) {
      setSelectedLeagueId(parsed);
    }
  };

  const handleDiscoverLeagues = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseTeamId(teamInput);
    if (parsed) {
      if (onSyncAccount) {
        onSyncAccount(parsed);
      }
      setDiscoveringLeagues(true);
      fetchFplAccount(parsed, currentGameweek).then((res) => {
        if (res.account.leagues?.classic) {
          setFetchedLeagues(res.account.leagues.classic);
          if (res.account.leagues.classic.length > 0) {
            setSelectedLeagueId(res.account.leagues.classic[0].id);
          }
        }
      }).catch((err) => {
        setError(err instanceof Error ? err.message : "Could not discover leagues for team ID");
      }).finally(() => setDiscoveringLeagues(false));
    } else {
      setError("Please enter a valid numeric FPL Team ID or team URL.");
    }
  };

  const userOwnedSet = useMemo(() => new Set(userSquad.map(p => p.id)), [userSquad]);

  const enrichedEOList = useMemo(() => {
    if (!details?.effectiveOwnership) return [];
    return details.effectiveOwnership.map((item) => {
      const player = catalog.find((p) => p.id === item.element);
      const isUserOwned = userOwnedSet.has(item.element);
      let statusTag: "User Differential" | "Shared Asset" | "Rival Shield" | "Minor Asset" = "Minor Asset";
      if (isUserOwned && item.ownershipPercent < 40) {
        statusTag = "User Differential";
      } else if (isUserOwned && item.ownershipPercent >= 40) {
        statusTag = "Shared Asset";
      } else if (!isUserOwned && item.effectiveOwnership >= 50) {
        statusTag = "Rival Shield";
      }
      return {
        ...item,
        player,
        isUserOwned,
        statusTag,
      };
    });
  }, [details, catalog, userOwnedSet]);

  const filteredEOList = useMemo(() => {
    return enrichedEOList.filter((item) => {
      if (searchFilter) {
        const query = searchFilter.toLowerCase();
        const pName = item.player ? item.player.name.toLowerCase() : `player #${item.element}`;
        const pClub = item.player ? item.player.club.toLowerCase() : "";
        if (!pName.includes(query) && !pClub.includes(query)) return false;
      }
      if (eoFilter === "owned") return item.isUserOwned;
      if (eoFilter === "unowned") return !item.isUserOwned;
      if (eoFilter === "differentials") return item.isUserOwned && item.ownershipPercent < 40;
      return true;
    });
  }, [enrichedEOList, searchFilter, eoFilter]);

  const formatChipName = (chipName: string | null) => {
    if (!chipName) return null;
    const map: Record<string, { label: string; color: string }> = {
      wildcard: { label: "Wildcard", color: "#8b5cf6" },
      freehit: { label: "Free Hit", color: "#3b82f6" },
      bboost: { label: "Bench Boost", color: "#10b981" },
      "3xc": { label: "Triple Captain", color: "#f59e0b" },
      mysterycard: { label: "Mystery Chip", color: "#ec4899" },
    };
    return map[chipName.toLowerCase()] || { label: chipName, color: "#64748b" };
  };

  const getChipStatusForRival = (rival: LeagueRival, chipKey: "wc1" | "wc2" | "freehit" | "bboost" | "3xc") => {
    if (!rival.chipsUsed) return { used: false };
    if (chipKey === "wc1") {
      const found = rival.chipsUsed.find((c) => c.name === "wildcard" && c.event <= 19);
      return found ? { used: true, event: found.event } : { used: false };
    }
    if (chipKey === "wc2") {
      const found = rival.chipsUsed.find((c) => c.name === "wildcard" && c.event >= 20);
      return found ? { used: true, event: found.event } : { used: false };
    }
    const found = rival.chipsUsed.find((c) => c.name.toLowerCase() === chipKey);
    return found ? { used: true, event: found.event } : { used: false };
  };

  const isCurrentDefault = selectedLeagueId === savedDefaultId;

  return (
    <div className="leagues-container">
      {/* Header & Controls */}
      <div className="leagues-header">
        <div>
          <h2>Mini-League Intelligence</h2>
          <p className="subtitle">
            Track cash prize competitions, rival hits, chip burn, and league effective ownership.
          </p>
        </div>

        <div className="leagues-selector-bar">
          {userLeagues.length > 0 && (
            <div className="league-dropdown-group">
              <label className="league-dropdown-label">Select League:</label>
              <select
                value={selectedLeagueId || ""}
                onChange={(e) => setSelectedLeagueId(Number(e.target.value))}
                className="league-select-input"
              >
                {userLeagues.map((lg) => (
                  <option key={lg.id} value={lg.id}>
                    {lg.name} {lg.id === savedDefaultId ? "★ (Default)" : lg.entry_rank ? `(#${lg.entry_rank})` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`ghost-btn ${isCurrentDefault ? "active-default-btn" : ""}`}
                style={{ padding: "6px 10px", fontSize: "12px" }}
                onClick={handleSetDefault}
                disabled={!selectedLeagueId || isCurrentDefault}
                title="Save as Default League"
              >
                {isCurrentDefault ? "★ Default League" : "☆ Set as Default"}
              </button>
            </div>
          )}

          <form onSubmit={handleCustomSearch} className="league-search-form">
            <input
              type="number"
              placeholder="League ID..."
              value={customLeagueInput}
              onChange={(e) => setCustomLeagueInput(e.target.value)}
              className="league-id-input"
            />
            <button type="submit" className="dark-btn">Load League</button>
          </form>
        </div>
      </div>

      {(loading || discoveringLeagues) && (
        <div className="leagues-loading">
          <div className="spin" style={{ fontSize: "28px", color: "#3b82f6" }}>↻</div>
          <p>{discoveringLeagues ? "Discovering your mini-leagues..." : "Analyzing league rivals and calculating Effective Ownership..."}</p>
        </div>
      )}

      {error && (
        <div className="patch-card error-card" style={{ padding: "20px", marginTop: "16px" }}>
          <h4 style={{ margin: "0 0 8px 0" }}>Could not load league data</h4>
          <p style={{ margin: 0 }}>{error}</p>
        </div>
      )}

      {!loading && !discoveringLeagues && !error && !details && !selectedLeagueId && (
        <div className="patch-card" style={{ padding: "32px", textAlign: "center", marginTop: "20px" }}>
          <h3 style={{ margin: "0 0 8px 0" }}>Discover Your Mini-Leagues</h3>
          <p className="muted-text" style={{ maxWidth: "540px", margin: "0 auto 20px auto", fontSize: "14px" }}>
            Enter your FPL Team ID or team URL below to automatically load all your private mini-leagues, cash comps, live standings, rival hits, and effective ownership.
          </p>
          <form onSubmit={handleDiscoverLeagues} style={{ display: "flex", justifyContent: "center", gap: "10px", flexWrap: "wrap" }}>
            <input
              type="text"
              placeholder="e.g. 123456 or FPL team URL"
              value={teamInput}
              onChange={(e) => setTeamInput(e.target.value)}
              className="league-id-input"
              style={{ width: "260px" }}
            />
            <button type="submit" className="dark-btn">Discover My Leagues</button>
          </form>
        </div>
      )}

      {!loading && !error && details && (
        <>
          {/* Sub-tab Navigation */}
          <div className="leagues-subtabs" style={{ marginBottom: "16px" }}>
            <button
              className={`subtab-btn ${subTab === "standings" ? "active" : ""}`}
              onClick={() => setSubTab("standings")}
            >
              ♛ Standings ({details.standings.length})
            </button>
            <button
              className={`subtab-btn ${subTab === "eo" ? "active" : ""}`}
              onClick={() => setSubTab("eo")}
            >
              📊 Effective Ownership ({details.effectiveOwnership.length} players)
            </button>
            <button
              className={`subtab-btn ${subTab === "chips" ? "active" : ""}`}
              onClick={() => setSubTab("chips")}
            >
              ⚡ Rival Chip Matrix
            </button>
          </div>

          {details.isPreSeason && (
            <div className="preseason-banner" style={{ background: "rgba(59, 130, 246, 0.12)", border: "1px solid rgba(59, 130, 246, 0.3)", borderRadius: "10px", padding: "12px 16px", marginBottom: "16px", display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={{ fontSize: "20px" }}>🔒</span>
              <div>
                <b style={{ color: "#60a5fa", fontSize: "14px" }}>Pre-Season Mode (Gameweek 1 Deadline in 11 days)</b>
                <p style={{ margin: "2px 0 0 0", fontSize: "13px", color: "#cbd5e1" }}>
                  FPL hides rival team picks until the Gameweek 1 deadline. Standings display all <b>{details.standings.length} members</b> who have joined your league so far. Live points, transfers, chip burn, and Effective Ownership (EO) will calculate live once GW1 kicks off!
                </p>
              </div>
            </div>
          )}

          {/* Standings View */}
          {subTab === "standings" && (
            <div className="leagues-card">
              <div className="leagues-card-header">
                <div>
                  <h3>{details.league.name}</h3>
                  <span className="muted-text">Sampled {details.sampledManagerCount ?? details.totalAnalyzed} of {details.totalManagerCount ?? details.totalAnalyzed} managers</span>
                </div>
                <span className="badge-info">Gameweek {currentGameweek}</span>
              </div>
              <div className="table-responsive">
                <table className="standings-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Manager & Team</th>
                      <th>GW Transfers & Hits</th>
                      <th>Active Chip</th>
                      <th>GW Pts</th>
                      <th>Total Pts</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.standings.map((rival) => {
                      const isUser = rival.entry === fplAccount?.teamId;
                      const activeChipInfo = formatChipName(rival.activeChip);
                      const rankDiff = rival.last_rank ? rival.last_rank - rival.rank : 0;
                      return (
                        <tr key={rival.id} className={isUser ? "user-row" : ""}>
                          <td className="rank-col">
                            <span className="rank-num">#{rival.rank}</span>
                            {rankDiff > 0 && <span className="rank-up">▲{rankDiff}</span>}
                            {rankDiff < 0 && <span className="rank-down">▼{Math.abs(rankDiff)}</span>}
                          </td>
                          <td>
                            <div className="manager-info">
                              <b className="team-name">{rival.entry_name} {isUser && <span className="you-pill">You</span>}</b>
                              <span className="manager-name">{rival.player_name}</span>
                            </div>
                          </td>
                          <td>
                            <span className="transfers-badge">
                              {rival.eventTransfers} tfrs
                              {rival.eventTransfersCost > 0 && (
                                <span className="hit-badge"> (-{rival.eventTransfersCost} pts)</span>
                              )}
                            </span>
                          </td>
                          <td>
                            {activeChipInfo ? (
                              <span
                                className="chip-badge"
                                style={{ backgroundColor: activeChipInfo.color }}
                              >
                                {activeChipInfo.label}
                              </span>
                            ) : (
                              <span className="muted-text">-</span>
                            )}
                          </td>
                          <td className="gw-pts"><b>{rival.event_total}</b></td>
                          <td className="total-pts"><b>{rival.total}</b></td>
                          <td>
                            <button
                              className="ghost-btn"
                              style={{ padding: "4px 8px", fontSize: "12px" }}
                              onClick={() => setInspectingRival(rival)}
                              title="Inspect Rival Squad"
                            >
                              👁 Inspect
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Effective Ownership View */}
          {subTab === "eo" && (
            <div className="leagues-card">
              <div className="eo-banner">
                <div>
                  <h4 style={{ margin: "0 0 4px 0" }}>League Effective Ownership (EO)</h4>
                  <p className="muted-text" style={{ margin: 0, fontSize: "13px" }}>
                    Effective Ownership combines starting ownership + captaincy % + 2x Triple Captain % across the sampled managers; it is not league-wide unless every standings page is fetched.
                  </p>
                </div>
                <div className="eo-filters">
                  <input
                    type="text"
                    placeholder="Search player..."
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                    className="eo-search-input"
                  />
                  <select
                    value={eoFilter}
                    onChange={(e) => setEoFilter(e.target.value as any)}
                    className="eo-filter-select"
                  >
                    <option value="all">All Players</option>
                    <option value="owned">Owned by You</option>
                    <option value="unowned">Rival Owned Only</option>
                    <option value="differentials">Your Differentials</option>
                  </select>
                </div>
              </div>

              <div className="table-responsive">
                <table className="eo-table">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Position / Club</th>
                      <th>Status in League</th>
                      <th>Ownership %</th>
                      <th>Captaincy %</th>
                      <th>Effective Ownership (EO)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEOList.map((item) => {
                      const p = item.player;
                      return (
                        <tr key={item.element} className={item.isUserOwned ? "user-owned-row" : ""}>
                          <td>
                            <div className="player-cell">
                              <b>{p ? p.name : `Player #${item.element}`}</b>
                            </div>
                          </td>
                          <td>
                            <span className="muted-text">
                              {p ? `${p.position} · ${p.club}` : "FPL Player"}
                            </span>
                          </td>
                          <td>
                            <span className={`status-pill pill-${item.statusTag.toLowerCase().replace(/\s+/g, '-')}`}>
                              {item.statusTag}
                            </span>
                          </td>
                          <td>
                            <div className="bar-group">
                              <span>{item.ownershipPercent}%</span>
                              <div className="bar-bg">
                                <div className="bar-fill" style={{ width: `${Math.min(100, item.ownershipPercent)}%` }} />
                              </div>
                            </div>
                          </td>
                          <td>
                            <span>{item.captaincyPercent}%</span>
                          </td>
                          <td>
                            <div className="eo-value-badge">
                              <b>{item.effectiveOwnership}%</b>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Chip Matrix View */}
          {subTab === "chips" && (
            <div className="leagues-card">
              <div className="leagues-card-header">
                <div>
                  <h3>Rival Season Chip Usage</h3>
                  <p className="muted-text" style={{ margin: "4px 0 0 0", fontSize: "13px" }}>
                    Track which chips your rivals have already burned vs what they still hold.
                  </p>
                </div>
              </div>
              <div className="table-responsive">
                <table className="chip-table">
                  <thead>
                    <tr>
                      <th>Manager / Team</th>
                      <th>Wildcard 1</th>
                      <th>Wildcard 2</th>
                      <th>Free Hit</th>
                      <th>Bench Boost</th>
                      <th>Triple Captain</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.standings.map((rival) => {
                      const wc1 = getChipStatusForRival(rival, "wc1");
                      const wc2 = getChipStatusForRival(rival, "wc2");
                      const fh = getChipStatusForRival(rival, "freehit");
                      const bb = getChipStatusForRival(rival, "bboost");
                      const tc = getChipStatusForRival(rival, "3xc");
                      const isUser = rival.entry === fplAccount?.teamId;

                      const renderChipCell = (status: { used: boolean; event?: number }) => (
                        status.used ? (
                          <span className="chip-status-used">Used (GW{status.event})</span>
                        ) : (
                          <span className="chip-status-avail">Available</span>
                        )
                      );

                      return (
                        <tr key={rival.id} className={isUser ? "user-row" : ""}>
                          <td>
                            <b>{rival.player_name}</b>
                            <div className="muted-text">{rival.entry_name}</div>
                          </td>
                          <td>{renderChipCell(wc1)}</td>
                          <td>{renderChipCell(wc2)}</td>
                          <td>{renderChipCell(fh)}</td>
                          <td>{renderChipCell(bb)}</td>
                          <td>{renderChipCell(tc)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Rival Squad Inspection Modal */}
      {inspectingRival && (
        <div className="modal-overlay" onClick={() => setInspectingRival(null)}>
          <div className="modal-content rival-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 style={{ margin: 0 }}>{inspectingRival.entry_name}</h3>
                <p className="subtitle" style={{ margin: "2px 0 0 0" }}>
                  Manager: {inspectingRival.player_name} · Rank: #{inspectingRival.rank}
                </p>
              </div>
              <button className="ghost-btn icon-only" onClick={() => setInspectingRival(null)}>✕</button>
            </div>

            <div className="modal-body">
              <div className="rival-summary-strip">
                <div>
                  <small>GW Points</small>
                  <b>{inspectingRival.event_total} pts</b>
                </div>
                <div>
                  <small>Transfers Made</small>
                  <b>{inspectingRival.eventTransfers}</b>
                </div>
                <div>
                  <small>Hit Penalty</small>
                  <b style={{ color: inspectingRival.eventTransfersCost > 0 ? "#ef4444" : "inherit" }}>
                    -{inspectingRival.eventTransfersCost} pts
                  </b>
                </div>
                <div>
                  <small>Active Chip</small>
                  <b>{inspectingRival.activeChip || "None"}</b>
                </div>
              </div>

              <h4 style={{ margin: "16px 0 10px 0" }}>Lineup & Picks (GW {currentGameweek})</h4>
              <div className="rival-picks-list">
                {inspectingRival.picks.map((pick) => {
                  const p = catalog.find((item) => item.id === pick.element);
                  const isUserOwned = userOwnedSet.has(pick.element);
                  return (
                    <div
                      key={pick.element}
                      className={`rival-pick-card ${pick.position > 11 ? "bench-pick" : ""} ${isUserOwned ? "user-also-owns" : ""}`}
                    >
                      <div className="pick-main">
                        <span className="pick-pos">{pick.position <= 11 ? `XI` : `SUB`}</span>
                        <b className="pick-name">{p ? p.name : `Player #${pick.element}`}</b>
                        {pick.is_captain && <span className="captain-badge">C</span>}
                        {pick.is_vice_captain && <span className="captain-badge vc">V</span>}
                      </div>
                      <div className="pick-meta">
                        <span className="muted-text">{p ? `${p.position} · ${p.club}` : ""}</span>
                        {isUserOwned && <span className="shared-tag">✓ You own</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardV2({
  squad,
  xi,
  horizon,
  weakest,
  setTab,
  onEdit,
  onWhy,
  decision,
  captain,
  bank,
  freeTransfers,
  draftMode,
  draftPlan,
  legalBundles = [],
  onApplyDraft,
  onApplyBundle,
}: {
  squad: Player[];
  xi: Player[];
  horizon: number;
  weakest: Transfer | null;
  setTab: (s: string) => void;
  onEdit: () => void;
  onWhy: (t: Transfer) => void;
  decision: any;
  captain: Player | null;
  bank: number;
  freeTransfers: number;
  draftMode: boolean;
  draftPlan: DraftImprovementPlan | null;
  legalBundles?: DraftChangeBundle[];
  onApplyDraft: () => void;
  onApplyBundle?: (bundle: DraftChangeBundle) => void;
}) {
  const starters = new Set(xi.map((p) => p.id));
  const vice = [...xi]
    .filter((p) => p.position !== "GK" && p.id !== captain?.id)
    .sort(
      (a, b) => horizonProjection(b, horizon) - horizonProjection(a, horizon),
    )[0];
  const issues = draftMode
    ? validateInitialSquad(squad)
    : validateSquad(squad, bank);
  const score = xi.reduce((sum, p) => sum + horizonProjection(p, horizon), 0);
  const storedRanges = xi.map(player => player.storedForecast).filter((value): value is NonNullable<Player['storedForecast']> => Boolean(value && value.horizon === horizon));
  const outcomeRange = storedRanges.length === xi.length && xi.length > 0
    ? { p10: storedRanges.reduce((sum, value) => sum + value.p10Points, 0), p90: storedRanges.reduce((sum, value) => sum + value.p90Points, 0) }
    : null;
  return (
    <div className="content">
      <section className="decision-grid">
        <div className="recommend-card primary-recommend">
          <div className="card-top">
            <span className="label">THE VERDICT</span>
            <span className={"pill " + (decision.roll ? "green" : "amber")}>
              {draftMode
                ? draftPlan
                  ? "DRAFT IMPROVEMENT"
                  : "DRAFT OPTIMISED"
                : decision.roll
                  ? "ROLL TRANSFER"
                  : "RECOMMENDED MOVE"}
            </span>
          </div>
          <h2>
            {draftMode
              ? draftPlan
                ? `Re-optimise ${draftPlan.changes.length} squad places`
                : "No better £100m structure found"
              : weakest
              ? `Recommended: ${weakest.out.name} → ${weakest.in.name}`
              : "Recommended: Roll your transfer"}
          </h2>
          <p className="recommend-gain">
            {draftMode
              ? draftPlan
                ? `+${draftPlan.gain} lineup-aware objective points over ${horizon} GWs`
                : "The whole-squad search preserved your locks and respected the hard budget cap."
              : weakest
              ? `+${weakest.net} projected points over ${horizon} GWs`
              : `No direct swap clears the ${TRANSFER_GAIN_THRESHOLDS[(horizon >= 5 ? 5 : horizon >= 3 ? 3 : 1) as 1 | 3 | 5].toFixed(1)}-point threshold.`}
          </p>
          <div className="recommend-meta">
            <span>{draftMode ? "Unlimited GW1 edits" : freeTransfers === 0 ? "Hit required" : `${freeTransfers} free transfer${freeTransfers === 1 ? "" : "s"}`}</span>
            <span>£{bank.toFixed(1)}m left in bank</span>
            <span>{draftMode ? `${activeLockedIds.length} locked players` : `Confidence: ${weakest ? "High" : "Medium"}`}</span>
          </div>
          {weakest && (
            <div className="recommend-actions">
              <button className="dark-btn" onClick={() => onWhy(weakest)}>
                Why? <ArrowRight size={14} />
              </button>
              <button className="ghost-btn" onClick={() => setTab("Players")}>
                Compare
              </button>
            </div>
          )}
          {draftMode && draftPlan && (
            <div style={{ marginTop: "14px" }}>
              <div className="recommend-actions">
                <button className="dark-btn" onClick={onApplyDraft}>Apply full restructure (+{draftPlan.gain} pts)</button>
              </div>
              {legalBundles.length > 0 && onApplyBundle && (
                <div className="bundle-card-list">
                  <span className="label" style={{ fontSize: "10px", marginTop: "12px", display: "block" }}>
                    LEGAL BUDGET-LINKED CHANGE BUNDLES
                  </span>
                  {legalBundles.map((bundle) => (
                    <div key={bundle.id} className="bundle-card">
                      <div className="bundle-card-info">
                        <span className="bundle-card-title">{bundle.label}</span>
                        <span className="bundle-card-meta">
                          +{bundle.netGain} pts · Cost: {bundle.netCost > 0 ? `+£${bundle.netCost}m` : `£${bundle.netCost}m`}
                        </span>
                      </div>
                      <button className="ghost-btn" onClick={() => onApplyBundle(bundle)}>
                        Apply bundle
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="score-card hero-card">
          <span className="label">PROJECTED SCORE · {horizon} GWs</span>
          <div className="big-number">
            {score.toFixed(1)} <small>pts</small>
          </div>
          {outcomeRange && <p className="muted">Outcome range under current assumptions: {outcomeRange.p10.toFixed(1)}–{outcomeRange.p90.toFixed(1)} pts (p10–p90)</p>}
          <div className="score-bars">
            <span style={{ width: "74%" }} />
            <span style={{ width: "52%" }} />
            <span style={{ width: "35%" }} />
          </div>
          <div className="bar-labels">
            <span>
              Attack{" "}
              <b>
                {xi
                  .filter((p) => p.position === "FWD")
                  .reduce((n, p) => n + horizonProjection(p, horizon), 0)
                  .toFixed(1)}
              </b>
            </span>
            <span>
              Midfield{" "}
              <b>
                {xi
                  .filter((p) => p.position === "MID")
                  .reduce((n, p) => n + horizonProjection(p, horizon), 0)
                  .toFixed(1)}
              </b>
            </span>
            <span>
              Defence{" "}
              <b>
                {xi
                  .filter((p) => p.position === "DEF" || p.position === "GK")
                  .reduce((n, p) => n + horizonProjection(p, horizon), 0)
                  .toFixed(1)}
              </b>
            </span>
          </div>
        </div>
        <div className="captain-card panel priority-card">
          <div className="panel-head">
            <div>
              <h2>Captain</h2>
              <p>Best projected captain for {horizon} GW horizon</p>
            </div>
            <Trophy className="gold" size={20} />
          </div>
          <div className="captain">
            <div className="captain-badge">C</div>
            <div>
              <b>{captain?.name}</b>
              <small>
                {captain
                  ? `${horizonProjection(captain, horizon).toFixed(1)} base pts · 2× captain multiplier`
                  : ""}
              </small>
            </div>
            <span>2×</span>
          </div>
        </div>
        <div className="panel priority-card squad-health">
          <div className="panel-head">
            <div>
              <h2>Squad health</h2>
              <p>
                {issues.length
                  ? "Action needed before deadline"
                  : "No squad problems detected"}
              </p>
            </div>
            <Shield size={19} />
          </div>
          {issues.length ? (
            <>
              <p>{issues[0].detail}</p>
              <button className="text-btn" onClick={onEdit}>
                Fix squad <ArrowRight size={14} />
              </button>
            </>
          ) : (
            <p className="health-ok">
              {draftMode
                ? `✓ Legal GW1 squad · £${bank.toFixed(1)}m derived bank`
                : `✓ Legal 15-player squad · ${freeTransfers} free transfer${freeTransfers === 1 ? "" : "s"}`}
            </p>
          )}
        </div>
      </section>
      <section className="main-grid">
        <div className="panel squad-panel">
          <div className="panel-head">
            <div>
              <h2>Best XI</h2>
              <p>Optimised for the {horizon}-GW horizon</p>
            </div>
            <button className="text-btn" onClick={onEdit}>
              Edit team <ArrowRight size={14} />
            </button>
          </div>
          <div className="pitch">
            {["GK", "DEF", "MID", "FWD"].map((pos) => (
              <div className="pitch-row" key={pos}>
                {xi
                  .filter((p) => p.position === pos)
                  .map((p) => (
                    <button
                      className="player-chip"
                      onClick={() => setTab("Players")}
                      key={p.id}
                    >
                      <span className="shirt" style={{ background: getPlayerShirtColor(p) }}>
                        {p.position}
                      </span>
                      <span>
                        <b>{p.name}</b>
                        <small>
                          {p.club} · £{p.price.toFixed(1)}m
                        </small>
                      </span>
                      <strong>
                        {horizonProjection(p, horizon).toFixed(1)}
                      </strong>
                    </button>
                  ))}
              </div>
            ))}
          </div>
          <div className="bench">
            <span>BENCH ORDER</span>
            {benchOrder(horizon, squad, xi).map((p) => (
                <PlayerChip p={p} sub horizon={horizon} key={p.id} />
              ))}
          </div>
        </div>
        <div className="side-stack">
          <div className="panel captain-card">
            <div className="panel-head">
              <div>
                <h2>Vice-captain</h2>
                <p>Backup multiplier</p>
              </div>
              <Trophy className="gold" size={20} />
            </div>
            <div className="captain">
              <div className="captain-badge">V</div>
              <div>
                <b>{vice?.name}</b>
                <small>
                  {vice
                    ? `${horizonProjection(vice, horizon).toFixed(1)} base pts`
                    : ""}
                </small>
              </div>
            </div>
          </div>
          <div className="panel ask-card">
            <Sparkles size={18} className="sparkle" />
            <h2>Challenge the verdict</h2>
            <p>Ask Insomnia FPL to explain or challenge this recommendation.</p>
            <button onClick={() => setTab("Ask")} className="dark-btn">
              Ask Insomnia FPL <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function DraftPlanner({
  plan,
  horizon,
  onApply,
}: {
  plan: DraftImprovementPlan | null;
  horizon: number;
  onApply: () => void;
}) {
  const threshold =
    TRANSFER_GAIN_THRESHOLDS[
      (horizon >= 5 ? 5 : horizon >= 3 ? 3 : 1) as 1 | 3 | 5
    ];
  return (
    <div className="content">
      <div className="page-intro">
        <div>
          <p className="eyebrow">GW1 DRAFT LAB</p>
          <h2>Re-optimise the whole £100m squad</h2>
          <p className="muted">
            Unlimited pre-deadline edits are evaluated together. Locked players
            stay in your squad.
          </p>
        </div>
        <div className="filter-pill">
          <Shield size={15} /> {activeLockedIds.length} locked · £100.0m hard
          cap
        </div>
      </div>
      {plan ? (
        <div className="panel draft-plan">
          <div className="panel-head">
            <div>
              <h2>Recommended restructure</h2>
              <p>
                Lineup, captain, vice-captain, bench cover and minutes risk over{" "}
                {horizon} GWs
              </p>
            </div>
            <span className="pill green">+{plan.gain} objective pts</span>
          </div>
          <div className="draft-score-comparison">
            <span>
              <small>Current structure</small>
              <b>{plan.currentScore}</b>
            </span>
            <ArrowRight size={20} />
            <span>
              <small>Optimised structure</small>
              <b>{plan.optimizedScore}</b>
            </span>
            <span>
              <small>Final cost</small>
              <b>£{plan.optimizedCost.toFixed(1)}m</b>
            </span>
          </div>
          <div className="draft-change-list">
            {plan.changes.map((change) => (
              <div
                className="draft-change"
                key={`${change.out.id}-${change.in.id}`}
              >
                <div>
                  <span className="red-tag">OUT</span>
                  <b>{change.out.name}</b>
                  <small>
                    {change.out.position} · £{change.out.price.toFixed(1)}m
                  </small>
                </div>
                <ArrowRight size={17} />
                <div>
                  <span className="green-tag">IN</span>
                  <b>{change.in.name}</b>
                  <small>
                    {change.in.position} · £{change.in.price.toFixed(1)}m
                  </small>
                </div>
                <strong
                  className={change.projectionDelta >= 0 ? "positive" : ""}
                >
                  {change.projectionDelta >= 0 ? "+" : ""}
                  {change.projectionDelta} pts
                </strong>
              </div>
            ))}
          </div>
          <div className="modal-foot">
            <span className="muted">
              {plan.changes.length} coordinated change
              {plan.changes.length === 1 ? "" : "s"} · no transfer hits before
              GW1
            </span>
            <button className="dark-btn" onClick={onApply}>
              Apply optimised draft
            </button>
          </div>
        </div>
      ) : (
        <div className="panel empty draft-empty">
          <b>No better full-squad structure found within £100.0m.</b>
          <p>
            The optimiser checked coordinated changes while preserving{" "}
            {activeLockedIds.length} lock
            {activeLockedIds.length === 1 ? "" : "s"}. This is different from
            the in-season direct-swap filter of {threshold.toFixed(1)} projected
            points.
          </p>
          <p>
            Unlock a player or change the horizon to explore a wider search.
          </p>
        </div>
      )}
    </div>
  );
}

function TargetedReplacementSection({
  outPlayer,
  squad,
  catalog,
  bank,
  horizon,
  onApplyTransfer,
  onClearTarget,
}: {
  outPlayer: Player;
  squad: Player[];
  catalog: Player[];
  bank: number;
  horizon: number;
  onApplyTransfer: (outId: number, inId: number) => void;
  onClearTarget: () => void;
}) {
  const squadIds = useMemo(() => new Set(squad.map((p) => p.id)), [squad]);
  const maxPrice = +(outPlayer.price + Math.max(0, bank)).toFixed(1);

  const candidates = useMemo(() => {
    return catalog
      .filter(
        (p) =>
          p.position === outPlayer.position &&
          p.id !== outPlayer.id &&
          !squadIds.has(p.id) &&
          p.price <= maxPrice + 0.01
      )
      .map((p) => {
        const outXp = horizonProjection(outPlayer, horizon);
        const inXp = horizonProjection(p, horizon);
        return {
          player: p,
          inXp,
          outXp,
          gain: +(inXp - outXp).toFixed(1),
          priceDelta: +(p.price - outPlayer.price).toFixed(1),
        };
      })
      .sort((a, b) => b.inXp - a.inXp)
      .slice(0, 6);
  }, [catalog, outPlayer, squadIds, maxPrice, horizon]);

  return (
    <div className="panel targeted-replacement-panel">
      <div className="panel-head">
        <div>
          <h2>
            🎯 Replacement Options for {outPlayer.name} ({outPlayer.position}, £{outPlayer.price.toFixed(1)}m)
          </h2>
          <p className="muted">
            Transfers within your budget (£{maxPrice.toFixed(1)}m max), ranked by projected points over {horizon} GWs.
          </p>
        </div>
        <button className="ghost-btn" onClick={onClearTarget}>
          Dismiss
        </button>
      </div>

      <div className="targeted-candidate-list">
        {candidates.map(({ player, inXp, gain, priceDelta }) => (
          <div className="targeted-candidate-card" key={player.id}>
            <div className="candidate-info">
              <span className="shirt" style={{ background: getPlayerShirtColor(player) }}>
                {player.position}
              </span>
              <div>
                <b>{player.name}</b>
                <small>
                  {player.club} · £{player.price.toFixed(1)}m ({priceDelta >= 0 ? `+£${priceDelta.toFixed(1)}m` : `-£${Math.abs(priceDelta).toFixed(1)}m`})
                </small>
                <div className="candidate-fixture">{player.fixture}</div>
              </div>
            </div>

            <div className="candidate-right">
              <div className="candidate-score">
                <b>{inXp.toFixed(1)} xPts</b>
                <span className={gain >= 0 ? "positive-gain" : "negative-gain"}>
                  {gain >= 0 ? `+${gain}` : gain} pts gain
                </span>
              </div>
              <button
                className="emerald-btn"
                onClick={() => onApplyTransfer(outPlayer.id, player.id)}
              >
                Swap for {outPlayer.name.split(" ").slice(-1)[0]}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TransfersV2({
  data,
  horizon,
  onWhy,
  onApply,
  manager,
  targetSwapPlayer,
  onClearTargetSwapPlayer,
  squad,
  catalog,
  effectiveBank = 0,
  canonicalRecommendation,
  canonicalLoading = false,
  onGenerateCanonical,
  onApplyCanonical,
  onDismissCanonical,
}: {
  data: Transfer[];
  horizon: number;
  onWhy: (t: Transfer) => void;
  onApply: (outId: number, inId: number) => void;
  manager: ManagerSettings;
  targetSwapPlayer?: Player | null;
  onClearTargetSwapPlayer?: () => void;
  squad?: Player[];
  catalog?: Player[];
  effectiveBank?: number;
  canonicalRecommendation?: CanonicalRecommendation | null;
  canonicalLoading?: boolean;
  onGenerateCanonical?: (chip?: 'TRIPLE_CAPTAIN' | 'BENCH_BOOST' | 'FREE_HIT' | 'WILDCARD' | null) => void;
  onApplyCanonical?: (candidate: CanonicalRecommendation['candidates'][number]) => void;
  onDismissCanonical?: (candidate: CanonicalRecommendation['candidates'][number], decision: 'REJECTED' | 'IGNORED') => void;
}) {
  const [limit, setLimit] = useState(8);
  const visibleData = data.slice(0, limit);
  if (activeDraftMode)
    return (
      <div className="content">
        {targetSwapPlayer && squad && catalog && onClearTargetSwapPlayer && (
          <TargetedReplacementSection
            outPlayer={targetSwapPlayer}
            squad={squad}
            catalog={catalog}
            bank={effectiveBank}
            horizon={horizon}
            onApplyTransfer={(outId, inId) => {
              onApply(outId, inId);
              onClearTargetSwapPlayer();
            }}
            onClearTarget={onClearTargetSwapPlayer}
          />
        )}
        <DraftPlanner
          plan={activeDraftPlan}
          horizon={horizon}
          onApply={activeApplyDraftPlan}
        />
      </div>
    );

  return (
    <div className="content">
      {targetSwapPlayer && squad && catalog && onClearTargetSwapPlayer && (
        <TargetedReplacementSection
          outPlayer={targetSwapPlayer}
          squad={squad}
          catalog={catalog}
          bank={effectiveBank}
          horizon={horizon}
          onApplyTransfer={(outId, inId) => {
            onApply(outId, inId);
            onClearTargetSwapPlayer();
          }}
          onClearTarget={onClearTargetSwapPlayer}
        />
      )}
      {squad && squad.some(p => (p.roleProfile?.derivedFromSignalIds?.length ?? 0) > 0 && (p.roleProfile?.startProbability ?? 1) < 0.6) && (
        <SignalRiskStrip players={squad} />
      )}
      <div className="panel priority-card">
        <div className="panel-head"><div><h2>Stored multi-transfer recommendation</h2><p>Uses the latest immutable forecast run, exact selling economics, hit costs, uncertainty penalty, and the 60% decision rule.</p></div><button className="dark-btn" disabled={canonicalLoading} onClick={() => onGenerateCanonical?.(null)}>{canonicalLoading ? 'Calculating…' : 'Generate plan'}</button></div>
        <div className="recommend-actions">
          {([['TRIPLE_CAPTAIN','TC'],['BENCH_BOOST','BB'],['FREE_HIT','FH'],['WILDCARD','WC']] as const).map(([chip,label]) => <button className="ghost-btn" disabled={canonicalLoading} onClick={() => onGenerateCanonical?.(chip)} key={chip}>{label} counterfactual</button>)}
        </div>
        {canonicalRecommendation && <>
          <p className="muted">Forecast {canonicalRecommendation.forecastRunId.slice(0, 8)} · status {canonicalRecommendation.status} · {canonicalRecommendation.cacheStatus === 'HIT' ? 'reused stored result' : 'new result stored'} · ordering saved for reproducibility</p>
          {canonicalRecommendation.candidates.map(candidate => {
            const names = candidate.apiMoves?.map(move => `${catalog?.find(player => player.id === move.outId)?.name || `#${move.outId}`} → ${catalog?.find(player => player.id === move.inId)?.name || `#${move.inId}`}`) || [];
            const primary = candidate.id === canonicalRecommendation.primaryCandidateId;
            return <article className="review-card" key={candidate.id}>
              <div className="card-agent-header"><b>{primary ? 'PRIMARY · ' : ''}{candidate.action}</b><span className={`pill ${candidate.affordabilityStatus === 'EXACT' ? 'green' : 'amber'}`}>{candidate.affordabilityStatus}</span></div>
              <p>{names.length ? names.join(' · ') : candidate.action === 'CHIP' ? 'Optimised chip counterfactual' : 'Roll the transfer'} · net {Number(candidate.netExpectedGain).toFixed(2)} pts · hit {candidate.hitCost} · P(beats roll) {candidate.probabilityBeatsRoll == null ? '—' : `${Math.round(candidate.probabilityBeatsRoll * 100)}%`}</p>
              {candidate.p10Points != null && candidate.p90Points != null && <small>Outcome range under current assumptions: {Number(candidate.p10Points).toFixed(1)}–{Number(candidate.p90Points).toFixed(1)} pts (p10–p90)</small>}
              <div className="recommend-actions">
                {(candidate.apiMoves?.length || candidate.action === 'CHIP') ? <button className="dark-btn" onClick={() => onApplyCanonical?.(candidate)}>{candidate.action === 'CHIP' ? 'Record chip plan' : 'Apply local plan'}</button> : null}
                <button className="ghost-btn" onClick={() => onDismissCanonical?.(candidate, 'REJECTED')}>Reject</button><button className="ghost-btn" onClick={() => onDismissCanonical?.(candidate, 'IGNORED')}>Ignore</button>
              </div>
            </article>;
          })}
        </>}
      </div>
      <div className="page-intro">
        <div>
          <p className="eyebrow">TRANSFER PLAN</p>
          <h2>Moves that improve your squad</h2>
          <p className="muted">
            Ranked by projected net gain over {horizon} GWs. Review a move
            before saving it to your local plan.
          </p>
        </div>
        <div className="filter-pill">
          <Gauge size={15} /> {manager.freeTransfers} free transfer
          {manager.freeTransfers === 1 ? "" : "s"} · £{manager.bank.toFixed(1)}m
          bank
        </div>
      </div>
      <div className="panel transfer-list">
        {visibleData.map((t, i) => {
          const outProj = t.outProjection ?? horizonProjection(t.out, horizon);
          const inProj = t.inProjection ?? horizonProjection(t.in, horizon);
          return (
            <article
              className="transfer-card-item"
              key={t.out.id + "-" + t.in.id}
            >
              <div className="transfer-row">
                <span className="rank">{String(i + 1).padStart(2, "0")}</span>
                <div className="transfer-player">
                  <span
                    className="mini-shirt"
                    style={{ background: getPlayerShirtColor(t.out) }}
                  >
                    {t.out.position}
                  </span>
                  <div>
                    <b>{t.out.name}</b>
                    <small>
                      {t.out.club} · £{t.out.price.toFixed(1)}m
                    </small>
                  </div>
                </div>
                <ArrowRight size={17} className="arrow-muted" />
                <div className="transfer-player">
                  <span
                    className="mini-shirt"
                    style={{ background: getPlayerShirtColor(t.in) }}
                  >
                    {t.in.position}
                  </span>
                  <div>
                    <b>{t.in.name}</b>
                    <small>
                      {t.in.club} · £{t.in.price.toFixed(1)}m
                    </small>
                  </div>
                </div>
                <div className="fixture-col">
                  <span className="fixture">{t.in.fixture}</span>
                  {t.priceAlert === "RISING_SOON" && (
                    <span className="price-pill green">🔥 Price rise</span>
                  )}
                  {t.sellOffWarning && (
                    <span className="price-pill red">⚠️ Sell-off risk</span>
                  )}
                </div>
                <div className="gain">
                  <b>+{t.net}</b>
                  <small>net pts</small>
                </div>
                <div className="transfer-actions">
                  <button className="why-btn" onClick={() => onWhy(t)}>
                    Review
                  </button>
                  <button
                    className="save-plan-btn"
                    onClick={() => onApply(t.out.id, t.in.id)}
                  >
                    Update plan
                  </button>
                </div>
              </div>
              <details className="calculation-details">
                <summary>Calculation details</summary>
                <div>
                  <span>
                    {t.out.name}: <b>{outProj.toFixed(1)}</b>
                  </span>
                  <span>
                    {t.in.name}: <b>{inProj.toFixed(1)}</b>
                  </span>
                  <span>
                    Hit: <b>-{(t.hitCost ?? 0).toFixed(1)}</b>
                  </span>
                  <span>
                    Net: <b>+{t.net.toFixed(1)}</b>
                  </span>
                </div>
              </details>
            </article>
          );
        })}
        {data.length > limit && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: "12px",
              padding: "16px",
            }}
          >
            <button
              className="ghost-btn"
              onClick={() =>
                setLimit((prev) => Math.min(prev + 12, data.length))
              }
            >
              Show 12 more
            </button>
            <button className="dark-btn" onClick={() => setLimit(data.length)}>
              Show all {data.length} transfers
            </button>
          </div>
        )}
        {limit > 8 && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "8px 16px 16px",
            }}
          >
            <button className="ghost-btn" onClick={() => setLimit(8)}>
              Collapse to top 8
            </button>
          </div>
        )}
        {data.length === 0 && (
          <div className="empty">
            <b>No qualifying one-player swaps.</b>
            <p>
              No affordable same-position replacement clears the{" "}
              {TRANSFER_GAIN_THRESHOLDS[
                (horizon >= 5 ? 5 : horizon >= 3 ? 3 : 1) as 1 | 3 | 5
              ].toFixed(1)}
              -point threshold over {horizon} GWs with £
              {manager.bank.toFixed(1)}m in the bank. A multi-transfer funding
              route may still improve the squad.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function renderStatusBadge(p: Player) {
  if (isPlayerInjured(p)) {
    return (
      <span
        className="status-badge injured"
        title={p.news || "Injured - 0% chance of playing"}
      >
        🚑 Injured
      </span>
    );
  }
  if (
    p.status === "d" ||
    (p.minutes > 0 && p.minutes <= 75) ||
    (p.chanceOfPlaying !== undefined && p.chanceOfPlaying > 0 && p.chanceOfPlaying <= 75)
  ) {
    const pct = p.chanceOfPlaying ?? p.minutes;
    return (
      <span
        className="status-badge doubtful"
        title={p.news || `Doubtful - ${pct}% expected mins`}
      >
        ⚠️ {pct}% Mins
      </span>
    );
  }
  if (p.status === "s") {
    return (
      <span className="status-badge suspended" title={p.news || "Suspended"}>
        ⛔ Suspended
      </span>
    );
  }
  return null;
}

function PlayersV2({
  filtered,
  query,
  setQuery,
  filter,
  setFilter,
  horizon,
  ownedIds,
  onSelect,
  comparison,
  onClearComparison,
  affordableLimit,
}: {
  filtered: Player[];
  query: string;
  setQuery: (s: string) => void;
  filter: string;
  setFilter: (s: string) => void;
  horizon: number;
  ownedIds: number[];
  onSelect: (p: Player) => void;
  comparison: Transfer | null;
  onClearComparison: () => void;
  affordableLimit: number;
}) {
  const [sort, setSort] = useState<
    "projection" | "value" | "price" | "minutes"
  >("projection");
  const [page, setPage] = useState(1);
  const pageSize = 20;

  useEffect(() => {
    setPage(1);
  }, [query, filter, sort]);

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) =>
        sort === "value"
          ? horizonProjection(b, horizon) / b.price -
            horizonProjection(a, horizon) / a.price
          : sort === "price"
            ? a.price - b.price
            : sort === "minutes"
              ? b.minutes - a.minutes
              : horizonProjection(b, horizon) - horizonProjection(a, horizon),
      ),
    [filtered, sort, horizon],
  );

  const totalPages = Math.ceil(sorted.length / pageSize) || 1;
  const currentPage = Math.min(page, totalPages);
  const paginated = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, currentPage, pageSize]);

  return (
    <div className="content players-page">
      {comparison && (
        <div className="comparison-panel">
          <div className="comparison-head">
            <div>
              <p className="eyebrow">ACTIVE COMPARISON</p>
              <h2>
                {comparison.out.name} or {comparison.in.name}?
              </h2>
            </div>
            <button className="ghost-btn" onClick={onClearComparison}>
              Clear comparison
            </button>
          </div>
          <div className="comparison-grid">
            {[comparison.out, comparison.in].map((p, index) => (
              <button
                onClick={() => onSelect(p)}
                className={
                  index === 1
                    ? "comparison-player preferred"
                    : "comparison-player"
                }
                key={p.id}
              >
                <span className={index === 1 ? "green-tag" : "red-tag"}>
                  {index === 1 ? "IN" : "OUT"}
                </span>
                <b>{p.name}</b>
                <small>
                  {p.club} · {p.fixture} · £{p.price.toFixed(1)}m
                </small>
                <strong>{horizonProjection(p, horizon).toFixed(1)} pts</strong>
              </button>
            ))}
            <div className="comparison-delta">
              <small>Projected change</small>
              <b>+{comparison.net.toFixed(1)} pts</b>
            </div>
          </div>
        </div>
      )}
      <div className="page-intro">
        <div>
          <p className="eyebrow">PLAYER POOL · {sorted.length} PLAYERS</p>
          <h2>
            {comparison
              ? `Alternatives to ${comparison.out.name}`
              : "Find your next edge"}
          </h2>
          <p className="muted">
            Search, sort and inspect projections before updating your plan.
          </p>
        </div>
        <div className="player-toolbar">
          <div className="search">
            <Search size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search player or club"
            />
          </div>
          <select
            aria-label="Sort players"
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
          >
            <option value="projection">Highest projection</option>
            <option value="value">Best value</option>
            <option value="price">Lowest price</option>
            <option value="minutes">Most secure minutes</option>
          </select>
        </div>
      </div>
      <div className="player-filters">
        {["All", "My Squad", "Affordable", "Flagged", "GK", "DEF", "MID", "FWD"].map(
          (x) => (
            <button
              aria-pressed={filter === x}
              className={filter === x ? "selected" : ""}
              onClick={() => setFilter(x)}
              key={x}
            >
              {x === "Affordable"
                ? `Affordable ≤ £${affordableLimit.toFixed(1)}m`
                : x}
            </button>
          ),
        )}
      </div>
      <div className="panel table player-table">
        <div className="tr th player-table-tr">
          <span>PLAYER</span>
          <span>OWNED</span>
          <span>FIXTURES</span>
          <span className="th-right">FORM</span>
          <span className="th-right">MINUTES</span>
          <span className="th-right">{horizon}-GW PROJ.</span>
          <span className="th-right">VALUE</span>
        </div>
        {paginated.map((p) => (
          <button
            className={`tr player-row player-table-tr ${isPlayerInjured(p) ? "injured-row" : ""}`}
            onClick={() => onSelect(p)}
            key={p.id}
          >
            <div className="name-cell">
              <span className="mini-shirt" style={{ background: getPlayerShirtColor(p) }}>
                {p.position}
              </span>
              <div>
                <b>{p.name}</b>
                <small>
                  {p.club} · £{p.price.toFixed(1)}m
                </small>
              </div>
              {renderStatusBadge(p)}
            </div>
            <span data-label="Owned" className="owned-mark">
              {ownedIds.includes(p.id) ? "✓ In squad" : "—"}
            </span>
            <span data-label="Fixtures" className="fixture fixture-strip">
              {getPlayerUpcomingFixtures(p, horizon).map((f, idx) => (
                <span
                  key={`${f.gameweek}-${f.opponent}-${idx}`}
                  className={`fdr-pill fdr-${f.difficulty}`}
                  title={`GW${f.gameweek}: vs ${f.opponent} (${f.venue}) - FDR ${f.difficulty}`}
                >
                  {f.opponent} ({f.venue})
                </span>
              ))}
            </span>
            <span data-label="Form" className="col-numeric">{p.form.toFixed(1)}</span>
            <span data-label="Minutes" className="col-numeric">{p.minutes}%</span>
            <span data-label={`${horizon}-GW projection`} className="col-numeric col-proj">
              <b>{horizonProjection(p, horizon).toFixed(1)}</b> pts
            </span>
            <span data-label="Value" className="value col-numeric">
              {(horizonProjection(p, horizon) / p.price).toFixed(2)}
            </span>
          </button>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="pagination-bar">
          <div className="pagination-info">
            Showing{" "}
            <b>
              {(currentPage - 1) * pageSize + 1}–
              {Math.min(currentPage * pageSize, sorted.length)}
            </b>{" "}
            of <b>{sorted.length}</b> players
          </div>
          <div className="pagination-controls">
            <button
              className="ghost-btn pagination-btn"
              disabled={currentPage <= 1}
              onClick={() => setPage(1)}
            >
              « First
            </button>
            <button
              className="ghost-btn pagination-btn"
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ‹ Prev
            </button>
            <span className="pagination-current">
              Page {currentPage} of {totalPages}
            </span>
            <button
              className="ghost-btn pagination-btn"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next ›
            </button>
            <button
              className="ghost-btn pagination-btn"
              disabled={currentPage >= totalPages}
              onClick={() => setPage(totalPages)}
            >
              Last »
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function findReferencedPlayers(text: string, catalog: Player[]): Player[] {
  if (!text) return [];
  const sorted = [...catalog]
    .filter((p) => p.name.length >= 3)
    .sort((a, b) => b.name.length - a.name.length);
  const found: Player[] = [];
  const foundIds = new Set<number>();

  for (const player of sorted) {
    const escaped = player.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    if (regex.test(text) && !foundIds.has(player.id)) {
      found.push(player);
      foundIds.add(player.id);
    }
  }
  return found;
}

function InteractiveAnswerText({
  text,
  catalog,
  onSelectPlayer,
}: {
  text: string;
  catalog: Player[];
  onSelectPlayer: (p: Player) => void;
}) {
  if (!text) return null;
  const sorted = [...catalog]
    .filter((p) => p.name.length >= 3)
    .sort((a, b) => b.name.length - a.name.length);
  const nameToPlayer = new Map<string, Player>();
  const patterns: string[] = [];

  for (const p of sorted) {
    const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    patterns.push(escaped);
    nameToPlayer.set(p.name.toLowerCase(), p);
  }

  if (patterns.length === 0) {
    return <div className="interactive-answer-body">{text}</div>;
  }

  const regex = new RegExp(`\\b(${patterns.join("|")})\\b`, "gi");
  const parts: (string | React.ReactElement)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const matchedName = match[0];
    const matchIndex = match.index;

    if (matchIndex > lastIndex) {
      parts.push(text.substring(lastIndex, matchIndex));
    }

    const player = nameToPlayer.get(matchedName.toLowerCase());
    if (player) {
      parts.push(
        <button
          key={`${player.id}-${matchIndex}`}
          className="inline-player-chip"
          onClick={() => onSelectPlayer(player)}
          title={`Click to view ${player.name} detail`}
        >
          <span className="mini-shirt" style={{ background: getPlayerShirtColor(player) }}>
            {player.position}
          </span>
          <b>{player.name}</b>
        </button>,
      );
    } else {
      parts.push(matchedName);
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return <div className="interactive-answer-body">{parts}</div>;
}

function ResolvedPlayerActions({
  text,
  review,
  catalog,
  squad,
  horizon,
  onSelectPlayer,
  onApplyTransfer,
}: {
  text: string;
  review: DecisionReview | null;
  catalog: Player[];
  squad: Player[];
  horizon: number;
  onSelectPlayer: (p: Player) => void;
  onApplyTransfer: (outId: number, inId: number) => void;
}) {
  const [swapTarget, setSwapTarget] = useState<Player | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const squadIds = useMemo(() => new Set(squad.map((p) => p.id)), [squad]);

  const recTransfer = useMemo(() => {
    const match = text.match(/(?:BUY|TRANSFER|SWAP):\s*([A-Za-z\s'-]+)\s*(?:->|to|for)\s*([A-Za-z\s'-]+)/i) ||
                  text.match(/([A-Za-z\s'-]+)\s*->\s*([A-Za-z\s'-]+)/i);
    if (match) {
      const outP = catalog.find(
        (p) => p.name.toLowerCase() === match[1].trim().toLowerCase(),
      );
      const inP = catalog.find(
        (p) => p.name.toLowerCase() === match[2].trim().toLowerCase(),
      );
      if (outP && inP && squadIds.has(outP.id) && !squadIds.has(inP.id)) {
        return {
          out: outP,
          in: inP,
          net: +(
            horizonProjection(inP, horizon) - horizonProjection(outP, horizon)
          ).toFixed(1),
        };
      }
    }
    return null;
  }, [text, catalog, horizon, squadIds]);

  const referencedPlayers = useMemo(() => {
    return findReferencedPlayers(text, catalog);
  }, [text, catalog]);

  const handleQuickSwap = (
    outId: number,
    inId: number,
    outName: string,
    inName: string,
  ) => {
    onApplyTransfer(outId, inId);
    setSwapTarget(null);
  };

  if (referencedPlayers.length === 0 && !recTransfer) return null;

  return (
    <div className="resolved-actions-panel">
      {toastMsg && <div className="swap-toast-banner">{toastMsg}</div>}

      {recTransfer &&
        squadIds.has(recTransfer.out.id) &&
        !squadIds.has(recTransfer.in.id) && (
          <div className="quick-transfer-card">
            <div className="quick-transfer-info">
              <span className="pill green">RECOMMENDED SWAP</span>
              <strong>
                {recTransfer.out.name} ({recTransfer.out.club}) →{" "}
                {recTransfer.in.name} ({recTransfer.in.club})
              </strong>
              <small>
                +{recTransfer.net} net pts over {horizon} GWs
              </small>
            </div>
            <button
              className="apply-swap-btn"
              onClick={() =>
                handleQuickSwap(
                  recTransfer.out.id,
                  recTransfer.in.id,
                  recTransfer.out.name,
                  recTransfer.in.name,
                )
              }
            >
              Review plan update
            </button>
          </div>
        )}

      <div className="resolved-players-header">
        <Sparkles size={13} /> <span>RESOLVED PLAYERS & SQUAD ACTIONS</span>
      </div>

      <div className="resolved-players-grid">
        {referencedPlayers.map((p) => {
          const isOwned = squadIds.has(p.id);
          return (
            <div className="resolved-player-chip" key={p.id}>
              <span className="shirt" style={{ background: getPlayerShirtColor(p) }}>
                {p.position}
              </span>
              <div className="chip-details" onClick={() => onSelectPlayer(p)}>
                <b>{p.name}</b>
                <small>
                  {p.club} · £{p.price.toFixed(1)}m ·{" "}
                  {horizonProjection(p, horizon)} pts
                </small>
              </div>
              <div className="chip-actions">
                {isOwned ? (
                  <span className="owned-badge">✓ In Squad</span>
                ) : (
                  <button
                    className="swap-in-btn"
                    onClick={() => setSwapTarget(p)}
                  >
                    + Swap In
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {swapTarget && (
        <div
          className="swap-picker-overlay"
          onClick={() => setSwapTarget(null)}
        >
          <div
            className="swap-picker-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">SWAP INTO SQUAD</p>
                <h3>
                  Bring in {swapTarget.name} ({swapTarget.position})
                </h3>
                <p className="muted">
                  Select which {swapTarget.position} in your squad to replace:
                </p>
              </div>
              <button className="close" onClick={() => setSwapTarget(null)}>
                ×
              </button>
            </div>
            <div className="swap-options-list">
              {squad
                .filter(
                  (p) =>
                    p.position === swapTarget.position &&
                    p.id !== swapTarget.id,
                )
                .map((outP) => {
                  const netGain = +(
                    horizonProjection(swapTarget, horizon) -
                    horizonProjection(outP, horizon)
                  ).toFixed(1);
                  return (
                    <button
                      key={outP.id}
                      className="swap-option-row"
                      onClick={() =>
                        handleQuickSwap(
                          outP.id,
                          swapTarget.id,
                          outP.name,
                          swapTarget.name,
                        )
                      }
                    >
                      <div className="option-players">
                        <span className="red-tag">SELL</span> <b>{outP.name}</b>{" "}
                        (£{outP.price.toFixed(1)}m)
                        <ArrowRight size={14} />
                        <span className="green-tag">BUY</span>{" "}
                        <b>{swapTarget.name}</b> (£{swapTarget.price.toFixed(1)}
                        m)
                      </div>
                      <span
                        className={`net-pill ${netGain >= 0 ? "pos" : "neg"}`}
                      >
                        {netGain >= 0 ? `+${netGain}` : netGain} pts
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AskV2({
  question,
  setQuestion,
  onSubmitQuestion,
  answer,
  review,
  llmAnswer,
  llmProvider,
  llmError,
  llmLoading,
  onOpenAiConfig,
  catalog,
  squad,
  horizon,
  onSelectPlayer,
  onApplyTransfer,
}: {
  question: string;
  setQuestion: (s: string) => void;
  onSubmitQuestion: (q: string) => void;
  answer: string;
  review: DecisionReview | null;
  llmAnswer: string | null;
  llmProvider: string;
  llmError: string | null;
  llmLoading: boolean;
  onOpenAiConfig: () => void;
  catalog: Player[];
  squad: Player[];
  horizon: number;
  onSelectPlayer: (p: Player) => void;
  onApplyTransfer: (outId: number, inId: number) => void;
}) {
  const prompts = [
    "Suggest a GW starting team",
    "What should I do this week?",
    "Who is my weakest player?",
    "Should I roll my transfer?",
    "Who should I captain?",
    "Find me a midfielder under £7.0m.",
  ];
  const displayAnswer = llmAnswer || answer;

  const handleAnalyse = () => {
    const q = question.trim() || "What should I do this week?";
    setQuestion(q);
    onSubmitQuestion(q);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAnalyse();
    }
  };

  return (
    <div className="content ask-page">
      <div className="ask-hero">
        <span className="ask-icon">
          <Bot size={26} />
        </span>
        <p className="eyebrow">SQUAD ASSISTANT</p>
        <h2>What should you do this week?</h2>
        <p className="muted">
          Ask anything. Answers are grounded in your projections, fixtures and
          transfer options.
        </p>
      </div>
      <div className="question-box">
        <textarea
          value={question}
          onKeyDown={handleKeyDown}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Should I sell Saka for Mbeumo? (Press Enter or click Analyse)"
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: "10px",
          }}
        >
          <button
            className="ghost-btn"
            style={{ padding: "6px 12px", fontSize: "11px" }}
            onClick={onOpenAiConfig}
          >
            ⚙️ Config AI Key
          </button>
          <button
            onClick={handleAnalyse}
            disabled={llmLoading}
            className="dark-btn"
          >
            {llmLoading ? (
              <>
                <span
                  className="loading-spinner loading-spinner-small"
                  aria-hidden="true"
                />{" "}
                Analysing…
              </>
            ) : (
              <>
                Analyse <ArrowRight size={15} />
              </>
            )}
          </button>
        </div>
        {llmError && (
          <div className="llm-error-banner">
            <span>
              ⚠️ <b>AI Error:</b> {llmError}. Using fallback engine.
            </span>
          </div>
        )}
      </div>
      {llmLoading && (
        <div className="panel ask-loading" role="status" aria-live="polite">
          <span className="loading-spinner" aria-hidden="true" />
          <span>
            <b>Insomnia FPL is analysing your question…</b>
            <small>
              Checking your squad, projections and transfer options.
            </small>
          </span>
        </div>
      )}
      {displayAnswer && review && (
        <div className="panel answer">
          <div className="answer-label">
            <Sparkles size={15} /> INSOMNIA FPL SAYS{" "}
            <button
              onClick={onOpenAiConfig}
              style={{
                marginLeft: "auto",
                fontSize: "10px",
                color: "var(--accent-emerald)",
                fontWeight: 700,
                background: "rgba(0,255,135,0.1)",
                padding: "3px 8px",
                borderRadius: "12px",
                border: "1px solid rgba(0,255,135,0.2)",
                cursor: "pointer",
              }}
            >
              ✦ {llmProvider}
            </button>
          </div>
          <InteractiveAnswerText
            text={displayAnswer}
            catalog={catalog}
            onSelectPlayer={onSelectPlayer}
          />
          <div className="answer-confidence">
            <b>{review.arbiter.confidence} confidence</b>
            <span>
              {review.arbiter.decision === "BUY"
                ? "The evidence supports making this move."
                : "Keep monitoring before changing your plan."}
            </span>
          </div>
          <details className="technical-details">
            <summary>Evidence and technical details</summary>
            <div className="review-strip">
              <span>
                <b>Projection model</b>
                {review.quant.recommendation}
              </span>
              <span>
                <b>Risk check</b>
                {review.skeptic.stance}
              </span>
              <span>
                <b>Final view</b>
                {review.arbiter.decision}
              </span>
              <span>
                <b>Confidence</b>
                {review.arbiter.confidence}
              </span>
            </div>
            <p className="review-detail">
              <b>Projection:</b> {review.quant.arguments.join(" ")}
              <br />
              <b>Risks:</b> {review.skeptic.concerns.join(" ")}
              <br />
              <b>What would change this:</b>{" "}
              {review.arbiter.whatWouldChange.join(" ")}
            </p>
            <small>Evidence checked: {review.toolTrace.join(" → ")}</small>
          </details>
          <ResolvedPlayerActions
            text={displayAnswer}
            review={review}
            catalog={catalog}
            squad={squad}
            horizon={horizon}
            onSelectPlayer={onSelectPlayer}
            onApplyTransfer={onApplyTransfer}
          />
        </div>
      )}
      <div className="suggestions">
        <span>Try asking:</span>
        {prompts.map((x) => (
          <button
            onClick={() => {
              setQuestion(x);
              onSubmitQuestion(x);
            }}
            key={x}
          >
            {x}
          </button>
        ))}
      </div>
    </div>
  );
}

function AiKeyModal({
  apiKey,
  setApiKey,
  provider,
  setProvider,
  fplAccount,
  setFplAccount,
  selectedIds,
  onClose,
}: {
  apiKey: string;
  setApiKey: (k: string) => void;
  provider: string;
  setProvider: (p: string) => void;
  fplAccount?: FplAccount | null;
  setFplAccount?: (a: FplAccount | null) => void;
  selectedIds?: number[];
  onClose: () => void;
}) {
  const [keyInput, setKeyInput] = useState(apiKey);
  const [provInput, setProvInput] = useState(provider);
  const [autoDetected, setAutoDetected] = useState<string | null>(null);

  const handleKeyChange = (val: string) => {
    setKeyInput(val);
    const trimmed = val.trim();
    if (provInput === "deepseek" && trimmed) {
      setAutoDetected("DeepSeek (selected)");
    } else if (
      trimmed.startsWith("sk-proj-") ||
      (trimmed.startsWith("sk-") && !trimmed.startsWith("sk-ant-"))
    ) {
      setProvInput("openai");
      setAutoDetected("OpenAI");
    } else if (trimmed.startsWith("sk-ant-")) {
      setProvInput("anthropic");
      setAutoDetected("Anthropic");
    } else if (trimmed.startsWith("AIzaSy")) {
      setProvInput("gemini");
      setAutoDetected("Google Gemini");
    } else {
      setAutoDetected(null);
    }
  };

  const save = () => {
    const cleanKey = keyInput.trim();
    setApiKey(cleanKey);
    setProvider(provInput);
    saveServerAiConfig(provInput, cleanKey);
    if (fplAccount) {
      const nextAcc = { ...fplAccount, aiProvider: provInput, apiKey: cleanKey };
      if (setFplAccount) setFplAccount(nextAcc);
      saveUserProfile(nextAcc, selectedIds);
    }
    onClose();
  };
  const clear = () => {
    setApiKey("");
    saveServerAiConfig(provInput, "");
    if (fplAccount) {
      const nextAcc = { ...fplAccount, apiKey: "" };
      if (setFplAccount) setFplAccount(nextAcc);
      saveUserProfile(nextAcc, selectedIds);
    }
    setKeyInput("");
    setAutoDetected(null);
    onClose();
  };
  return (
    <div className="modal-backdrop">
      <div className="modal import-modal">
        <div className="modal-head">
          <div>
            <p className="eyebrow">AI CONFIGURATION</p>
            <h2>Configure AI Key</h2>
            <p className="muted">
      Connect your own Gemini, OpenAI, Anthropic, or DeepSeek API key directly
              from your browser.
            </p>
          </div>
          <button onClick={onClose} className="close">
            ×
          </button>
        </div>
        <div style={{ display: "grid", gap: "14px", marginTop: "18px" }}>
          <label
            style={{
              fontSize: "11px",
              fontWeight: 700,
              color: "var(--text-muted)",
            }}
          >
            PROVIDER
            <select
              value={provInput}
              onChange={(e) => setProvInput(e.target.value)}
              style={{
                display: "block",
                width: "100%",
                marginTop: "6px",
                padding: "10px",
                borderRadius: "8px",
                background: "var(--bg-input)",
                border: "1px solid var(--border-subtle)",
                color: "var(--text-main)",
                fontSize: "12px",
              }}
            >
              <option value="gemini">Google Gemini (Gemini 2.0 Flash)</option>
              <option value="openai">OpenAI (GPT-4o mini)</option>
              <option value="anthropic">Anthropic (Claude 3.5 Haiku)</option>
              <option value="deepseek">DeepSeek (V4 Flash)</option>
            </select>
          </label>
          <label
            style={{
              fontSize: "11px",
              fontWeight: 700,
              color: "var(--text-muted)",
            }}
          >
            API KEY
            <input
              type="password"
              value={keyInput}
              onChange={(e) => handleKeyChange(e.target.value)}
              placeholder="Paste API key (e.g. AIzaSy... or sk-...)"
              style={{
                display: "block",
                width: "100%",
                marginTop: "6px",
                padding: "10px",
                borderRadius: "8px",
                background: "var(--bg-input)",
                border: "1px solid var(--border-subtle)",
                color: "var(--text-main)",
                fontSize: "12px",
              }}
            />
            {autoDetected && (
              <span className="key-detected-badge">
                ✨ Auto-detected <b>{autoDetected}</b> key format
              </span>
            )}
          </label>
          <p className="import-note">
            <Shield size={14} /> Keys are saved in your app configuration and used to fetch grounded AI insights.
          </p>
        </div>
        <div className="modal-foot">
          {apiKey && (
            <button
              className="ghost-btn"
              style={{ color: "var(--accent-rose)" }}
              onClick={clear}
            >
              Remove key
            </button>
          )}
          <button className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="dark-btn" onClick={save}>
            Save key
          </button>
        </div>
      </div>
    </div>
  );
}

function DecisionSummary({
  horizon,
  decision,
  captain,
  score,
  tab,
}: {
  horizon: number;
  decision: any;
  captain: Player | null;
  score: number;
  tab: string;
}) {
  const captainBonus = captain ? horizonProjection(captain, horizon) : 0;
  return (
    <div
      className={"decision-summary " + (tab === "Ask" ? "summary-hidden" : "")}
    >
      <span>
        <b>{horizon}-GW PLAN</b>
      </span>
      <span>
        Transfer:{" "}
        <strong>
          {decision.roll
            ? "Roll"
            : `${decision.transfer?.out.name} → ${decision.transfer?.in.name}`}
        </strong>
      </span>
      <span>
        Captain: <strong>{captain?.name || "—"}</strong>
      </span>
      <span>
        Projection: <strong>{(score + captainBonus).toFixed(1)}</strong>
      </span>
    </div>
  );
}

function WhyDrawer({
  transfer,
  review,
  horizon,
  onClose,
  onCompare,
  onApplyTransfer,
}: {
  transfer: Transfer;
  review: DecisionReview | null;
  horizon: number;
  onClose: () => void;
  onCompare: () => void;
  onApplyTransfer: (outId: number, inId: number) => void;
}) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="why-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <div className="eyebrow-badge">
              <Sparkles size={13} /> DECISION REVIEW
            </div>
            <h2>Why {transfer.in.name}?</h2>
            <p className="muted">
              <span>{transfer.out.name}</span>
              <span className="arrow-inline">→</span>
              <span>{transfer.in.name}</span>
              <span className="horizon-pill">{horizon} GWs</span>
            </p>
          </div>
          <button className="close" onClick={onClose} aria-label="Close drawer">
            ×
          </button>
        </div>
        <div className="transfer-hero-cards">
          <div className="player-hero-card outgoing">
            <span className="hero-card-tag out-tag">OUTGOING</span>
            <div className="hero-card-name">{transfer.out.name}</div>
            <div className="hero-card-meta">
              {transfer.out.fixture} · {transfer.out.minutes}% mins
            </div>
            <div className="hero-card-pts out-pts">
              {horizonProjection(transfer.out, horizon)} <small>pts</small>
            </div>
          </div>
          <div className="transfer-exchange-icon">
            <div className="exchange-circle">
              <ArrowRight size={18} />
            </div>
          </div>
          <div className="player-hero-card incoming">
            <span className="hero-card-tag in-tag">INCOMING</span>
            <div className="hero-card-name">{transfer.in.name}</div>
            <div className="hero-card-meta">
              {transfer.in.fixture} · {transfer.in.minutes}% mins
            </div>
            <div className="hero-card-pts in-pts">
              {horizonProjection(transfer.in, horizon)} <small>pts</small>
            </div>
          </div>
        </div>
        <div className="evidence-gain-banner">
          <div className="gain-main">
            <span className="gain-value">+{transfer.gain.toFixed(1)}</span>
            <span className="gain-label">Projected Net Points Gain</span>
          </div>
          <div className="gain-chips">
            <div className="gain-chip">
              <span className="chip-label">Price Impact</span>
              <span
                className={`chip-val ${transfer.priceDelta <= 0 ? "saving" : "cost"}`}
              >
                {transfer.priceDelta >= 0
                  ? `+£${transfer.priceDelta.toFixed(1)}m`
                  : `-£${Math.abs(transfer.priceDelta).toFixed(1)}m`}
              </span>
            </div>
            <div className="gain-chip">
              <span className="chip-label">Hit Cost</span>
              <span className="chip-val free">0 pts</span>
            </div>
            <div className="gain-chip">
              <span className="chip-label">Horizon</span>
              <span className="chip-val">{horizon} GWs</span>
            </div>
          </div>
        </div>
        {review ? (
          <div className="review-section">
            <div className="review-section-header">
              MULTI-AGENT EVIDENCE REVIEW
            </div>
            {review.quant && (
              <div className="review-card quant-card">
                <div className="card-agent-header">
                  <div className="agent-badge quant">
                    <span className="dot" /> QUANT MODEL
                  </div>
                  <span
                    className={`rec-badge rec-${review.quant.recommendation.toLowerCase()}`}
                  >
                    {review.quant.recommendation}
                  </span>
                </div>
                <div className="card-body">
                  {review.quant.arguments.map((arg, idx) => (
                    <p key={idx}>{arg}</p>
                  ))}
                </div>
              </div>
            )}
            {review.skeptic && (
              <div className="review-card skeptic-card">
                <div className="card-agent-header">
                  <div className="agent-badge skeptic">
                    <span className="dot" /> SKEPTIC & RISK
                  </div>
                  <span
                    className={`stance-badge stance-${review.skeptic.stance.toLowerCase()}`}
                  >
                    {review.skeptic.stance}
                  </span>
                </div>
                <div className="card-body">
                  {review.skeptic.concerns.map((concern, idx) => (
                    <p key={idx}>{concern}</p>
                  ))}
                </div>
              </div>
            )}
            {review.arbiter && (
              <div className="review-card final-card">
                <div className="card-agent-header">
                  <div className="agent-badge final">
                    <Sparkles size={14} /> ARBITER SYNTHESIS
                  </div>
                  <div className="final-right-badges">
                    <span
                      className={`confidence-badge conf-${review.arbiter.confidence.toLowerCase()}`}
                    >
                      {review.arbiter.confidence} CONFIDENCE
                    </span>
                    <span
                      className={`rec-badge rec-${review.arbiter.decision.toLowerCase()}`}
                    >
                      {review.arbiter.decision}
                    </span>
                  </div>
                </div>
                <div className="card-body">
                  <p className="main-arg">{review.arbiter.mainArgument}</p>
                  {review.arbiter.strongestCounterargument && (
                    <div className="counter-arg">
                      <strong>Counterweight:</strong>{" "}
                      {review.arbiter.strongestCounterargument}
                    </div>
                  )}
                </div>
              </div>
            )}
            {review.arbiter?.whatWouldChange &&
              review.arbiter.whatWouldChange.length > 0 && (
                <div className="change-condition-card">
                  <div className="change-condition-header">
                    <Zap size={14} /> WOULD RE-EVALUATE IF:
                  </div>
                  <ul>
                    {review.arbiter.whatWouldChange.map((condition, idx) => (
                      <li key={idx}>{condition}</li>
                    ))}
                  </ul>
                </div>
              )}
          </div>
        ) : (
          <div className="drawer-loading-box">
            <div className="loading-spinner" />
            <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
              Assembling agent evidence review…
            </span>
          </div>
        )}
        <div className="drawer-actions">
          <button
            className="dark-btn primary-action"
            onClick={() => onApplyTransfer(transfer.out.id, transfer.in.id)}
          >
            ⚡ Make this transfer
          </button>
          <button className="ghost-btn secondary-action" onClick={onClose}>
            Close review
          </button>
          <button
            className="ghost-btn secondary-action"
            onClick={() => {
              onCompare();
              onClose();
            }}
          >
            Compare players
          </button>
        </div>
      </aside>
    </div>
  );
}

function PlayerDrawer({
  player,
  horizon,
  bank,
  squad,
  catalog,
  onClose,
  onAsk,
  onReviewTransfer,
}: {
  player: Player;
  horizon: number;
  bank: number;
  squad: Player[];
  catalog: Player[];
  onClose: () => void;
  onAsk: (p: Player) => void;
  onReviewTransfer: (t: Transfer) => void;
}) {
  const best = transfers(horizon, bank, 1, squad, catalog).find(
    (t) => t.out.id === player.id,
  );
  const alert = priceMovementAlert(player);
  const upcomingFixtures = getPlayerUpcomingFixtures(player, 5);
  const roleProjection = projectionBreakdown(player, horizon);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="why-drawer player-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="player-drawer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <div>
            <p className="eyebrow">PLAYER DETAIL</p>
            <h2 id="player-drawer-title">{player.name}</h2>
            <p className="muted">
              {player.club} · {player.position} · £{player.price.toFixed(1)}m
            </p>
          </div>
          <button
            className="close"
            aria-label="Close player details"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="player-detail-hero">
          <span className="shirt" style={{ background: getPlayerShirtColor(player) }}>
            {player.position}
          </span>
          <div>
            <div className="hero-stat-value">
              {horizonProjection(player, horizon)} <small>pts</small>
            </div>
            <div className="hero-stat-meta">
              {horizon}-GW projected score · {roleProjection.expectedMinutes.toFixed(0)} expected mins
            </div>
            {player.storedForecast?.horizon === horizon && (
              <div className="hero-stat-meta">Outcome range under current assumptions: {player.storedForecast.p10Points.toFixed(1)}–{player.storedForecast.p90Points.toFixed(1)} pts (p10–p90)</div>
            )}
          </div>
        </div>
        {player.status === "i" || player.minutes === 0 ? (
          <div className="injury-alert-box red">
            <div className="injury-alert-title">
              🚑 INJURY / AVAILABILITY ALERT
            </div>
            <div className="injury-alert-desc">
              {player.news || "Injured - 0% chance of playing"}
            </div>
            <div className="injury-alert-note">
              Expected minutes are set to 0.0, resulting in 0 projected points
              over the {horizon}-GW horizon.
            </div>
          </div>
        ) : player.status === "d" ||
          (player.minutes > 0 && player.minutes <= 75) ? (
          <div className="injury-alert-box yellow">
            <div className="injury-alert-title">
              ⚠️ AVAILABILITY RISK ({player.minutes}% EXPECTED MINS)
            </div>
            <div className="injury-alert-desc">
              {player.news ||
                `Player expected minutes are discounted to ${player.minutes}% availability.`}
            </div>
          </div>
        ) : null}
        <div className="detail-grid">
          <div className="stat-card">
            <span className="stat-label">1 GW</span>
            <span className="stat-val">
              {horizonProjection(player, 1)} <small>pts</small>
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-label">3 GW</span>
            <span className="stat-val">
              {horizonProjection(player, 3)} <small>pts</small>
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-label">5 GW</span>
            <span className="stat-val">
              {horizonProjection(player, 5)} <small>pts</small>
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-label">FORM</span>
            <span className="stat-val">{player.form.toFixed(1)}</span>
          </div>
        </div>
        <div className="drawer-section">
          <span className="section-label">MARKET MOMENTUM & PRICE RISK</span>
          <div className="momentum-row">
            <span>
              <b>+{((player.transfersIn || 0) / 1000).toFixed(1)}k</b> in /{" "}
              <b>{((player.transfersOut || 0) / 1000).toFixed(1)}k</b> out
            </span>
            {alert === "RISING_SOON" && (
              <span className="price-pill green">🔥 Price rise likely</span>
            )}
            {alert === "FALLING_SOON" && (
              <span className="price-pill red">⚠️ Price drop risk</span>
            )}
            {alert === "STABLE" && (
              <span className="price-pill">Price stable</span>
            )}
          </div>
        </div>
        <div className="drawer-section">
          <div className="fixture-run-container">
            <div className="fixture-run-header">
              <span className="section-label" style={{ margin: 0 }}>
                UPCOMING FIXTURES (NEXT 5 GWs)
              </span>
              <div className="fdr-legend">
                <span className="fdr-legend-item fdr-2">Easy</span>
                <span className="fdr-legend-item fdr-3">Avg</span>
                <span className="fdr-legend-item fdr-4">Hard</span>
              </div>
            </div>
            <div className="fixture-run">
              {upcomingFixtures.map((f, i) => (
                <div
                  key={f.gameweek}
                  className={`fdr-badge fdr-${f.difficulty} ${i < horizon ? "in-horizon" : "out-horizon"}`}
                  title={`GW${f.gameweek}: vs ${f.opponent} (${f.venue}) - Difficulty FDR ${f.difficulty}/5`}
                >
                  <span className="fdr-gw">GW{f.gameweek}</span>
                  <span className="fdr-opp">
                    {f.opponent} <small>({f.venue})</small>
                  </span>
                  <span className="fdr-diff-label">FDR {f.difficulty}</span>
                </div>
              ))}
            </div>
            <small className="muted">
              Highlighted cards indicate your active {horizon}-GW planning
              horizon.
            </small>
          </div>
        </div>
        <div className="drawer-section">
          <span className="section-label">REPLACEMENT OPPORTUNITY</span>
          {best ? (
            <button
              className="replacement-card"
              onClick={() => onReviewTransfer(best)}
            >
              <div className="rep-names">
                <span className="out">{best.out.name}</span>
                <ArrowRight size={14} />
                <span className="in">{best.in.name}</span>
              </div>
              <div className="rep-gain">+{best.net} net pts</div>
              <span className="replacement-review">Review move →</span>
            </button>
          ) : (
            <p className="no-replacement">✓ No immediate replacement upgrade</p>
          )}
        </div>
        <div className="drawer-actions">
          <button className="dark-btn" onClick={() => onAsk(player)}>
            Ask about this player
          </button>
          <button className="ghost-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </aside>
    </div>
  );
}

import { Component, type ReactNode, type ErrorInfo } from "react";

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught UI Error:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "40px 20px", color: "#fff", background: "#0b1329", minHeight: "100vh", fontFamily: "sans-serif", textAlign: "center" }}>
          <h2>Application Error</h2>
          <p style={{ color: "#f87171", margin: "16px 0", fontSize: "14px" }}>
            {this.state.error?.message || "An unexpected error occurred during rendering."}
          </p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{ padding: "10px 20px", background: "#3b82f6", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold" }}
          >
            Reload Application
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

export default App;
