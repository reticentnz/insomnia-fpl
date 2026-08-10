import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  bestXI,
  benchOrder,
  buildDraftImprovementPlan,
  buildLegalDefaultSquad,
  buildLegalRemainingSquad,
  draftSquadScore,
  getSquad,
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
  type FixtureTickerItem,
  type DraftImprovementPlan,
  type Player,
  type Transfer,
} from "./domain";
import {
  fetchLiveCatalog,
  fetchPublicSquad,
  parseTeamId,
  fetchLLMExplanation,
  fetchFplAccount,
  getUserProfile,
  saveUserProfile,
  deleteUserProfile,
  challengeSquad,
  SquadChallengeError,
  updatePlayerSignalStatus,
  createManualPlayerSignal,
  fetchPlayerSignals,
  fetchLeagueDetails,
  type FplAccount,
  type FplLeagueSummary,
  type LeagueDetailsResponse,
  type LeagueRival,
  type SquadChallengeResult,
  fetchAllSignals,
  ingestSignalText,
  fetchSignalConfig,
  saveSignalConfig,
  type SignalSourceConfig,
  DEFAULT_SIGNAL_SOURCE_CONFIG,
  fetchSystemStatus,
  hasCompletedOnboarding,
  completeOnboarding,
  resetOnboarding,
  type SystemStatus,
} from "./integrations";
import type { PlayerSignal } from "./player-signals";
import { createToolContext } from "./intelligence";
import { reviewDecision, type DecisionReview } from "./decision-review";
import { projectionBreakdown } from "./model";
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
let players = demoPlayers;

const primaryIcons = {
  "My Team": Users,
  Transfers: ArrowRight,
  Players: ListFilter,
  Signals: Radio,
  Leagues: Trophy,
  Ask: Bot,
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
      <span className="shirt" style={{ background: p.colour }}>
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
  const [fplAccount, setFplAccount] = useState<FplAccount | null>(() => {
    try {
      const stored =
        localStorage.getItem("insomnia-fpl-account") ||
        localStorage.getItem("fplgod-account");
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  const [onboardingModalOpen, setOnboardingModalOpen] = useState<boolean>(() => {
    return !hasCompletedOnboarding() && !fplAccount;
  });
  const [syncingAccount, setSyncingAccount] = useState(false);
  const [userName, setUserName] = useState<string>(() => {
    try {
      return (
        localStorage.getItem("insomnia-fpl-user-name") ||
        localStorage.getItem("fplgod-user-name") ||
        "Alex"
      );
    } catch {
      return "Alex";
    }
  });
  const [hadSavedSquad] = useState(() => {
    try {
      return Boolean(
        localStorage.getItem("insomnia-fpl-squad") ||
          localStorage.getItem("fplgod-squad"),
      );
    } catch {
      return false;
    }
  });
  const [selectedIds, setSelectedIds] = useState<number[]>(() => {
    try {
      return (
        JSON.parse(
          localStorage.getItem("insomnia-fpl-squad") ||
            localStorage.getItem("fplgod-squad") ||
            "null",
        ) || squadIds
      );
    } catch {
      return squadIds;
    }
  });
  const [manager, setManager] = useState<ManagerSettings>(() => {
    try {
      return (
        JSON.parse(
          localStorage.getItem("insomnia-fpl-manager-settings") ||
            localStorage.getItem("fplgod-manager-settings") ||
            "null",
        ) || { bank: 1.2, freeTransfers: 1 }
      );
    } catch {
      return { bank: 1.2, freeTransfers: 1 };
    }
  });
  const [review, setReview] = useState<DecisionReview | null>(null);
  const [explanationReview, setExplanationReview] =
    useState<DecisionReview | null>(null);
  const [explanationTransfer, setExplanationTransfer] =
    useState<Transfer | null>(null);
  const [playerDetail, setPlayerDetail] = useState<Player | null>(null);
  const [livePlayers, setLivePlayers] = useState<Player[] | null>(null);
  const [catalogMode, setCatalogMode] = useState<
    "loading" | "live" | "demo-conflict" | "demo-offline"
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
  const [apiKey, setApiKey] = useState<string>(() => {
    try {
      return (
        localStorage.getItem("insomnia-fpl-ai-key") ||
        localStorage.getItem("fplgod-ai-key") ||
        ""
      );
    } catch {
      return "";
    }
  });
  const [aiProvider, setAiProvider] = useState<string>(() => {
    try {
      return (
        localStorage.getItem("insomnia-fpl-ai-provider") ||
        localStorage.getItem("fplgod-ai-provider") ||
        "gemini"
      );
    } catch {
      return "gemini";
    }
  });
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [squadChallenge, setSquadChallenge] =
    useState<SquadChallengeResult | null>(() => {
      try {
        const saved =
          localStorage.getItem("insomnia-fpl-squad-challenge-result") ||
          localStorage.getItem("fplgod-squad-challenge-result");
        return saved ? JSON.parse(saved) : null;
      } catch {
        return null;
      }
    });
  const [challengeLoading, setChallengeLoading] = useState(false);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [challengeRawOutput, setChallengeRawOutput] = useState<string>("");
  const [challengeOutputTypes, setChallengeOutputTypes] = useState<string[]>([]);
  const [targetSwapPlayer, setTargetSwapPlayer] = useState<Player | null>(null);
  const [activeChip, setActiveChip] = useState<ChipType>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [copiedExport, setCopiedExport] = useState(false);
  const [initialClear, setInitialClear] = useState(false);
  const [lockedIds, setLockedIds] = useState<number[]>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("insomnia-fpl-locked-players") ||
          localStorage.getItem("fplgod-locked-players") ||
          "[]",
      );
    } catch {
      return [];
    }
  });
  const debugEnabled = useMemo(
    () => new URLSearchParams(window.location.search).has("debug"),
    [],
  );
  const icons = debugEnabled
    ? { ...primaryIcons, "Model Debug": Gauge }
    : primaryIcons;
  const catalog = livePlayers && livePlayers.length > 0 ? livePlayers : [];
  const squad = useMemo(
    () =>
      selectedIds
        .map((id) => catalog.find((p) => p.id === id))
        .filter(Boolean) as Player[],
    [selectedIds, catalog],
  );
  const draftMode = isInitialDraftPeriod(currentGameweek, deadlineTime);
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
    let active = true;
    fetchLiveCatalog()
      .then((data) => {
        if (!active) return;
        setLivePlayers(data.players);
        setCapturedAt(data.capturedAt || null);
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
          }
        }
      })
      .catch(() => {
        setLivePlayers([]);
        setCatalogMode("demo-offline");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (squadChallenge) {
      try {
        localStorage.setItem(
          "insomnia-fpl-squad-challenge-result",
          JSON.stringify(squadChallenge),
        );
      } catch {}
    } else {
      try {
        localStorage.removeItem("insomnia-fpl-squad-challenge-result");
        localStorage.removeItem("fplgod-squad-challenge-result");
      } catch {}
    }
  }, [squadChallenge]);

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
    getUserProfile().then(({ account, selectedIds: serverIds }) => {
      if (account) {
        setFplAccount(account);
        localStorage.setItem("insomnia-fpl-account", JSON.stringify(account));
        if (serverIds && serverIds.length === 15) {
          setSelectedIds(serverIds);
          localStorage.setItem("insomnia-fpl-squad", JSON.stringify(serverIds));
        }
      }
    });
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
  const saveSquad = (ids: number[], nextLockedIds = lockedIds) => {
    const validLocks = nextLockedIds.filter((id) => ids.includes(id));
    setSelectedIds(ids);
    setLockedIds(validLocks);
    // Evidence is scoped to the exact squad that was challenged. Once the
    // planned squad changes, keeping the old result would surface findings
    // for players who may no longer be in the squad.
    setSquadChallenge(null);
    setChallengeError(null);
    setChallengeRawOutput("");
    setChallengeOutputTypes([]);
    localStorage.setItem("insomnia-fpl-squad", JSON.stringify(ids));
    localStorage.setItem("insomnia-fpl-locked-players", JSON.stringify(validLocks));
    if (fplAccount) {
      saveUserProfile(fplAccount, ids);
    }
    setEditing(false);
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
  activeApplyDraftPlan = applyDraftPlan;
  const undoTransfer = () => {
    if (!previousSquad) return;
    saveSquad(previousSquad);
    setPreviousSquad(null);
    setToast({ message: "Planned squad restored." });
  };
  const saveManager = (next: ManagerSettings) => {
    setManager(next);
    localStorage.setItem("insomnia-fpl-manager-settings", JSON.stringify(next));
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
  const runSquadChallenge = async () => {
    if (!squad.length) return;
    setChallengeLoading(true);
    setChallengeError(null);
    setChallengeRawOutput("");
    setChallengeOutputTypes([]);
    setSquadChallenge(null);
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
      setSquadChallenge(result);
    } catch (error) {
      setChallengeError(
        error instanceof Error ? error.message : "Squad challenge failed",
      );
      if (error instanceof SquadChallengeError) {
        setChallengeRawOutput(error.rawOutput);
        setChallengeOutputTypes(error.outputTypes);
      }
    } finally {
      setChallengeLoading(false);
    }
  };
  const reviewSquadSignal = async (
    signal: PlayerSignal,
    status: "VERIFIED" | "REJECTED",
  ) => {
    try {
      const updated = await updatePlayerSignalStatus(String(signal.id), status);
      setSquadChallenge((current) =>
        current
          ? {
              ...current,
              signals: current.signals.map((item) =>
                item.id === signal.id ? { ...item, status: updated.status } : item,
              ),
            }
          : current,
      );
      if (status === "VERIFIED") {
        const data = await fetchLiveCatalog();
        setLivePlayers(data.players);
        setCapturedAt(data.capturedAt || null);
        setToast({
          message:
            "Evidence approved and projections recalculated. Demoted players moved to bench; check Transfers to replace them.",
        });
      }
    } catch (error) {
      setChallengeError(
        error instanceof Error ? error.message : "Could not review evidence",
      );
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
      const ids = res.picks
        .map((p) => p.element)
        .filter((id) => catalog.some((x) => x.id === id));
      if (ids.length === 15) {
        saveSquad(ids);
      }
      setFplAccount(res.account);
      localStorage.setItem("insomnia-fpl-account", JSON.stringify(res.account));
      saveUserProfile(res.account, ids.length === 15 ? ids : selectedIds);

      if (res.account.bank !== undefined) {
        const updatedManager = { ...manager, bank: res.account.bank };
        setManager(updatedManager);
        localStorage.setItem(
          "insomnia-fpl-manager-settings",
          JSON.stringify(updatedManager),
        );
      }

      setToast({
        message: `FPL Account Synced: ${res.account.teamName} (${res.account.totalPoints} pts, GW${res.account.currentGameweek}: ${res.account.gameweekPoints} pts)`,
      });
      setImportModalOpen(false);
      setTeamInput("");
      setTeamMessage("");
    } catch {
      setTeamMessage(
        "Could not sync FPL account. Please check the Team ID or build your squad manually.",
      );
    } finally {
      setSyncingAccount(false);
      setImporting(false);
    }
  };

  const doImport = () => syncAccount();

  const unlinkAccount = () => {
    setFplAccount(null);
    localStorage.removeItem("insomnia-fpl-account");
    localStorage.removeItem("fplgod-account");
    deleteUserProfile();
    setImportModalOpen(false);
    setToast({ message: "Season FPL account unlinked." });
  };
  useEffect(() => {
    fetchSystemStatus().then((status) => setSystemStatus(status));
  }, []);

  const handleOnboardingImport = async (teamIdStr: string) => {
    const idNum = parseTeamId(teamIdStr);
    if (!idNum) {
      return { success: false, error: "Please enter a numeric Team ID or official FPL URL." };
    }
    try {
      const res = await fetchFplAccount(idNum, currentGameweek || 1);
      const ids = res.picks
        .map((p) => p.element)
        .filter((id) => catalog.some((x) => x.id === id));
      if (ids.length === 15) {
        saveSquad(ids);
      }
      setFplAccount(res.account);
      localStorage.setItem("insomnia-fpl-account", JSON.stringify(res.account));
      saveUserProfile(res.account, ids.length === 15 ? ids : selectedIds);
      if (res.account.bank !== undefined) {
        const updatedManager = { ...manager, bank: res.account.bank };
        setManager(updatedManager);
        localStorage.setItem(
          "insomnia-fpl-manager-settings",
          JSON.stringify(updatedManager),
        );
      }
      return { success: true, managerName: res.account.managerName };
    } catch {
      return { success: false, error: "Could not find FPL account with that ID." };
    }
  };

  const handleOnboardingComplete = (data: { managerName: string; apiKey?: string; provider?: string }) => {
    setUserName(data.managerName);
    localStorage.setItem("insomnia-fpl-user-name", data.managerName);
    localStorage.setItem("fplgod-user-name", data.managerName);
    completeOnboarding();
    setOnboardingModalOpen(false);
    setToast({ message: `Welcome to Insomnia FPL, ${data.managerName}!` });
  };

  const handleOnboardingSkip = () => {
    completeOnboarding();
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
            <p className="eyebrow">
              GAMEWEEK {currentGameweek ?? 1} <span>·</span>{" "}
              {formatDeadlineText(deadlineTime)}
            </p>
            <h1>{tab === "My Team" ? getGreeting(userName) : tab}</h1>
            <p className="muted">
              {tab === "My Team"
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
                localStorage.setItem("insomnia-fpl-user-name", n.trim());
              }
            }}
          >
            {getInitials(userName)}
          </button>
        </header>
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
        {tab !== "Ask" && tab !== "Model Debug" && tab !== "Leagues" && tab !== "Signals" && (
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
        {tab === "Players" ? (
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
            onManualOverride={handleManualOverride}
            weakest={weakest}
            decision={decision}
            freeTransfers={manager.freeTransfers}
            draftMode={draftMode}
            draftPlan={draftPlan}
            onApplyDraft={applyDraftPlan}
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
        ) : tab === "Signals" ? (
          <SignalsTab
            catalog={catalog}
            currentGameweek={currentGameweek ?? 1}
            onSelectPlayer={setPlayerDetail}
            onReviewSignal={reviewSquadSignal}
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
              <span className="chip-gain-tag">+{item.projectedGain} xPts</span>
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
  onImportTeam: (teamIdStr: string) => Promise<{ success: boolean; managerName?: string; error?: string }>;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [teamInput, setTeamInput] = useState("");
  const [managerName, setManagerName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState("openai");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const handleImport = async () => {
    if (!teamInput.trim()) {
      setErrorMsg("Please enter an FPL Team ID or team URL.");
      return;
    }
    setLoading(true);
    setErrorMsg("");
    const res = await onImportTeam(teamInput);
    setLoading(false);
    if (res.success) {
      if (res.managerName && !managerName) {
        setManagerName(res.managerName);
      }
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
                    <span className="mini-shirt" style={{ background: p.colour }}>
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
            Save squad
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
              <span className="mini-shirt" style={{ background: t.out.colour }}>
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
              <span className="mini-shirt" style={{ background: t.in.colour }}>
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
      <div className="panel table">
        <div className="tr th">
          <span>PLAYER</span>
          <span>FIXTURES</span>
          <span>FORM</span>
          <span>MINUTES</span>
          <span>{horizon}-GW PROJ.</span>
          <span>VALUE</span>
        </div>
        {filtered.map((p) => (
          <div className="tr" key={p.id}>
            <div className="name-cell">
              <span className="mini-shirt" style={{ background: p.colour }}>
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
            <span>{p.form.toFixed(1)}</span>
            <span>{p.minutes}%</span>
            <span>
              <b>{horizonProjection(p, horizon)}</b> pts
            </span>
            <span className="value">{(p.projection / p.price).toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
function ModelDebug({ horizon }: { horizon: number }) {
  const rows = players
    .map((p) => ({
      player: p,
      one: projectionBreakdown(p, 1),
      three: projectionBreakdown(p, 3),
      five: projectionBreakdown(p, 5),
    }))
    .sort((a, b) => b.five.finalExpectedPoints - a.five.finalExpectedPoints);
  return (
    <div className="content">
      <div className="page-intro">
        <div>
          <p className="eyebrow">
            DEVELOPER DIAGNOSTICS · MODEL {rows[0]?.one.modelVersion}
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
      <div className="panel debug-table">
        <div className="debug-row debug-head">
          <span>PLAYER</span>
          <span>BASELINE</span>
          <span>FIXTURE</span>
          <span>MINUTES</span>
          <span>ATTACK</span>
          <span>CS</span>
          <span>BONUS</span>
          <span>CARDS</span>
          <span>1 GW</span>
          <span>3 GW</span>
          <span>5 GW</span>
        </div>
        {rows.map(({ player, one, three, five }) => (
          <div className="debug-row" key={player.id}>
            <div className="debug-name">
              <b>{player.name}</b>
              <small>
                {player.club} · {one.modelVersion}
              </small>
            </div>
            <span>{one.baseline.toFixed(1)}</span>
            <span className={one.fixtureAdjustment < 0 ? "negative" : ""}>
              {one.fixtureAdjustment >= 0 ? "+" : ""}
              {one.fixtureAdjustment.toFixed(1)}
            </span>
            <span
              className={one.expectedMinutesAdjustment < 0 ? "negative" : ""}
            >
              {one.expectedMinutesAdjustment >= 0 ? "+" : ""}
              {one.expectedMinutesAdjustment.toFixed(1)}
            </span>
            <span>+{one.attackingContribution.toFixed(1)}</span>
            <span>+{one.cleanSheetContribution.toFixed(1)}</span>
            <span>+{one.bonus.toFixed(1)}</span>
            <span className="negative">{one.cardDeduction.toFixed(1)}</span>
            <strong>{one.finalExpectedPoints.toFixed(1)}</strong>
            <strong>{three.finalExpectedPoints.toFixed(1)}</strong>
            <strong>{five.finalExpectedPoints.toFixed(1)}</strong>
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
  onSelectPlayer?: (p: Player) => void;
  setTab?: (tab: string) => void;
  onManualOverride?: (playerId: number, startProbability: number, note?: string) => void;
  onReplacePlayer?: (p: Player) => void;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
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
              const proposedProb =
                signal.value.startProbability !== undefined
                  ? Math.round(signal.value.startProbability * 100)
                  : null;

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
                          signal.status === "VERIFIED"
                            ? "green"
                            : signal.status === "REJECTED"
                              ? "red"
                              : "amber"
                        }`}
                      >
                        {signal.status === "VERIFIED" ? "✓ VERIFIED · PROJECTIONS UPDATED" : signal.status}
                      </span>
                    </div>

                    <p>{signal.evidenceSummary}</p>

                    <small>
                      {signal.sourceType.replace(/_/g, " ")} · {Math.round(signal.confidence * 100)}% confidence
                      {proposedProb !== null ? ` · proposed start chance ${proposedProb}%` : ""}
                    </small>

                    {signal.status === "VERIFIED" && xPts !== null && (
                      <div className="evidence-impact-tag">
                        ✓ Applied to model: {proposedProb !== null ? `${proposedProb}% start chance` : "Role updated"} → {xPts.toFixed(1)} xPts over {horizon} GWs
                      </div>
                    )}

                    {signal.sourceUrl && (
                      <a href={signal.sourceUrl} target="_blank" rel="noreferrer">
                        Open source ↗
                      </a>
                    )}
                  </div>

                  <div className="evidence-actions">
                    {signal.status === "PENDING" && (
                      <>
                        <button
                          className="dark-btn"
                          onClick={() => onReviewSignal(signal, "VERIFIED")}
                        >
                          Approve & Update
                        </button>
                        <button
                          className="ghost-btn"
                          onClick={() => onReviewSignal(signal, "REJECTED")}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {signal.status === "VERIFIED" && (
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
  onManualOverride,
  weakest,
  decision,
  freeTransfers,
  draftMode,
  draftPlan,
  onApplyDraft,
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
  onApplyDraft: () => void;
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
          <div className="recommend-actions">
            <button className="dark-btn" onClick={onApplyDraft}>
              Apply full restructure
            </button>
            <button className="ghost-btn" onClick={() => setTab("Transfers")}>
              Review all changes
            </button>
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
                      <span className="shirt" style={{ background: p.colour }}>
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
                <span className="shirt" style={{ background: p.colour }}>
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
        onSelectPlayer={onSelectPlayer}
        setTab={setTab}
        onManualOverride={onManualOverride}
        onReplacePlayer={onReplacePlayer}
      />
      <div className="panel table" style={{ marginTop: "20px" }}>
        <div className="panel-head" style={{ padding: "16px 20px 0" }}>
          <div>
            <h2>Full Squad Roster ({squad.length}/15)</h2>
            <p>Click any player to view detailed breakdown & projections</p>
          </div>
        </div>
        <div className="tr th" style={{ marginTop: "12px" }}>
          <span>PLAYER</span>
          <span>SQUAD ROLE</span>
          <span>FIXTURES</span>
          <span>FORM</span>
          <span>MINUTES</span>
          <span>{horizon}-GW PROJ.</span>
          <span>VALUE</span>
        </div>
        {squad.map((p) => {
          const isStarter = starters.has(p.id);
          const isCapt = p.id === captain?.id;
          const isVice = p.id === vice?.id;
          return (
            <button
              className="tr player-row"
              onClick={() => onSelectPlayer(p)}
              key={p.id}
            >
              <div className="name-cell">
                <span className="mini-shirt" style={{ background: p.colour }}>
                  {p.position}
                </span>
                <div>
                  <b>{p.name}</b>
                  <small>
                    {p.club} · £{p.price.toFixed(1)}m
                  </small>
                </div>
              </div>
              <span>
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
              <span>{p.form.toFixed(1)}</span>
              <span>{p.minutes}%</span>
              <span>
                <b>{horizonProjection(p, horizon)}</b> pts
              </span>
              <span className="value">
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
}: {
  catalog: Player[];
  currentGameweek: number;
  onSelectPlayer: (p: Player) => void;
  onReviewSignal: (signal: PlayerSignal, status: "VERIFIED" | "REJECTED") => void;
}) {
  const [signals, setSignals] = useState<PlayerSignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [playerQuery, setPlayerQuery] = useState("");
  const [ingestOpen, setIngestOpen] = useState(false);
  const [ingestText, setIngestText] = useState("");
  const [ingestUrl, setIngestUrl] = useState("");
  const [ingestLoading, setIngestLoading] = useState(false);
  const [ingestResult, setIngestResult] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | number | null>(null);
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

  useEffect(() => {
    loadSignals();
    fetchSignalConfig().then(setSignalConfig).catch(() => {});
  }, [loadSignals]);

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

  async function handleReview(signal: PlayerSignal, status: "VERIFIED" | "REJECTED") {
    setReviewingId(signal.id);
    try {
      await onReviewSignal(signal, status);
      setSignals((prev) =>
        prev.map((s) => (s.id === signal.id ? { ...s, status } : s))
      );
    } finally {
      setReviewingId(null);
    }
  }

  async function handleIngest() {
    if (!ingestText.trim()) return;
    setIngestLoading(true);
    setIngestResult(null);
    try {
      const result = await ingestSignalText({
        text: ingestText,
        sourceUrl: ingestUrl || undefined,
        sourceType: "JOURNALIST",
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
          {(["", "PENDING", "VERIFIED", "REJECTED"] as const).map((s) => (
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
          <b>n8n YouTube Transcription Webhook</b>
          <p>
            Point your n8n HTTP Request node to this endpoint. Send{" "}
            <code>{"{ text, sourceUrl, sourceType: \"YOUTUBE_TRANSCRIPT\", playerHints?, confidence? }"}</code>
            . Player names are auto-resolved and signals are created as{" "}
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
            const proposedProb =
              typeof signal.value?.startProbability === "number"
                ? Math.round(signal.value.startProbability * 100)
                : null;
            const isReviewing = reviewingId === signal.id;

            return (
              <article key={signal.id} className={`signal-card status-${signal.status.toLowerCase()}`}>
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
                    <span className={statusClass(signal.status)}>
                      {signal.status === "VERIFIED" ? "✓ APPLIED" : signal.status}
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
                    {signal.sourceUrl && (
                      <a
                        href={signal.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="signal-source-link"
                      >
                        Source ↗
                      </a>
                    )}
                  </div>
                </div>

                {signal.status === "PENDING" && (
                  <div className="signal-actions">
                    <button
                      className="dark-btn"
                      disabled={isReviewing}
                      onClick={() => handleReview(signal, "VERIFIED")}
                    >
                      {isReviewing ? "…" : "✓ Approve & apply"}
                    </button>
                    <button
                      className="ghost-btn"
                      disabled={isReviewing}
                      onClick={() => handleReview(signal, "REJECTED")}
                    >
                      Reject
                    </button>
                  </div>
                )}
                {signal.status === "VERIFIED" && (
                  <div className="signal-actions">
                    <button
                      className="ghost-btn"
                      disabled={isReviewing}
                      onClick={() => handleReview(signal, "REJECTED")}
                    >
                      Reset
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
  const [teamInput, setTeamInput] = useState<string>("");

  const [savedDefaultId, setSavedDefaultId] = useState<number | null>(() => {
    const raw =
      localStorage.getItem("insomnia-fpl-default-league-id") ||
      localStorage.getItem("fplgod-default-league-id");
    return raw ? Number(raw) : null;
  });

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
    if (fplAccount?.teamId && userLeagues.length === 0 && !discoveringLeagues) {
      setDiscoveringLeagues(true);
      fetchFplAccount(fplAccount.teamId, currentGameweek)
        .then((res) => {
          if (res.account.leagues?.classic) {
            setFetchedLeagues(res.account.leagues.classic);
            const list = res.account.leagues.classic;
            if (list.length > 0 && !selectedLeagueId) {
              const def = savedDefaultId && list.some((x) => x.id === savedDefaultId) ? savedDefaultId : list[0].id;
              setSelectedLeagueId(def);
            }
          }
        })
        .catch(() => {})
        .finally(() => setDiscoveringLeagues(false));
    }
  }, [fplAccount, userLeagues.length, discoveringLeagues, currentGameweek, selectedLeagueId, savedDefaultId]);

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
      localStorage.setItem("insomnia-fpl-default-league-id", String(selectedLeagueId));
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
                  <span className="muted-text">Analyzed top {details.totalAnalyzed} rivals</span>
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
                    Effective Ownership combines starting ownership + captaincy % + 2x Triple Captain % across the top managers in this league.
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
  onApplyDraft,
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
  onApplyDraft: () => void;
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
            <div className="recommend-actions">
              <button className="dark-btn" onClick={onApplyDraft}>Apply full restructure</button>
              <button className="ghost-btn" onClick={() => setTab("Transfers")}>Review all changes</button>
            </div>
          )}
        </div>
        <div className="score-card hero-card">
          <span className="label">PROJECTED SCORE · {horizon} GWs</span>
          <div className="big-number">
            {score.toFixed(1)} <small>pts</small>
          </div>
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
                      <span className="shirt" style={{ background: p.colour }}>
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
              <span className="shirt" style={{ background: player.colour }}>
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
                    style={{ background: t.out.colour }}
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
                    style={{ background: t.in.colour }}
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
        <div className="tr th">
          <span>PLAYER</span>
          <span>OWNED</span>
          <span>FIXTURES</span>
          <span>FORM</span>
          <span>MINUTES</span>
          <span>{horizon}-GW PROJ.</span>
          <span>VALUE</span>
        </div>
        {paginated.map((p) => (
          <button
            className={`tr player-row ${isPlayerInjured(p) ? "injured-row" : ""}`}
            onClick={() => onSelect(p)}
            key={p.id}
          >
            <div className="name-cell">
              <span className="mini-shirt" style={{ background: p.colour }}>
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
            <span data-label="Form">{p.form.toFixed(1)}</span>
            <span data-label="Minutes">{p.minutes}%</span>
            <span data-label={`${horizon}-GW projection`}>
              <b>{horizonProjection(p, horizon)}</b> pts
            </span>
            <span data-label="Value" className="value">
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
          <span className="mini-shirt" style={{ background: player.colour }}>
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
              <span className="shirt" style={{ background: p.colour }}>
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
  onClose,
}: {
  apiKey: string;
  setApiKey: (k: string) => void;
  provider: string;
  setProvider: (p: string) => void;
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
    localStorage.setItem("insomnia-fpl-ai-key", cleanKey);
    localStorage.setItem("insomnia-fpl-ai-provider", provInput);
    onClose();
  };
  const clear = () => {
    setApiKey("");
    localStorage.removeItem("insomnia-fpl-ai-key");
    localStorage.removeItem("fplgod-ai-key");
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
            <Shield size={14} /> Keys are stored locally in your browser and
            used to fetch grounded insights.
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
          <span className="shirt" style={{ background: player.colour }}>
            {player.position}
          </span>
          <div>
            <div className="hero-stat-value">
              {horizonProjection(player, horizon)} <small>pts</small>
            </div>
            <div className="hero-stat-meta">
              {horizon}-GW projected score · {roleProjection.expectedMinutes.toFixed(0)} expected mins
            </div>
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

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<App />);
}

export default App;
