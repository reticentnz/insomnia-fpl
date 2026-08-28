import { horizonProjection as modelHorizonProjection, playerRoleProfile, projectionBreakdown } from "./model.ts";
import type { PlayerRoleProfile } from "./player-signals.ts";

export type Position = "GK" | "DEF" | "MID" | "FWD";
export type FixtureItem = {
  gameweek: number;
  opponent: string;
  venue: "H" | "A";
  difficulty: number;
  /** De-vigged market probability that the player's team keeps a clean sheet. */
  marketCleanSheetProbability?: number;
  strength?: {
    method: "MARKET_XG" | "OFFICIAL_STRENGTH" | "DERIVED_TEAM_RATING";
    attackMultiplier: number;
    defenceMultiplier: number;
    /** Absolute market team-goal expectation before player allocation. */
    marketTeamExpectedGoals?: number;
  };
  /**
   * Per-90 player rates allocated from the fixture's market team xG. These
   * override only goal and assist rates; all other scoring components retain
   * their existing, independently calibrated model.
   */
  attackingRateOverride?: { goalRate: number; assistRate: number; goalShare: number; assistShare: number };
};
export type PlayerStats = {
  minutes: number;
  starts?: number;
  totalPoints?: number;
  goals?: number;
  assists?: number;
  cleanSheets?: number;
  goalsConceded?: number;
  saves?: number;
  bonus?: number;
  bps?: number;
  yellowCards?: number;
  redCards?: number;
  ownGoals?: number;
  penaltiesMissed?: number;
  penaltiesSaved?: number;
  expectedGoals?: number;
  expectedAssists?: number;
  expectedGoalsConceded?: number;
  expectedGoalsPer90?: number;
  expectedAssistsPer90?: number;
  expectedGoalsConcededPer90?: number;
  savesPer90?: number;
  clearancesBlocksInterceptions?: number;
  tackles?: number;
  recoveries?: number;
  defensiveContribution?: number;
  defensiveContributionPer90?: number;
};
export type HistoricalPlayerPrior = {
  sourceSeason: string;
  confidence: number;
  minutes: number;
  starts: number;
  expectedGoalsPer90: number;
  expectedAssistsPer90: number;
  bonusPer90: number;
};
export type Player = {
  id: number;
  name: string;
  club: string;
  transferredRecently?: boolean;
  position: Position;
  price: number;
  /** Exact FPL selling price for an owned player; null means affordability is unknown. */
  sellingPrice?: number | null;
  form: number;
  ownership: number;
  minutes: number;
  expectedMinutes?: number;
  roleProfile?: PlayerRoleProfile;
  /** Confirmed responsibility from reviewed evidence; affects attacking rates, never availability. */
  setPieceRole?: "SET_PIECES" | "PENALTIES" | "PENALTIES_AND_SET_PIECES";
  fixture: string;
  difficulty: number;
  projection: number;
  colour: string;
  status?: string;
  chanceOfPlaying?: number;
  news?: string;
  transfersIn?: number;
  transfersOut?: number;
  active?: boolean;
  stats?: PlayerStats;
  /** Matched prior-season rates used only while current-season evidence is thin. */
  historicalPrior?: HistoricalPlayerPrior;
  upcomingFixtures?: FixtureItem[];
  calibrationFactor?: number;
  dataConfidence?: "LOW" | "MEDIUM" | "HIGH";
  coldStart?: boolean;
  storedForecast?: StoredForecast;
  /** Forecasts are keyed by horizon so the one-GW lineup never falls back to
   * heuristic scores while a longer transfer horizon is selected. */
  storedForecasts?: Partial<Record<number, StoredForecast>>;
};

export type StoredForecast = { runId: string; horizon: number; meanPoints: number; standardDeviation: number; p10Points: number; p50Points: number; p90Points: number; fixtureCount: number; expectedGoals?: number; expectedAssists?: number; goalProbability?: number; assistProbability?: number; cleanSheetProbability?: number; bonusProbability?: number; defensiveContributionProbability?: number };

export const TEAM_COLORS: Record<string, string> = {
  ARS: "#e74c3c",
  AVL: "#8b5cf6",
  BOU: "#ef4444",
  BRE: "#dc2626",
  BHA: "#3b82f6",
  CHE: "#60a5fa",
  COV: "#38bdf8",
  CRY: "#2563eb",
  EVE: "#3b82f6",
  FUL: "#334155",
  HUL: "#f59e0b",
  IPS: "#3b82f6",
  LEE: "#eab308",
  LEI: "#2563eb",
  LIV: "#ef4444",
  LUT: "#f97316",
  MCI: "#60a5fa",
  MUN: "#ef4444",
  NEW: "#334155",
  NFO: "#e31b23",
  SHU: "#ef4444",
  SOU: "#ef4444",
  SUN: "#ef4444",
  TOT: "#1e3a8a",
  WHU: "#7c3aed",
  WOL: "#f59e0b",
};

export function getTeamColor(club: string | undefined | null): string {
  if (!club) return "#64748b";
  const key = club.toUpperCase().trim();
  return TEAM_COLORS[key] || "#64748b";
}

export function getPlayerShirtColor(p: { colour?: string; club?: string } | undefined | null): string {
  if (!p) return "#64748b";
  if (p.colour && p.colour !== "#64748b" && p.colour !== "") return p.colour;
  return getTeamColor(p.club);
}

export function isPlayerInjured(p: Player): boolean {
  return p.status === "i" || p.minutes === 0 || p.chanceOfPlaying === 0;
}

export function isPlayerFlagged(p: Player): boolean {
  return (
    isPlayerInjured(p) ||
    p.status === "d" ||
    p.status === "s" ||
    (p.minutes > 0 && p.minutes <= 75) ||
    (p.chanceOfPlaying !== undefined && p.chanceOfPlaying < 100)
  );
}

export type Transfer = {
  out: Player;
  in: Player;
  gain: number;
  net: number;
  priceDelta: number;
  priceAlert?: "RISING_SOON" | "FALLING_SOON" | "STABLE";
  sellOffWarning?: string;
  outProjection: number;
  inProjection: number;
  hitCost: number;
  equivalentAlternatives?: number;
  selectionAwareGain?: number;
};
export type SquadIssue = { rule: string; detail: string };
export type TransferDecision = {
  transfer: Transfer | null;
  roll: boolean;
  reason: string;
  hitCost: number;
  freeTransfers: number;
};
export type TransferRouteMove = {
  out: Player;
  in: Player;
  outProjection: number;
  inProjection: number;
  priceDelta: number;
};
export type TargetTransferRoute = {
  moves: TransferRouteMove[];
  rawGain: number;
  hitCost: number;
  netGain: number;
  bankAfter: number;
};
export type TargetTransferPlan = {
  target: Player;
  alreadyOwned: boolean;
  directShortfall: number | null;
  routes: TargetTransferRoute[];
};
export type DraftScore = {
  total: number;
  starters: number;
  captain: number;
  vice: number;
  bench: number;
  uncertaintyPenalty: number;
};
export type InitialSquadOptions = {
  lockedPlayerIds?: number[];
  excludedPlayerIds?: number[];
  horizon?: 1 | 3 | 5;
  budget?: number;
};
export type DraftChange = {
  out: Player;
  in: Player;
  priceDelta: number;
  projectionDelta: number;
};
export type DraftImprovementPlan = {
  currentScore: number;
  optimizedScore: number;
  gain: number;
  currentCost: number;
  optimizedCost: number;
  changes: DraftChange[];
  squad: Player[];
};

export const INITIAL_SQUAD_BUDGET = 100;
export const TRANSFER_GAIN_THRESHOLDS: Record<1 | 3 | 5, number> = {
  1: 0.5,
  3: 1,
  5: 1.5,
};

export function isInitialDraftPeriod(
  currentGameweek: number | null,
  deadline: string | null,
  now = Date.now(),
) {
  if ((currentGameweek ?? 1) !== 1) return false;
  if (!deadline) return true;
  const deadlineTime = new Date(deadline).getTime();
  return Number.isFinite(deadlineTime) && now < deadlineTime;
}

export function formatDeadlineDate(deadlineIso: string | null): string {
  if (!deadlineIso) return "";
  const time = Date.parse(deadlineIso);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  return date.toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDeadlineRemaining(deadlineIso: string | null, now = Date.now()): string {
  if (!deadlineIso) return "";
  const deadlineMs = new Date(deadlineIso).getTime();
  if (!Number.isFinite(deadlineMs)) return "";
  const diffMs = deadlineMs - now;
  if (diffMs <= 0) return "Deadline passed";
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);
  const remHours = diffHours % 24;
  if (diffDays >= 2) {
    return remHours > 0 ? `${diffDays}d ${remHours}h` : `${diffDays} days`;
  }
  if (diffHours >= 1) {
    const remMins = diffMins % 60;
    return remMins > 0 ? `${diffHours}h ${remMins}m` : `${diffHours} hours`;
  }
  return `${Math.max(1, diffMins)}m`;
}

export function formatDeadlineText(
  deadlineIso: string | null,
  nextGameweek?: number | null,
  currentGameweek?: number | null,
  now = Date.now(),
): string {
  if (!deadlineIso) return "Season complete";
  const remaining = formatDeadlineRemaining(deadlineIso, now);
  const formattedDate = formatDeadlineDate(deadlineIso);
  if (remaining === "Deadline passed" || !remaining) return "Deadline passed";

  const targetPrefix = nextGameweek && currentGameweek && nextGameweek > currentGameweek
    ? `GW${nextGameweek} Deadline:`
    : "Deadline:";

  return `${targetPrefix} ${formattedDate} (${remaining} left)`;
}

export function computeDraftFingerprint(
  playerIds: number[],
  lockedIds: number[] = [],
): string {
  const sortedPlayers = [...playerIds].map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  const sortedLocks = [...lockedIds].map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  return `${sortedPlayers.join(",")}|${sortedLocks.join(",")}`;
}

export function computeDraftPlayerFingerprint(playerIds: number[]): string {
  return [...playerIds].map(Number).filter(Number.isInteger).sort((a, b) => a - b).join(",");
}

export function resolveSquadSaveTarget(params: { draftMode: boolean }): "USER_PREFERENCES" | "PLANS_API" {
  return params.draftMode ? "USER_PREFERENCES" : "PLANS_API";
}

export function resolvePlanningMode(params: {
  hasCurrentSeasonOfficialSquad: boolean;
  officialSnapshotManagerAccountId?: string | null;
  officialSnapshotSeason?: string | null;
  activationManagerAccountId?: string | null;
  activationSeason?: string | null;
  currentSeason?: string | null;
  activeManagerAccountId?: string | null;
  isMetadataLoaded?: boolean;
}): "LOADING" | "DRAFT" | "SEASON" {
  if (params.isMetadataLoaded === false || !params.currentSeason) {
    return "LOADING";
  }
  if (
    params.activationManagerAccountId &&
    params.activeManagerAccountId &&
    params.activationManagerAccountId === params.activeManagerAccountId &&
    params.activationSeason === params.currentSeason
  ) {
    return "SEASON";
  }
  if (
    params.hasCurrentSeasonOfficialSquad &&
    params.officialSnapshotManagerAccountId &&
    params.activeManagerAccountId &&
    params.officialSnapshotManagerAccountId === params.activeManagerAccountId &&
    params.officialSnapshotSeason === params.currentSeason
  ) {
    return "SEASON";
  }
  return "DRAFT";
}

export function evaluateModeTransition(params: {
  currentMode: "DRAFT" | "SEASON";
  hasOfficialSquad: boolean;
  isEditorDirty: boolean;
}): {
  targetMode: "DRAFT" | "SEASON";
  requiresPrompt: boolean;
} {
  if (params.hasOfficialSquad && params.currentMode === "DRAFT") {
    if (params.isEditorDirty) {
      return { targetMode: "DRAFT", requiresPrompt: true };
    }
    return { targetMode: "SEASON", requiresPrompt: false };
  }
  return { targetMode: params.currentMode, requiresPrompt: false };
}

export const CLUB_FIXTURES: Record<string, FixtureItem[]> = {
  ARS: [
    { gameweek: 1, opponent: "COV", venue: "H", difficulty: 2 },
    { gameweek: 2, opponent: "FUL", venue: "A", difficulty: 2 },
    { gameweek: 3, opponent: "LIV", venue: "H", difficulty: 4 },
    { gameweek: 4, opponent: "NFO", venue: "A", difficulty: 3 },
    { gameweek: 5, opponent: "CHE", venue: "H", difficulty: 4 },
  ],
  LIV: [
    { gameweek: 1, opponent: "NEW", venue: "A", difficulty: 3 },
    { gameweek: 2, opponent: "BOU", venue: "H", difficulty: 2 },
    { gameweek: 3, opponent: "ARS", venue: "A", difficulty: 4 },
    { gameweek: 4, opponent: "CHE", venue: "H", difficulty: 4 },
    { gameweek: 5, opponent: "EVE", venue: "A", difficulty: 3 },
  ],
  EVE: [
    { gameweek: 1, opponent: "WOL", venue: "A", difficulty: 3 },
    { gameweek: 2, opponent: "ARS", venue: "H", difficulty: 4 },
    { gameweek: 3, opponent: "BRE", venue: "A", difficulty: 3 },
    { gameweek: 4, opponent: "NEW", venue: "A", difficulty: 4 },
    { gameweek: 5, opponent: "MCI", venue: "A", difficulty: 5 },
  ],
  MCI: [
    { gameweek: 1, opponent: "BOU", venue: "H", difficulty: 2 },
    { gameweek: 2, opponent: "BHA", venue: "A", difficulty: 3 },
    { gameweek: 3, opponent: "ARS", venue: "A", difficulty: 5 },
    { gameweek: 4, opponent: "AVL", venue: "H", difficulty: 3 },
    { gameweek: 5, opponent: "EVE", venue: "H", difficulty: 2 },
  ],
  BRE: [
    { gameweek: 1, opponent: "CRY", venue: "H", difficulty: 2 },
    { gameweek: 2, opponent: "MUN", venue: "A", difficulty: 4 },
    { gameweek: 3, opponent: "EVE", venue: "H", difficulty: 2 },
    { gameweek: 4, opponent: "CHE", venue: "A", difficulty: 4 },
    { gameweek: 5, opponent: "BOU", venue: "H", difficulty: 3 },
  ],
  AVL: [
    { gameweek: 1, opponent: "CHE", venue: "A", difficulty: 4 },
    { gameweek: 2, opponent: "CRY", venue: "H", difficulty: 3 },
    { gameweek: 3, opponent: "MCI", venue: "A", difficulty: 5 },
    { gameweek: 4, opponent: "NFO", venue: "H", difficulty: 2 },
    { gameweek: 5, opponent: "SOU", venue: "A", difficulty: 2 },
  ],
  LEI: [
    { gameweek: 1, opponent: "NFO", venue: "H", difficulty: 3 },
    { gameweek: 2, opponent: "CHE", venue: "H", difficulty: 4 },
    { gameweek: 3, opponent: "NEW", venue: "H", difficulty: 4 },
    { gameweek: 4, opponent: "MCI", venue: "A", difficulty: 5 },
    { gameweek: 5, opponent: "BOU", venue: "A", difficulty: 3 },
  ],
  CHE: [
    { gameweek: 1, opponent: "AVL", venue: "H", difficulty: 3 },
    { gameweek: 2, opponent: "LEI", venue: "A", difficulty: 2 },
    { gameweek: 3, opponent: "ARS", venue: "A", difficulty: 5 },
    { gameweek: 4, opponent: "BRE", venue: "H", difficulty: 3 },
    { gameweek: 5, opponent: "TOT", venue: "A", difficulty: 4 },
  ],
  NFO: [
    { gameweek: 1, opponent: "LEI", venue: "A", difficulty: 3 },
    { gameweek: 2, opponent: "WHU", venue: "H", difficulty: 3 },
    { gameweek: 3, opponent: "BOU", venue: "A", difficulty: 3 },
    { gameweek: 4, opponent: "ARS", venue: "H", difficulty: 5 },
    { gameweek: 5, opponent: "AVL", venue: "A", difficulty: 4 },
  ],
  WHU: [
    { gameweek: 1, opponent: "TOT", venue: "H", difficulty: 4 },
    { gameweek: 2, opponent: "NEW", venue: "H", difficulty: 3 },
    { gameweek: 3, opponent: "NFO", venue: "A", difficulty: 3 },
    { gameweek: 4, opponent: "WOL", venue: "A", difficulty: 3 },
    { gameweek: 5, opponent: "SOU", venue: "H", difficulty: 2 },
  ],
  CRY: [
    { gameweek: 1, opponent: "BRE", venue: "A", difficulty: 4 },
    { gameweek: 2, opponent: "AVL", venue: "A", difficulty: 4 },
    { gameweek: 3, opponent: "IPS", venue: "H", difficulty: 2 },
    { gameweek: 4, opponent: "MUN", venue: "H", difficulty: 3 },
    { gameweek: 5, opponent: "NEW", venue: "A", difficulty: 4 },
  ],
  NEW: [
    { gameweek: 1, opponent: "LIV", venue: "H", difficulty: 4 },
    { gameweek: 2, opponent: "WHU", venue: "A", difficulty: 3 },
    { gameweek: 3, opponent: "LEI", venue: "A", difficulty: 2 },
    { gameweek: 4, opponent: "EVE", venue: "H", difficulty: 2 },
    { gameweek: 5, opponent: "CRY", venue: "H", difficulty: 3 },
  ],
  MUN: [
    { gameweek: 1, opponent: "CRY", venue: "A", difficulty: 3 },
    { gameweek: 2, opponent: "BRE", venue: "H", difficulty: 2 },
    { gameweek: 3, opponent: "CHE", venue: "A", difficulty: 4 },
    { gameweek: 4, opponent: "FUL", venue: "H", difficulty: 2 },
    { gameweek: 5, opponent: "MCI", venue: "A", difficulty: 5 },
  ],
  TOT: [
    { gameweek: 1, opponent: "WHU", venue: "A", difficulty: 3 },
    { gameweek: 2, opponent: "EVE", venue: "H", difficulty: 2 },
    { gameweek: 3, opponent: "NEW", venue: "A", difficulty: 4 },
    { gameweek: 4, opponent: "ARS", venue: "H", difficulty: 5 },
    { gameweek: 5, opponent: "CHE", venue: "H", difficulty: 4 },
  ],
  BHA: [
    { gameweek: 1, opponent: "EVE", venue: "H", difficulty: 2 },
    { gameweek: 2, opponent: "MCI", venue: "H", difficulty: 4 },
    { gameweek: 3, opponent: "ARS", venue: "A", difficulty: 5 },
    { gameweek: 4, opponent: "IPS", venue: "H", difficulty: 2 },
    { gameweek: 5, opponent: "NFO", venue: "A", difficulty: 3 },
  ],
  FUL: [
    { gameweek: 1, opponent: "MUN", venue: "H", difficulty: 3 },
    { gameweek: 2, opponent: "ARS", venue: "H", difficulty: 4 },
    { gameweek: 3, opponent: "LEI", venue: "A", difficulty: 2 },
    { gameweek: 4, opponent: "WHU", venue: "H", difficulty: 3 },
    { gameweek: 5, opponent: "NEW", venue: "A", difficulty: 4 },
  ],
  BOU: [
    { gameweek: 1, opponent: "MCI", venue: "A", difficulty: 5 },
    { gameweek: 2, opponent: "LIV", venue: "A", difficulty: 5 },
    { gameweek: 3, opponent: "NFO", venue: "H", difficulty: 2 },
    { gameweek: 4, opponent: "CHE", venue: "A", difficulty: 4 },
    { gameweek: 5, opponent: "BRE", venue: "A", difficulty: 3 },
  ],
  WOL: [
    { gameweek: 1, opponent: "EVE", venue: "H", difficulty: 3 },
    { gameweek: 2, opponent: "CHE", venue: "H", difficulty: 4 },
    { gameweek: 3, opponent: "NFO", venue: "A", difficulty: 3 },
    { gameweek: 4, opponent: "WHU", venue: "H", difficulty: 3 },
    { gameweek: 5, opponent: "ARS", venue: "A", difficulty: 5 },
  ],
  IPS: [
    { gameweek: 1, opponent: "CRY", venue: "A", difficulty: 3 },
    { gameweek: 2, opponent: "MCI", venue: "A", difficulty: 5 },
    { gameweek: 3, opponent: "FUL", venue: "H", difficulty: 3 },
    { gameweek: 4, opponent: "BHA", venue: "A", difficulty: 4 },
    { gameweek: 5, opponent: "SOU", venue: "H", difficulty: 2 },
  ],
  SOU: [
    { gameweek: 1, opponent: "NEW", venue: "A", difficulty: 4 },
    { gameweek: 2, opponent: "NFO", venue: "H", difficulty: 3 },
    { gameweek: 3, opponent: "BRE", venue: "A", difficulty: 3 },
    { gameweek: 4, opponent: "MUN", venue: "H", difficulty: 4 },
    { gameweek: 5, opponent: "IPS", venue: "A", difficulty: 2 },
  ],
};

export function getPlayerUpcomingFixtures(p: Player, limit = 5): FixtureItem[] {
  if (p.upcomingFixtures) return p.upcomingFixtures.slice(0, limit);
  const clubFixtures = CLUB_FIXTURES[p.club];
  if (clubFixtures && clubFixtures.length > 0) {
    return clubFixtures.slice(0, limit);
  }
  const opp = p.fixture.split(" ")[0] || "OPP";
  const venue = p.fixture.includes("(A)") ? "A" : "H";
  return [{ gameweek: 1, opponent: opp, venue, difficulty: p.difficulty }];
}

export function netTransfers(p: Player): number {
  return (p.transfersIn || 0) - (p.transfersOut || 0);
}

export function priceMovementAlert(
  p: Player,
): "RISING_SOON" | "FALLING_SOON" | "STABLE" {
  const net = netTransfers(p);
  if (net >= 25000 || (p.transfersIn && p.transfersIn > 35000))
    return "RISING_SOON";
  if (net <= -20000 || (p.transfersOut && p.transfersOut > 25000))
    return "FALLING_SOON";
  return "STABLE";
}

export const players: Player[] = [
  {
    id: 1,
    name: "Raya",
    club: "ARS",
    position: "GK",
    price: 5.5,
    form: 5.8,
    ownership: 28.1,
    minutes: 96,
    fixture: "COV (H)",
    difficulty: 2,
    projection: 4.4,
    colour: "#e74c3c",
    transfersIn: 18400,
    transfersOut: 3200,
    active: true,
  },
  {
    id: 2,
    name: "Pickford",
    club: "EVE",
    position: "GK",
    price: 5.0,
    form: 4.2,
    ownership: 12.4,
    minutes: 100,
    fixture: "WOL (A)",
    difficulty: 3,
    projection: 3.8,
    colour: "#3b82f6",
    transfersIn: 5200,
    transfersOut: 14100,
    active: true,
  },
  {
    id: 3,
    name: "Saliba",
    club: "ARS",
    position: "DEF",
    price: 6.0,
    form: 4.4,
    ownership: 18.2,
    minutes: 95,
    fixture: "COV (H)",
    difficulty: 2,
    projection: 4.7,
    colour: "#e74c3c",
    transfersIn: 22100,
    transfersOut: 4800,
    active: true,
  },
  {
    id: 4,
    name: "Gvardiol",
    club: "MCI",
    position: "DEF",
    price: 5.5,
    form: 4.9,
    ownership: 19.7,
    minutes: 89,
    fixture: "BOU (H)",
    difficulty: 2,
    projection: 4.8,
    colour: "#60a5fa",
    transfersIn: 38500,
    transfersOut: 2100,
    active: true,
  },
  {
    id: 5,
    name: "Pinnock",
    club: "BRE",
    position: "DEF",
    price: 4.5,
    form: 3.6,
    ownership: 9.1,
    minutes: 98,
    fixture: "CRY (H)",
    difficulty: 2,
    projection: 3.5,
    colour: "#dc2626",
    transfersIn: 1200,
    transfersOut: 8900,
    active: true,
  },
  {
    id: 6,
    name: "Konsa",
    club: "AVL",
    position: "DEF",
    price: 4.5,
    form: 3.1,
    ownership: 5.4,
    minutes: 93,
    fixture: "CHE (A)",
    difficulty: 4,
    projection: 2.9,
    colour: "#8b5cf6",
    transfersIn: 450,
    transfersOut: 28400,
    active: true,
  },
  {
    id: 7,
    name: "White",
    club: "ARS",
    position: "DEF",
    price: 6.0,
    form: 4.2,
    ownership: 8.6,
    minutes: 87,
    fixture: "COV (H)",
    difficulty: 2,
    projection: 4.3,
    colour: "#e74c3c",
    transfersIn: 6100,
    transfersOut: 5200,
    active: true,
  },
  {
    id: 8,
    name: "Saka",
    club: "ARS",
    position: "MID",
    price: 9.0,
    form: 7.4,
    ownership: 46.2,
    minutes: 94,
    fixture: "COV (H)",
    difficulty: 2,
    projection: 7.9,
    colour: "#e74c3c",
    transfersIn: 41200,
    transfersOut: 3100,
    active: true,
  },
  {
    id: 9,
    name: "Palmer",
    club: "CHE",
    position: "MID",
    price: 9.5,
    form: 8.1,
    ownership: 62.8,
    minutes: 97,
    fixture: "AVL (H)",
    difficulty: 3,
    projection: 8.1,
    colour: "#60a5fa",
    transfersIn: 59400,
    transfersOut: 4200,
    active: true,
  },
  {
    id: 10,
    name: "Mbeumo",
    club: "BRE",
    position: "MID",
    price: 7.4,
    form: 6.7,
    ownership: 31.5,
    minutes: 95,
    fixture: "CRY (H)",
    difficulty: 2,
    projection: 6.6,
    colour: "#dc2626",
    transfersIn: 32800,
    transfersOut: 1900,
    active: true,
  },
  {
    id: 11,
    name: "Rogers",
    club: "AVL",
    position: "MID",
    price: 5.5,
    form: 5.9,
    ownership: 23.2,
    minutes: 90,
    fixture: "CHE (A)",
    difficulty: 4,
    projection: 5.1,
    colour: "#8b5cf6",
    transfersIn: 24100,
    transfersOut: 3800,
    active: true,
  },
  {
    id: 12,
    name: "Winks",
    club: "LEI",
    position: "MID",
    price: 4.0,
    form: 2.8,
    ownership: 4.1,
    minutes: 92,
    fixture: "NFO (H)",
    difficulty: 3,
    projection: 2.7,
    colour: "#f59e0b",
    transfersIn: 800,
    transfersOut: 4100,
    active: true,
  },
  {
    id: 13,
    name: "Haaland",
    club: "MCI",
    position: "FWD",
    price: 14.0,
    form: 8.6,
    ownership: 71.4,
    minutes: 91,
    fixture: "BOU (H)",
    difficulty: 2,
    projection: 8.8,
    colour: "#60a5fa",
    transfersIn: 68100,
    transfersOut: 5200,
    active: true,
  },
  {
    id: 14,
    name: "Watkins",
    club: "AVL",
    position: "FWD",
    price: 9.0,
    form: 6.1,
    ownership: 27.7,
    minutes: 88,
    fixture: "CHE (A)",
    difficulty: 4,
    projection: 5.9,
    colour: "#8b5cf6",
    transfersIn: 14200,
    transfersOut: 18900,
    active: true,
  },
  {
    id: 15,
    name: "Wood",
    club: "NFO",
    position: "FWD",
    price: 6.5,
    form: 5.0,
    ownership: 14.8,
    minutes: 86,
    fixture: "LEI (A)",
    difficulty: 3,
    projection: 4.7,
    colour: "#ef4444",
    transfersIn: 19800,
    transfersOut: 2400,
    active: true,
  },
  {
    id: 16,
    name: "Areola",
    club: "WHU",
    position: "GK",
    price: 4.5,
    form: 3.5,
    ownership: 10.8,
    minutes: 94,
    fixture: "TOT (H)",
    difficulty: 4,
    projection: 3.0,
    colour: "#7c3aed",
    transfersIn: 1100,
    transfersOut: 15400,
    active: true,
  },
  {
    id: 17,
    name: "Munoz",
    club: "CRY",
    position: "DEF",
    price: 4.5,
    form: 4.8,
    ownership: 8.8,
    minutes: 94,
    fixture: "BRE (A)",
    difficulty: 4,
    projection: 4.2,
    colour: "#22c55e",
    transfersIn: 16500,
    transfersOut: 2100,
    active: true,
  },
  {
    id: 18,
    name: "Eze",
    club: "ARS",
    position: "MID",
    price: 6.5,
    form: 6.2,
    ownership: 16.8,
    minutes: 92,
    fixture: "COV (H)",
    difficulty: 2,
    projection: 5.7,
    colour: "#e74c3c",
    transfersIn: 27900,
    transfersOut: 3100,
    active: true,
  },
  {
    id: 20,
    name: "Isak",
    club: "LIV",
    position: "FWD",
    price: 9.0,
    form: 6.5,
    ownership: 22.8,
    minutes: 84,
    fixture: "NEW (A)",
    difficulty: 3,
    projection: 6.4,
    colour: "#ef4444",
    transfersIn: 31500,
    transfersOut: 4100,
    active: true,
  },
  {
    id: 21,
    name: "Mitoma",
    club: "BHA",
    position: "MID",
    price: 6.5,
    form: 5.5,
    ownership: 12.0,
    minutes: 90,
    fixture: "EVE (H)",
    difficulty: 2,
    projection: 5.2,
    colour: "#3b82f6",
    transfersIn: 11200,
    transfersOut: 2100,
    active: true,
  },
  {
    id: 22,
    name: "Bruno Fernandes",
    club: "MUN",
    position: "MID",
    price: 8.5,
    form: 6.1,
    ownership: 16.4,
    minutes: 95,
    fixture: "CRY (A)",
    difficulty: 3,
    projection: 6.2,
    colour: "#ef4444",
    transfersIn: 25000,
    transfersOut: 3400,
    active: true,
  },
  {
    id: 23,
    name: "Bruno Guimarães",
    club: "NEW",
    position: "MID",
    price: 6.5,
    form: 5.3,
    ownership: 9.1,
    minutes: 93,
    fixture: "LIV (H)",
    difficulty: 4,
    projection: 4.9,
    colour: "#334155",
    transfersIn: 14000,
    transfersOut: 2200,
    active: true,
  },
  {
    id: 24,
    name: "Salah",
    club: "LIV",
    position: "MID",
    price: 12.5,
    form: 7.9,
    ownership: 42.1,
    minutes: 96,
    fixture: "NEW (A)",
    difficulty: 3,
    projection: 8.1,
    colour: "#ef4444",
    transfersIn: 55000,
    transfersOut: 2100,
    active: true,
  },
  {
    id: 25,
    name: "Son",
    club: "TOT",
    position: "MID",
    price: 10.0,
    form: 6.7,
    ownership: 19.8,
    minutes: 92,
    fixture: "WHU (A)",
    difficulty: 4,
    projection: 6.8,
    colour: "#3b82f6",
    transfersIn: 18000,
    transfersOut: 4300,
    active: true,
  },
  {
    id: 26,
    name: "Alexander-Arnold",
    club: "LIV",
    position: "DEF",
    price: 7.0,
    form: 5.7,
    ownership: 24.5,
    minutes: 91,
    fixture: "NEW (A)",
    difficulty: 3,
    projection: 5.4,
    colour: "#ef4444",
    transfersIn: 22000,
    transfersOut: 3100,
    active: true,
  },
  {
    id: 27,
    name: "Foden",
    club: "MCI",
    position: "MID",
    price: 9.5,
    form: 7.1,
    ownership: 23.0,
    minutes: 87,
    fixture: "BOU (H)",
    difficulty: 2,
    projection: 7.3,
    colour: "#60a5fa",
    transfersIn: 31000,
    transfersOut: 4500,
    active: true,
  },
  {
    id: 28,
    name: "De Bruyne",
    club: "MCI",
    position: "MID",
    price: 9.5,
    form: 6.5,
    ownership: 11.5,
    minutes: 80,
    fixture: "BOU (H)",
    difficulty: 2,
    projection: 6.7,
    colour: "#60a5fa",
    transfersIn: 12000,
    transfersOut: 5100,
    active: true,
  },
  {
    id: 29,
    name: "Solanke",
    club: "TOT",
    position: "FWD",
    price: 7.5,
    form: 5.9,
    ownership: 17.1,
    minutes: 90,
    fixture: "WHU (A)",
    difficulty: 4,
    projection: 5.7,
    colour: "#3b82f6",
    transfersIn: 19000,
    transfersOut: 3200,
    active: true,
  },
  {
    id: 30,
    name: "Gabriel",
    club: "ARS",
    position: "DEF",
    price: 6.0,
    form: 5.3,
    ownership: 29.2,
    minutes: 98,
    fixture: "COV (H)",
    difficulty: 2,
    projection: 5.0,
    colour: "#e74c3c",
    transfersIn: 34000,
    transfersOut: 1800,
    active: true,
  },
  {
    id: 31,
    name: "João Pedro",
    club: "BHA",
    position: "FWD",
    price: 5.5,
    form: 5.6,
    ownership: 25.4,
    minutes: 89,
    fixture: "EVE (H)",
    difficulty: 2,
    projection: 5.3,
    colour: "#3b82f6",
    transfersIn: 28000,
    transfersOut: 4100,
    active: true,
  },
  {
    id: 32,
    name: "Jackson",
    club: "CHE",
    position: "FWD",
    price: 7.5,
    form: 5.8,
    ownership: 15.6,
    minutes: 88,
    fixture: "AVL (H)",
    difficulty: 3,
    projection: 5.5,
    colour: "#60a5fa",
    transfersIn: 16000,
    transfersOut: 3900,
    active: true,
  },
  {
    id: 33,
    name: "Porro",
    club: "TOT",
    position: "DEF",
    price: 5.5,
    form: 4.8,
    ownership: 18.7,
    minutes: 94,
    fixture: "WHU (A)",
    difficulty: 4,
    projection: 4.3,
    colour: "#3b82f6",
    transfersIn: 15000,
    transfersOut: 2700,
    active: true,
  },
  {
    id: 34,
    name: "Maddison",
    club: "TOT",
    position: "MID",
    price: 7.5,
    form: 5.4,
    ownership: 9.5,
    minutes: 85,
    fixture: "WHU (A)",
    difficulty: 4,
    projection: 5.0,
    colour: "#3b82f6",
    transfersIn: 8500,
    transfersOut: 3100,
    active: true,
  },
  {
    id: 35,
    name: "Henderson",
    club: "CRY",
    position: "GK",
    price: 4.5,
    form: 4.2,
    ownership: 12.1,
    minutes: 100,
    fixture: "BRE (A)",
    difficulty: 4,
    projection: 3.5,
    colour: "#22c55e",
    transfersIn: 9100,
    transfersOut: 4200,
    active: true,
  },
  {
    id: 36,
    name: "Vicario",
    club: "TOT",
    position: "GK",
    price: 5.0,
    form: 4.4,
    ownership: 9.8,
    minutes: 100,
    fixture: "WHU (A)",
    difficulty: 4,
    projection: 3.8,
    colour: "#3b82f6",
    transfersIn: 7200,
    transfersOut: 2900,
    active: true,
  },
  {
    id: 37,
    name: "Alisson",
    club: "LIV",
    position: "GK",
    price: 5.5,
    form: 4.9,
    ownership: 10.5,
    minutes: 98,
    fixture: "NEW (A)",
    difficulty: 3,
    projection: 4.2,
    colour: "#ef4444",
    transfersIn: 6400,
    transfersOut: 1800,
    active: true,
  },
  {
    id: 38,
    name: "Jota",
    club: "LIV",
    position: "MID",
    price: 7.5,
    form: 6.2,
    ownership: 13.1,
    minutes: 0,
    status: "i",
    chanceOfPlaying: 0,
    news: "Rib injury - Expected return GW6",
    fixture: "NEW (A)",
    difficulty: 3,
    projection: 0.0,
    colour: "#ef4444",
    transfersIn: 21000,
    transfersOut: 4800,
    active: true,
  },
  {
    id: 39,
    name: "Garnacho",
    club: "MUN",
    position: "MID",
    price: 6.5,
    form: 5.4,
    ownership: 14.5,
    minutes: 86,
    fixture: "CRY (A)",
    difficulty: 3,
    projection: 5.1,
    colour: "#ef4444",
    transfersIn: 17500,
    transfersOut: 3900,
    active: true,
  },
  {
    id: 40,
    name: "Rashford",
    club: "MUN",
    position: "MID",
    price: 7.0,
    form: 4.8,
    ownership: 8.3,
    minutes: 82,
    fixture: "CRY (A)",
    difficulty: 3,
    projection: 4.6,
    colour: "#ef4444",
    transfersIn: 6100,
    transfersOut: 7200,
    active: true,
  },
  {
    id: 41,
    name: "Havertz",
    club: "ARS",
    position: "FWD",
    price: 8.0,
    form: 6.4,
    ownership: 18.2,
    minutes: 92,
    fixture: "COV (H)",
    difficulty: 2,
    projection: 6.2,
    colour: "#e74c3c",
    transfersIn: 29000,
    transfersOut: 3400,
    active: true,
  },
  {
    id: 42,
    name: "Zirkzee",
    club: "MUN",
    position: "FWD",
    price: 7.0,
    form: 4.4,
    ownership: 4.9,
    minutes: 74,
    status: "d",
    chanceOfPlaying: 75,
    news: "Knock - 75% chance of playing",
    fixture: "CRY (A)",
    difficulty: 3,
    projection: 4.1,
    colour: "#ef4444",
    transfersIn: 3200,
    transfersOut: 8100,
    active: true,
  },
  {
    id: 43,
    name: "Bowen",
    club: "WHU",
    position: "MID",
    price: 7.5,
    form: 6.0,
    ownership: 15.1,
    minutes: 96,
    fixture: "TOT (H)",
    difficulty: 4,
    projection: 5.5,
    colour: "#7c3aed",
    transfersIn: 18200,
    transfersOut: 2900,
    active: true,
  },
  {
    id: 44,
    name: "Mateta",
    club: "CRY",
    position: "FWD",
    price: 7.5,
    form: 5.7,
    ownership: 10.8,
    minutes: 89,
    fixture: "BRE (A)",
    difficulty: 4,
    projection: 5.1,
    colour: "#22c55e",
    transfersIn: 12400,
    transfersOut: 3600,
    active: true,
  },
  {
    id: 45,
    name: "Cunha",
    club: "WOL",
    position: "FWD",
    price: 6.5,
    form: 5.5,
    ownership: 11.5,
    minutes: 93,
    fixture: "EVE (H)",
    difficulty: 3,
    projection: 5.0,
    colour: "#f59e0b",
    transfersIn: 14100,
    transfersOut: 2800,
    active: true,
  },
  {
    id: 46,
    name: "Semenyo",
    club: "BOU",
    position: "MID",
    price: 5.5,
    form: 5.7,
    ownership: 14.1,
    minutes: 92,
    fixture: "MCI (A)",
    difficulty: 5,
    projection: 4.5,
    colour: "#ef4444",
    transfersIn: 19400,
    transfersOut: 2100,
    active: true,
  },
  {
    id: 47,
    name: "Smith Rowe",
    club: "FUL",
    position: "MID",
    price: 5.5,
    form: 5.5,
    ownership: 20.3,
    minutes: 88,
    fixture: "MUN (H)",
    difficulty: 4,
    projection: 4.9,
    colour: "#334155",
    transfersIn: 26000,
    transfersOut: 3100,
    active: true,
  },
  {
    id: 48,
    name: "Milenković",
    club: "NFO",
    position: "DEF",
    price: 4.5,
    form: 4.5,
    ownership: 9.2,
    minutes: 96,
    fixture: "LEI (A)",
    difficulty: 3,
    projection: 3.9,
    colour: "#ef4444",
    transfersIn: 11200,
    transfersOut: 1800,
    active: true,
  },
  {
    id: 49,
    name: "Sels",
    club: "NFO",
    position: "GK",
    price: 4.5,
    form: 4.6,
    ownership: 11.8,
    minutes: 100,
    fixture: "LEI (A)",
    difficulty: 3,
    projection: 4.0,
    colour: "#ef4444",
    transfersIn: 14200,
    transfersOut: 1900,
    active: true,
  },
  {
    id: 50,
    name: "Bednarek",
    club: "SOU",
    position: "DEF",
    price: 4.0,
    form: 3.2,
    ownership: 4.5,
    minutes: 95,
    fixture: "NEW (A)",
    difficulty: 4,
    projection: 2.8,
    colour: "#ef4444",
    transfersIn: 1200,
    transfersOut: 4100,
    active: true,
  },
  {
    id: 51,
    name: "Armstrong",
    club: "SOU",
    position: "FWD",
    price: 5.5,
    form: 4.2,
    ownership: 3.8,
    minutes: 82,
    fixture: "NEW (A)",
    difficulty: 4,
    projection: 3.6,
    colour: "#ef4444",
    transfersIn: 2100,
    transfersOut: 5400,
    active: true,
  },
  {
    id: 52,
    name: "Greaves",
    club: "IPS",
    position: "DEF",
    price: 4.0,
    form: 3.5,
    ownership: 5.1,
    minutes: 92,
    fixture: "CRY (A)",
    difficulty: 3,
    projection: 3.0,
    colour: "#3b82f6",
    transfersIn: 3400,
    transfersOut: 2200,
    active: true,
  },
];
export const squadIds = [1, 2, 3, 4, 5, 6, 17, 9, 10, 11, 12, 21, 13, 14, 15];
export const getSquad = (ids: number[] = squadIds) =>
  ids.map((id) => players.find((p) => p.id === id)!).filter(Boolean);

export function buildLegalDefaultSquad(
  pool: Player[],
  maxBudget = 100.0,
  excludedIds: number[] = [],
): Player[] {
  const req: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
  const squad: Player[] = [];
  const clubCounts: Record<string, number> = {};
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  const minCost: Record<Position, number> = {
    GK: 4.0,
    DEF: 4.0,
    MID: 4.5,
    FWD: 4.5,
  };

  const sortedPool = [...pool]
    .filter(
      (p) => p.active !== false && !excludedIds.includes(p.id),
    )
    .sort((a, b) => b.projection - a.projection);

  for (const pos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
    const candidates = sortedPool.filter((p) => p.position === pos);
    for (const p of candidates) {
      if (counts[pos] >= req[pos]) break;
      if (squad.some((s) => s.id === p.id)) continue;

      const currentClubCount = clubCounts[p.club] || 0;
      if (currentClubCount >= 3) continue;

      let remSlotsCost = 0;
      for (const rPos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
        const needed = req[rPos] - (counts[rPos] + (rPos === pos ? 1 : 0));
        remSlotsCost += needed * minCost[rPos];
      }

      const currentCost = squad.reduce((sum, x) => sum + x.price, 0) + p.price;
      if (currentCost + remSlotsCost > maxBudget) continue;

      squad.push(p);
      counts[pos]++;
      clubCounts[p.club] = currentClubCount + 1;
    }
  }

  if (squad.length < 15) {
    for (const pos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
      const candidates = sortedPool
        .filter((p) => p.position === pos)
        .sort((a, b) => a.price - b.price);
      for (const p of candidates) {
        if (counts[pos] >= req[pos]) break;
        if (squad.some((s) => s.id === p.id)) continue;
        if ((clubCounts[p.club] || 0) >= 3) continue;

        let remCost = 0;
        for (const rPos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
          const needed = req[rPos] - (counts[rPos] + (rPos === pos ? 1 : 0));
          remCost += Math.max(0, needed) * minCost[rPos];
        }
        if (
          squad.reduce((sum, x) => sum + x.price, 0) + p.price + remCost >
          maxBudget
        )
          continue;

        squad.push(p);
        counts[pos]++;
        clubCounts[p.club] = (clubCounts[p.club] || 0) + 1;
      }
    }
  }

  while (
    squad.length < 15 ||
    squad.reduce((sum, p) => sum + p.price, 0) > maxBudget
  ) {
    const replaceable = squad.sort((a, b) => b.price - a.price);
    if (!replaceable.length) break;
    const expensive = replaceable[0];
    const cheapCandidates = sortedPool
      .filter(
        (p) =>
          p.position === expensive.position &&
          p.id !== expensive.id &&
          !squad.some((s) => s.id === p.id) &&
          (clubCounts[p.club] || 0) <= 3,
      )
      .sort((a, b) => a.price - b.price);
    if (!cheapCandidates.length) break;
    const replacement = cheapCandidates[0];
    const idx = squad.findIndex((p) => p.id === expensive.id);
    if (idx !== -1) {
      squad[idx] = replacement;
      clubCounts[expensive.club] = Math.max(
        0,
        (clubCounts[expensive.club] || 1) - 1,
      );
      clubCounts[replacement.club] = (clubCounts[replacement.club] || 0) + 1;
    }
    for (const pos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
      if (counts[pos] < req[pos]) {
        const candidates = sortedPool
          .filter(
            (p) =>
              p.position === pos &&
              !squad.some((s) => s.id === p.id) &&
              (clubCounts[p.club] || 0) < 3,
          )
          .sort((a, b) => a.price - b.price);
        for (const p of candidates) {
          let remCost = 0;
          for (const rPos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
            const needed = req[rPos] - (counts[rPos] + (rPos === pos ? 1 : 0));
            remCost += Math.max(0, needed) * minCost[rPos];
          }
          if (
            squad.reduce((sum, x) => sum + x.price, 0) + p.price + remCost <=
            maxBudget
          ) {
            squad.push(p);
            counts[pos]++;
            clubCounts[p.club] = (clubCounts[p.club] || 0) + 1;
            if (squad.length === 15) break;
          }
        }
      }
    }
  }

  return squad;
}

export function buildLegalRemainingSquad(
  currentIds: number[],
  pool: Player[],
  horizon = 1,
  maxBudget = 100.0,
  excludedIds: number[] = [],
): Player[] {
  const req: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
  const squad: Player[] = currentIds
    .map((id) => pool.find((p) => p.id === id))
    .filter(Boolean) as Player[];

  const counts: Record<Position, number> = {
    GK: squad.filter((p) => p.position === "GK").length,
    DEF: squad.filter((p) => p.position === "DEF").length,
    MID: squad.filter((p) => p.position === "MID").length,
    FWD: squad.filter((p) => p.position === "FWD").length,
  };
  const clubCounts: Record<string, number> = {};
  squad.forEach((p) => {
    clubCounts[p.club] = (clubCounts[p.club] || 0) + 1;
  });

  const minCost: Record<Position, number> = {
    GK: 4.0,
    DEF: 4.0,
    MID: 4.5,
    FWD: 4.5,
  };
  const sortedPool = [...pool]
    .filter(
      (p) =>
        p.active !== false &&
        !squad.some((s) => s.id === p.id) &&
        !excludedIds.includes(p.id),
    )
    .sort(
      (a, b) => horizonProjection(b, horizon) - horizonProjection(a, horizon),
    );

  for (const pos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
    const candidates = sortedPool.filter((p) => p.position === pos);
    for (const p of candidates) {
      if (counts[pos] >= req[pos]) break;
      if (squad.some((s) => s.id === p.id)) continue;

      const currentClubCount = clubCounts[p.club] || 0;
      if (currentClubCount >= 3) continue;

      let remSlotsCost = 0;
      for (const rPos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
        const needed = req[rPos] - (counts[rPos] + (rPos === pos ? 1 : 0));
        remSlotsCost += Math.max(0, needed) * minCost[rPos];
      }

      const currentCost = squad.reduce((sum, x) => sum + x.price, 0) + p.price;
      if (currentCost + remSlotsCost > maxBudget) continue;

      squad.push(p);
      counts[pos]++;
      clubCounts[p.club] = currentClubCount + 1;
    }
  }

  if (squad.length < 15) {
    for (const pos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
      const candidates = sortedPool
        .filter((p) => p.position === pos)
        .sort((a, b) => a.price - b.price);
      for (const p of candidates) {
        if (counts[pos] >= req[pos]) break;
        if (squad.some((s) => s.id === p.id)) continue;
        if ((clubCounts[p.club] || 0) >= 3) continue;

        let remCost = 0;
        for (const rPos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
          const needed = req[rPos] - (counts[rPos] + (rPos === pos ? 1 : 0));
          remCost += Math.max(0, needed) * minCost[rPos];
        }
        if (
          squad.reduce((sum, x) => sum + x.price, 0) + p.price + remCost >
          maxBudget
        )
          continue;

        squad.push(p);
        counts[pos]++;
        clubCounts[p.club] = (clubCounts[p.club] || 0) + 1;
      }
    }
  }

  while (
    squad.length < 15 ||
    squad.reduce((sum, p) => sum + p.price, 0) > maxBudget
  ) {
    const replaceable = squad
      .filter((p) => !currentIds.includes(p.id))
      .sort((a, b) => b.price - a.price);
    if (!replaceable.length) break;
    const expensive = replaceable[0];
    const cheapCandidates = sortedPool
      .filter(
        (p) =>
          p.position === expensive.position &&
          p.id !== expensive.id &&
          !squad.some((s) => s.id === p.id) &&
          (clubCounts[p.club] || 0) <= 3,
      )
      .sort((a, b) => a.price - b.price);
    if (!cheapCandidates.length) break;
    const replacement = cheapCandidates[0];
    const idx = squad.findIndex((p) => p.id === expensive.id);
    if (idx !== -1) {
      squad[idx] = replacement;
      clubCounts[expensive.club] = Math.max(
        0,
        (clubCounts[expensive.club] || 1) - 1,
      );
      clubCounts[replacement.club] = (clubCounts[replacement.club] || 0) + 1;
    }
    for (const pos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
      if (counts[pos] < req[pos]) {
        const candidates = sortedPool
          .filter(
            (p) =>
              p.position === pos &&
              !squad.some((s) => s.id === p.id) &&
              (clubCounts[p.club] || 0) < 3,
          )
          .sort((a, b) => a.price - b.price);
        for (const p of candidates) {
          let remCost = 0;
          for (const rPos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
            const needed = req[rPos] - (counts[rPos] + (rPos === pos ? 1 : 0));
            remCost += Math.max(0, needed) * minCost[rPos];
          }
          if (
            squad.reduce((sum, x) => sum + x.price, 0) + p.price + remCost <=
            maxBudget
          ) {
            squad.push(p);
            counts[pos]++;
            clubCounts[p.club] = (clubCounts[p.club] || 0) + 1;
            if (squad.length === 15) break;
          }
        }
      }
    }
  }

  return squad;
}

export function horizonMultiplier(h: number) {
  return h === 1 ? 1 : h === 3 ? 2.82 : 4.5;
}
export function horizonProjection(p: Player, h: number) {
  if (p.storedForecasts?.[h]) return p.storedForecasts[h]!.meanPoints;
  if (p.storedForecast?.horizon === h) return p.storedForecast.meanPoints;
  return modelHorizonProjection(
    { ...p, upcomingFixtures: getPlayerUpcomingFixtures(p, h) },
    h,
  );
}

export type LeagueProjectionPick = {
  element: number;
  position: number;
  is_captain?: boolean;
  multiplier?: number;
  remainingFixtureFraction?: number | null;
};

export type LeagueLivePrediction = {
  predictedPoints: number;
  playersRemaining: number;
};

/** Adds only the unplayed share of the current-GW projection to live points. */
export function leagueLivePredictedPoints(
  catalog: Player[],
  picks: LeagueProjectionPick[],
  currentPoints: number,
): LeagueLivePrediction | null {
  const scoringPicks = picks.filter((pick) => (pick.multiplier ?? 0) > 0);
  if (
    scoringPicks.length === 0 ||
    scoringPicks.some((pick) => pick.remainingFixtureFraction == null)
  ) return null;

  const playersById = new Map(catalog.map((player) => [player.id, player]));
  let remainingExpectedPoints = 0;
  let playersRemaining = 0;
  for (const pick of scoringPicks) {
    const remainingFraction = Math.max(0, Math.min(1, pick.remainingFixtureFraction!));
    if (remainingFraction <= 0) continue;
    const player = playersById.get(pick.element);
    if (!player) return null;
    playersRemaining += 1;
    remainingExpectedPoints += horizonProjection(player, 1) * (pick.multiplier ?? 1) * remainingFraction;
  }

  return {
    predictedPoints: +(currentPoints + remainingExpectedPoints).toFixed(1),
    playersRemaining,
  };
}

/**
 * Projects a revealed league lineup across a planning horizon. The current
 * starting XI and captain are held constant; one-week scoring chips only add
 * their extra points in the first gameweek of a longer horizon.
 */
export function leagueLineupExpectedPoints(
  catalog: Player[],
  picks: LeagueProjectionPick[],
  horizon: 1 | 3 | 5,
  activeChip?: string | null,
): number | null {
  if (picks.length === 0) return null;

  const playersById = new Map(catalog.map((player) => [player.id, player]));
  const resolved = picks.map((pick) => ({ pick, player: playersById.get(pick.element) }));
  if (resolved.some(({ player }) => !player)) return null;

  const starters = resolved.filter(({ pick }) => pick.position <= 11);
  const captain = starters.find(({ pick }) => pick.is_captain);
  let total = starters.reduce(
    (sum, { player }) => sum + horizonProjection(player!, horizon),
    0,
  );

  // Assume the revealed captain remains captain throughout the horizon.
  if (captain?.player) total += horizonProjection(captain.player, horizon);

  const chip = activeChip?.toLowerCase();
  if (chip === "3xc" && captain?.player) {
    total += horizonProjection(captain.player, 1);
  }
  if (chip === "bboost") {
    total += resolved
      .filter(({ pick }) => pick.position > 11)
      .reduce((sum, { player }) => sum + horizonProjection(player!, 1), 0);
  }

  return +total.toFixed(1);
}
export function validateSquad(squad: Player[]): SquadIssue[] {
  const issues: SquadIssue[] = [];
  const counts = {
    GK: squad.filter((p) => p.position === "GK").length,
    DEF: squad.filter((p) => p.position === "DEF").length,
    MID: squad.filter((p) => p.position === "MID").length,
    FWD: squad.filter((p) => p.position === "FWD").length,
  };
  if (squad.length !== 15)
    issues.push({
      rule: "Squad size",
      detail: `Squad has ${squad.length} players; it must have 15.`,
    });
  if (
    counts.GK !== 2 ||
    counts.DEF !== 5 ||
    counts.MID !== 5 ||
    counts.FWD !== 3
  )
    issues.push({
      rule: "Position balance",
      detail: `Required 2 GK, 5 DEF, 5 MID and 3 FWD; currently ${counts.GK}/${counts.DEF}/${counts.MID}/${counts.FWD}.`,
    });
  Object.entries(
    squad.reduce<Record<string, number>>(
      (a, p) => ((a[p.club] = (a[p.club] || 0) + 1), a),
      {},
    ),
  )
    .filter(([, n]) => n > 3)
    .forEach(([club, n]) =>
      issues.push({
        rule: "Club limit",
        detail: `${club} has ${n} players; maximum is 3.`,
      }),
    );
  return issues;
}

export function validateInitialSquad(
  squad: Player[],
  budget = INITIAL_SQUAD_BUDGET,
): SquadIssue[] {
  const issues = validateSquad(squad);
  const cost = squad.reduce((sum, player) => sum + player.price, 0);
  if (cost > budget + 0.0001)
    issues.push({
      rule: "Budget",
      detail: `Initial squad costs £${cost.toFixed(1)}m; the GW1 limit is £${budget.toFixed(1)}m.`,
    });
  return issues;
}

export function initialSquadBank(
  squad: Player[],
  budget = INITIAL_SQUAD_BUDGET,
) {
  return +Math.max(
    0,
    budget - squad.reduce((sum, player) => sum + player.price, 0),
  ).toFixed(1);
}
export function isLegalTransfer(
  squad: Player[],
  out: Player,
  inc: Player,
  bank = 0,
) {
  const sellingPrice = out.sellingPrice === undefined ? out.price : out.sellingPrice;
  if (
    !squad.some((p) => p.id === out.id) ||
    inc.active === false ||
    out.position !== inc.position ||
    squad.some((p) => p.id === inc.id) ||
    sellingPrice === null
  )
    return false;
  const next = squad.map((p) => (p.id === out.id ? inc : p));
  return (
    inc.price - sellingPrice <= bank &&
    validateSquad(next).length === 0
  );
}

function isLegalRouteSquad(squad: Player[]) {
  if (
    squad.length !== 15 ||
    new Set(squad.map((player) => player.id)).size !== 15
  )
    return false;
  const required: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
  if (
    (Object.keys(required) as Position[]).some(
      (position) =>
        squad.filter((player) => player.position === position).length !==
        required[position],
    )
  )
    return false;
  const clubCounts = squad.reduce<Record<string, number>>(
    (counts, player) => (
      (counts[player.club] = (counts[player.club] || 0) + 1),
      counts
    ),
    {},
  );
  return Object.values(clubCounts).every((count) => count <= 3);
}

export function findTransferRoutesToTarget(
  target: Player,
  squad: Player[],
  pool: Player[],
  horizon = 5,
  bank = 0,
  freeTransfers = 1,
  limit = 5,
): TargetTransferPlan {
  if (squad.some((player) => player.id === target.id))
    return { target, alreadyOwned: true, directShortfall: 0, routes: [] };
  if (target.active === false)
    return { target, alreadyOwned: false, directShortfall: null, routes: [] };

  const targetOuts = squad.filter(
    (player) => player.position === target.position,
  );
  const directShortfalls = targetOuts.map((out) =>
    out.sellingPrice === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, +(target.price - (out.sellingPrice ?? out.price) - bank).toFixed(1)),
  ).filter(Number.isFinite);
  const routes: TargetTransferRoute[] = [];
  const seen = new Set<string>();

  const addRoute = (moves: Array<{ out: Player; in: Player }>) => {
    const outgoingIds = new Set(moves.map((move) => move.out.id));
    const incoming = moves.map((move) => move.in);
    const finalSquad = [
      ...squad.filter((player) => !outgoingIds.has(player.id)),
      ...incoming,
    ];
    if (moves.some((move) => move.out.sellingPrice === null)) return;
    const totalPriceDelta = +moves
      .reduce((sum, move) => sum + move.in.price - (move.out.sellingPrice ?? move.out.price), 0)
      .toFixed(1);
    if (totalPriceDelta > bank + 0.0001 || !isLegalRouteSquad(finalSquad))
      return;
    const key = moves
      .map((move) => `${move.out.id}:${move.in.id}`)
      .sort()
      .join("|");
    if (seen.has(key)) return;
    seen.add(key);
    const detailed = moves.map((move) => ({
      out: move.out,
      in: move.in,
      outProjection: +horizonProjection(move.out, horizon).toFixed(1),
      inProjection: +horizonProjection(move.in, horizon).toFixed(1),
      priceDelta: +(move.in.price - (move.out.sellingPrice ?? move.out.price)).toFixed(1),
    }));
    const rawGain = +detailed
      .reduce((sum, move) => sum + move.inProjection - move.outProjection, 0)
      .toFixed(1);
    const hitCost = Math.max(0, moves.length - freeTransfers) * 4;
    routes.push({
      moves: detailed,
      rawGain,
      hitCost,
      netGain: +(rawGain - hitCost).toFixed(1),
      bankAfter: +(bank - totalPriceDelta).toFixed(1),
    });
  };

  for (const targetOut of targetOuts)
    addRoute([{ out: targetOut, in: target }]);

  const availableFundingPlayers = pool.filter(
    (player) =>
      player.active !== false &&
      player.id !== target.id &&
      !squad.some((owned) => owned.id === player.id),
  );
  for (const targetOut of targetOuts) {
    for (const fundingOut of squad) {
      if (fundingOut.id === targetOut.id) continue;
      for (const fundingIn of availableFundingPlayers) {
        if (fundingIn.position !== fundingOut.position) continue;
        addRoute([
          { out: targetOut, in: target },
          { out: fundingOut, in: fundingIn },
        ]);
      }
    }
  }

  routes.sort(
    (a, b) =>
      b.netGain - a.netGain ||
      a.hitCost - b.hitCost ||
      b.bankAfter - a.bankAfter ||
      a.moves.length - b.moves.length,
  );
  const routeLimit = Math.max(1, limit);
  const selected = routes.slice(0, routeLimit);
  const bestDirect = routes.find((route) => route.moves.length === 1);
  if (bestDirect && !selected.includes(bestDirect))
    selected.splice(Math.max(0, selected.length - 1), 1, bestDirect);
  selected.sort(
    (a, b) =>
      b.netGain - a.netGain ||
      a.hitCost - b.hitCost ||
      b.bankAfter - a.bankAfter,
  );
  return {
    target,
    alreadyOwned: false,
    directShortfall: directShortfalls.length
      ? Math.min(...directShortfalls)
      : null,
    routes: selected,
  };
}

export function findTransferRoutesFromOut(
  outPlayer: Player,
  squad: Player[],
  pool: Player[],
  horizon = 5,
  bank = 0,
  freeTransfers = 1,
  limit = 5,
): TargetTransferPlan {
  if (!squad.some((player) => player.id === outPlayer.id))
    return { target: outPlayer, alreadyOwned: false, directShortfall: null, routes: [] };
  if (outPlayer.sellingPrice === null)
    return { target: outPlayer, alreadyOwned: true, directShortfall: null, routes: [] };

  const routes: TargetTransferRoute[] = [];
  const seen = new Set<string>();

  const addRoute = (moves: Array<{ out: Player; in: Player }>) => {
    const outgoingIds = new Set(moves.map((move) => move.out.id));
    const incoming = moves.map((move) => move.in);
    const finalSquad = [
      ...squad.filter((player) => !outgoingIds.has(player.id)),
      ...incoming,
    ];
    if (moves.some((move) => move.out.sellingPrice === null)) return;
    const totalPriceDelta = +moves
      .reduce((sum, move) => sum + move.in.price - (move.out.sellingPrice ?? move.out.price), 0)
      .toFixed(1);
    if (totalPriceDelta > bank + 0.0001 || !isLegalRouteSquad(finalSquad))
      return;
    const key = moves
      .map((move) => `${move.out.id}:${move.in.id}`)
      .sort()
      .join("|");
    if (seen.has(key)) return;
    seen.add(key);
    const detailed = moves.map((move) => ({
      out: move.out,
      in: move.in,
      outProjection: +horizonProjection(move.out, horizon).toFixed(1),
      inProjection: +horizonProjection(move.in, horizon).toFixed(1),
      priceDelta: +(move.in.price - (move.out.sellingPrice ?? move.out.price)).toFixed(1),
    }));
    const rawGain = +detailed
      .reduce((sum, move) => sum + move.inProjection - move.outProjection, 0)
      .toFixed(1);
    const hitCost = Math.max(0, moves.length - freeTransfers) * 4;
    routes.push({
      moves: detailed,
      rawGain,
      hitCost,
      netGain: +(rawGain - hitCost).toFixed(1),
      bankAfter: +(bank - totalPriceDelta).toFixed(1),
    });
  };

  const availableReplacements = pool.filter(
    (player) =>
      player.active !== false &&
      player.id !== outPlayer.id &&
      player.position === outPlayer.position &&
      !squad.some((owned) => owned.id === player.id),
  );

  for (const inc of availableReplacements) {
    addRoute([{ out: outPlayer, in: inc }]);
  }

  // Also explore 2-transfer combinations with available funding players if direct options are limited or funded upgrades exist
  const availableFundingPlayers = pool.filter(
    (player) =>
      player.active !== false &&
      player.id !== outPlayer.id &&
      !squad.some((owned) => owned.id === player.id),
  );

  for (const inc of availableReplacements) {
    for (const fundingOut of squad) {
      if (fundingOut.id === outPlayer.id) continue;
      for (const fundingIn of availableFundingPlayers) {
        if (fundingIn.id === inc.id || fundingIn.position !== fundingOut.position) continue;
        addRoute([
          { out: outPlayer, in: inc },
          { out: fundingOut, in: fundingIn },
        ]);
      }
    }
  }

  routes.sort(
    (a, b) =>
      b.netGain - a.netGain ||
      a.hitCost - b.hitCost ||
      b.bankAfter - a.bankAfter ||
      a.moves.length - b.moves.length,
  );
  const routeLimit = Math.max(1, limit);
  const selected = routes.slice(0, routeLimit);
  const bestDirect = routes.find((route) => route.moves.length === 1);
  if (bestDirect && !selected.includes(bestDirect))
    selected.splice(Math.max(0, selected.length - 1), 1, bestDirect);
  selected.sort(
    (a, b) =>
      b.netGain - a.netGain ||
      a.hitCost - b.hitCost ||
      b.bankAfter - a.bankAfter,
  );

  return {
    target: outPlayer,
    alreadyOwned: true,
    directShortfall: 0,
    routes: selected,
  };
}


export function transfers(
  h: number,
  bank = 1.2,
  freeTransfers = 1,
  squad = getSquad(),
  pool: Player[] = players,
): Transfer[] {
  const options: Transfer[] = [];
  squad.forEach((out) =>
    pool
      .filter(
        (inc) => inc.active !== false && isLegalTransfer(squad, out, inc, bank),
      )
      .forEach((inc) => {
        const outProjection = horizonProjection(out, h);
        const inProjection = horizonProjection(inc, h);
        const gain = +(inProjection - outProjection).toFixed(1);
        const hitCost = freeTransfers > 0 ? 0 : 4;
        const alert = priceMovementAlert(inc);
        const outAlert = priceMovementAlert(out);
        const sellOff =
          outAlert === "FALLING_SOON"
            ? `${out.name} is under heavy sell-off pressure (-${Math.abs(netTransfers(out)).toLocaleString()} net transfers)`
            : undefined;
        if (gain > 0)
          options.push({
            out,
            in: inc,
            gain,
            net: +(gain - hitCost).toFixed(1),
            priceDelta: +(inc.price - (out.sellingPrice ?? out.price)).toFixed(1),
            priceAlert: alert,
            sellOffWarning: sellOff,
            outProjection,
            inProjection,
            hitCost,
          });
      }),
  );
  const confidence = (player: Player) =>
    player.dataConfidence === "HIGH"
      ? 3
      : player.dataConfidence === "MEDIUM"
        ? 2
        : 1;
  const preferred = [...options].sort(
    (a, b) =>
      b.net - a.net ||
      confidence(b.in) - confidence(a.in) ||
      (b.in.stats?.minutes || 0) - (a.in.stats?.minutes || 0) ||
      b.in.ownership - a.in.ownership,
  );
  const collapsed = new Map<string, Transfer>();
  for (const option of preferred) {
    const key = [
      option.out.id,
      option.in.club,
      option.in.position,
      option.in.price,
      option.inProjection.toFixed(1),
    ].join("|");
    const existing = collapsed.get(key);
    if (existing) {
      existing.equivalentAlternatives =
        (existing.equivalentAlternatives || 0) + 1;
      continue;
    }
    collapsed.set(key, { ...option, equivalentAlternatives: 0 });
  }
  const meaningfulGain =
    freeTransfers > 0
      ? TRANSFER_GAIN_THRESHOLDS[(h >= 5 ? 5 : h >= 3 ? 3 : 1) as 1 | 3 | 5]
      : 1;
  const meaningful = [...collapsed.values()].filter(
    (option) =>
      option.net >= meaningfulGain &&
      !(
        option.in.dataConfidence === "LOW" &&
        option.out.dataConfidence === "HIGH" &&
        option.gain < 3
      ),
  );
  const nonDominated = meaningful.filter(
    (option) =>
      !meaningful.some(
        (other) =>
          other.out.id === option.out.id &&
          other.in.id !== option.in.id &&
          other.in.price <= option.in.price &&
          other.inProjection >= option.inProjection &&
          (other.in.price < option.in.price ||
            other.inProjection > option.inProjection),
      ),
  );
  const perOutgoing = new Map<number, number>();
  const final = nonDominated
    .sort((a, b) => b.net - a.net)
    .filter((option) => {
      const count = perOutgoing.get(option.out.id) || 0;
      if (count >= 3) return false;
      perOutgoing.set(option.out.id, count + 1);
      return true;
    })
    .slice(0, 30);

  // Compute selection-aware gain: marginal draftSquadScore impact of each swap,
  // discounting bench-bound players correctly (e.g. a bench GK behind a nailed
  // starter contributes almost nothing to draftSquadScore).
  if (final.length > 0 && squad.length === 15) {
    const baselineScore = draftSquadScore(h, squad).total;
    for (const option of final) {
      const afterSquad = squad.map((p) =>
        p.id === option.out.id ? option.in : p,
      );
      const afterScore = draftSquadScore(h, afterSquad).total;
      option.selectionAwareGain = +(afterScore - baselineScore - option.hitCost).toFixed(1);
    }
    // The draft score includes role uncertainty, autosub cover and corrected
    // captain/vice fallback. Make that decision-aware value authoritative for
    // ordering instead of calculating it only for display after ranking.
    final.sort(
      (a, b) =>
        (b.selectionAwareGain ?? b.net) - (a.selectionAwareGain ?? a.net) ||
        b.net - a.net,
    );
  }

  return final;
}
export function transferDecision(
  h: number,
  bank = 1.2,
  freeTransfers = 1,
  squad = getSquad(),
  pool: Player[] = players,
): TransferDecision {
  const ranked = transfers(h, bank, freeTransfers, squad, pool);
  return transferDecisionFromRanked(h, freeTransfers, ranked);
}

export function transferDecisionFromRanked(
  h: number,
  freeTransfers: number,
  ranked: Transfer[],
): TransferDecision {
  const best = ranked[0] ?? null;
  if (!best || (best.selectionAwareGain ?? best.net) < 1)
    return {
      transfer: null,
      roll: true,
      reason:
        "No available move clears the actionable-gain threshold after costs and uncertainty.",
      hitCost: freeTransfers > 0 ? 0 : 4,
      freeTransfers,
    };
  return {
    transfer: best,
    roll: false,
    reason: `${best.out.name} → ${best.in.name} adds ${best.net} net projected points over ${h} GWs.`,
    hitCost: freeTransfers > 0 ? 0 : 4,
    freeTransfers,
  };
}
function bestXIWithScore(s: Player[], score: (player: Player) => number) {
  const ranked = (position: Position) =>
    s
      .filter((p) => p.position === position)
      .sort((a, b) => score(b) - score(a));
  const gk = ranked("GK")[0];
  if (!gk) return [];
  let best: Player[] = [];
  let bestScore = -Infinity;
  for (let defCount = 3; defCount <= 5; defCount++)
    for (let midCount = 2; midCount <= 5; midCount++)
      for (let fwdCount = 1; fwdCount <= 3; fwdCount++) {
        if (defCount + midCount + fwdCount !== 10) continue;
        const def = ranked("DEF").slice(0, defCount),
          mid = ranked("MID").slice(0, midCount),
          fwd = ranked("FWD").slice(0, fwdCount);
        if (
          def.length !== defCount ||
          mid.length !== midCount ||
          fwd.length !== fwdCount
        )
          continue;
        const lineup = [...def, ...mid, ...fwd, gk];
        const total = lineup.reduce((sum, p) => sum + score(p), 0);
        if (total > bestScore) {
          bestScore = total;
          best = lineup;
        }
      }
  return best.sort((a, b) => score(b) - score(a));
}

export function bestXI(h: number, s = getSquad()) {
  return bestXIWithScore(s, (player) => horizonProjection(player, h));
}

export function gameweekProjection(player: Player, gameweek: number) {
  const fixture = (player.upcomingFixtures || CLUB_FIXTURES[player.club] || []).find(
    (item) => item.gameweek === gameweek,
  );
  if (!fixture) return 0;
  return modelHorizonProjection({ ...player, upcomingFixtures: [fixture] }, 1);
}

export function bestXIForGameweek(gameweek: number, squad = getSquad()) {
  return bestXIWithScore(squad, (player) => gameweekProjection(player, gameweek));
}

export type Chip = "NONE" | "TRIPLE_CAPTAIN" | "BENCH_BOOST";

export function benchOrder(
  h: number,
  squad: Player[],
  lineup = bestXI(h, squad),
) {
  const starters = new Set(lineup.map((player) => player.id));
  const bench = squad.filter((player) => !starters.has(player.id));
  const goalkeeper = bench.find((player) => player.position === "GK");
  const outfield = bench
    .filter((player) => player.position !== "GK")
    .sort((a, b) => horizonProjection(b, h) - horizonProjection(a, h));
  return goalkeeper ? [goalkeeper, ...outfield] : outfield;
}

export function resolveAutomaticSubstitutions(
  starters: Player[],
  bench: Player[],
  appearedIds: Set<number>,
) {
  let lineup = starters.filter((player) => appearedIds.has(player.id));
  const unused = [...bench];
  if (!lineup.some((player) => player.position === "GK")) {
    const index = unused.findIndex(
      (player) => player.position === "GK" && appearedIds.has(player.id),
    );
    if (index >= 0) lineup.push(...unused.splice(index, 1));
  }
  const legal = (players: Player[]) =>
    players.filter((p) => p.position === "DEF").length >= 3 &&
    players.filter((p) => p.position === "MID").length >= 2 &&
    players.filter((p) => p.position === "FWD").length >= 1;
  for (const candidate of unused) {
    if (
      candidate.position === "GK" ||
      !appearedIds.has(candidate.id) ||
      lineup.length >= 11
    )
      continue;
    if (legal([...lineup, candidate])) lineup.push(candidate);
  }
  return lineup;
}

export function projectedTeamScore(
  h: number,
  squad: Player[],
  captainId?: number,
  viceCaptainId?: number,
  chip: Chip = "NONE",
) {
  const lineup = bestXI(h, squad),
    bench = benchOrder(h, squad, lineup);
  const captain =
    lineup.find((player) => player.id === captainId) ||
    [...lineup].sort(
      (a, b) => horizonProjection(b, h) - horizonProjection(a, h),
    )[0];
  const vice = lineup.find(
    (player) => player.id === viceCaptainId && player.id !== captain?.id,
  );
  const starters = lineup.reduce(
    (sum, player) => sum + horizonProjection(player, h),
    0,
  );
  const captainExtra = captain
    ? horizonProjection(captain, h) * (chip === "TRIPLE_CAPTAIN" ? 2 : 1)
    : 0;
  const benchPoints =
    chip === "BENCH_BOOST"
      ? bench.reduce((sum, player) => sum + horizonProjection(player, h), 0)
      : 0;
  return {
    total: +(starters + captainExtra + benchPoints).toFixed(1),
    starters: +starters.toFixed(1),
    captain,
    vice,
    bench,
    chip,
  };
}

export function draftSquadScore(h: number, squad: Player[]): DraftScore {
  return scoreDraftSquadAcrossGameweeks(
    h,
    squad,
    (player, gameweek) => gameweekProjection(player, gameweek),
  );
}

function planningGameweeks(h: number, squad: Player[]) {
  const available = [
    ...new Set(
      squad.flatMap((player) =>
        (player.upcomingFixtures || CLUB_FIXTURES[player.club] || []).map(
          (fixture) => fixture.gameweek,
        ),
      ),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, h);
  return available.length ? available : Array.from({ length: h }, (_, index) => index + 1);
}

function noShowProbability(player: Player) {
  const role = playerRoleProfile(player);
  return (1 - role.startProbability) *
    (1 - role.substituteProbabilityWhenBenched);
}

function probabilityAtLeast(probabilities: number[], threshold: number) {
  let distribution = [1];
  for (const probability of probabilities) {
    const next = Array(distribution.length + 1).fill(0);
    distribution.forEach((value, count) => {
      next[count] += value * (1 - probability);
      next[count + 1] += value * probability;
    });
    distribution = next;
  }
  return distribution.slice(threshold).reduce((sum, value) => sum + value, 0);
}

function scoreDraftSquadAcrossGameweeks(
  h: number,
  squad: Player[],
  scoreFor: (player: Player, gameweek: number) => number,
): DraftScore {
  const totals: DraftScore = {total:0,starters:0,captain:0,vice:0,bench:0,uncertaintyPenalty:0};
  for (const gameweek of planningGameweeks(h, squad)) {
    const score = (player: Player) => scoreFor(player, gameweek);
    const lineup = bestXIWithScore(squad, score);
    if (lineup.length !== 11) return {...totals,total:-Infinity};
    const starterIds = new Set(lineup.map((player) => player.id));
    const ranked = [...lineup].sort((a, b) => score(b) - score(a));
    const captainPlayer = ranked[0];
    const viceCandidate = ranked.slice(1).sort(
      (a, b) => score(b) * (1 - noShowProbability(b)) - score(a) * (1 - noShowProbability(a)),
    )[0];
    const reserves = squad.filter((player) => !starterIds.has(player.id));
    const startingGoalkeeper = lineup.find((player) => player.position === "GK");
    const reserveGoalkeeper = reserves.find((player) => player.position === "GK");
    const outfieldBench = reserves
      .filter((player) => player.position !== "GK")
      .sort((a, b) => score(b) - score(a));
    const outfieldNoShows = lineup
      .filter((player) => player.position !== "GK")
      .map(noShowProbability);
    const goalkeeperCover = startingGoalkeeper && reserveGoalkeeper
      ? noShowProbability(startingGoalkeeper) * score(reserveGoalkeeper)
      : 0;
    const outfieldCover = outfieldBench.reduce(
      (sum, player, index) =>
        sum + score(player) * probabilityAtLeast(outfieldNoShows, index + 1),
      0,
    );
    const confidenceRisk = lineup.reduce((sum, player) => {
      const confidence = playerRoleProfile(player).confidence;
      return sum + (confidence === "LOW" ? .15 : confidence === "MEDIUM" ? .05 : 0);
    }, 0);
    totals.starters += lineup.reduce((sum, player) => sum + score(player), 0);
    totals.captain += captainPlayer ? score(captainPlayer) : 0;
    totals.vice += captainPlayer && viceCandidate
      ? noShowProbability(captainPlayer) * score(viceCandidate)
      : 0;
    totals.bench += goalkeeperCover + outfieldCover;
    totals.uncertaintyPenalty += confidenceRisk;
  }
  totals.total = totals.starters + totals.captain + totals.vice + totals.bench - totals.uncertaintyPenalty;
  for (const key of Object.keys(totals) as Array<keyof DraftScore>) totals[key] = +totals[key].toFixed(2);
  return totals;
}

function optimizerCandidates(
  pool: Player[],
  lockedIds: Set<number>,
  horizon: number,
  excludedIds: Set<number> = new Set(),
) {
  const active = pool.filter(
    (player) => player.active !== false && !excludedIds.has(player.id),
  );
  const score = (player: Player) => horizonProjection(player, horizon);
  const selected = new Map<number, Player>();
  for (const position of ["GK", "DEF", "MID", "FWD"] as Position[]) {
    const positional = active.filter((player) => player.position === position);
    const picks = [
      ...[...positional].sort((a, b) => score(b) - score(a)).slice(0, 22),
      ...[...positional]
        .sort((a, b) => score(b) / b.price - score(a) / a.price)
        .slice(0, 14),
      ...[...positional]
        .sort((a, b) => a.price - b.price || score(b) - score(a))
        .slice(0, 10),
    ];
    picks.forEach((player) => selected.set(player.id, player));
  }
  active
    .filter((player) => lockedIds.has(player.id))
    .forEach((player) => selected.set(player.id, player));
  return [...selected.values()];
}

export function optimizeInitialSquad(
  pool: Player[],
  options: InitialSquadOptions = {},
): Player[] {
  const horizon = options.horizon ?? 5;
  const budget = options.budget ?? INITIAL_SQUAD_BUDGET;
  const excludedIds = new Set(options.excludedPlayerIds || []);
  const uniqueLocked = [...new Set(options.lockedPlayerIds || [])]
    .map((id) => pool.find((player) => player.id === id))
    .filter(Boolean) as Player[];
  if (
    uniqueLocked.some((player) => player.active === false) ||
    uniqueLocked.length > 15
  )
    return [];
  const lockedIds = new Set(uniqueLocked.map((player) => player.id));
  if (
    validateInitialSquad(uniqueLocked, budget).some(
      (issue) => issue.rule === "Club limit" || issue.rule === "Budget",
    )
  )
    return [];
  const required: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
  if (
    (Object.keys(required) as Position[]).some(
      (position) =>
        uniqueLocked.filter((player) => player.position === position).length >
        required[position],
    )
  )
    return [];

  const seedClubCounts = uniqueLocked.reduce<Record<string, number>>(
    (counts, player) =>
      ((counts[player.club] = (counts[player.club] || 0) + 1), counts),
    {},
  );
  let squad = [...uniqueLocked];
  for (const position of ["GK", "DEF", "MID", "FWD"] as Position[]) {
    const candidates = pool
      .filter(
        (player) =>
          player.active !== false &&
          player.position === position &&
          !lockedIds.has(player.id) &&
          !excludedIds.has(player.id),
      )
      .sort(
        (a, b) =>
          a.price - b.price ||
          horizonProjection(b, horizon) - horizonProjection(a, horizon),
      );
    while (squad.filter((player) => player.position === position).length < required[position]) {
      const next = candidates.find(
        (player) =>
          !squad.some((owned) => owned.id === player.id) &&
          (seedClubCounts[player.club] || 0) < 3,
      );
      if (!next) return [];
      squad.push(next);
      seedClubCounts[next.club] = (seedClubCounts[next.club] || 0) + 1;
    }
  }
  if (validateInitialSquad(squad, budget).length) return [];
  const candidates = optimizerCandidates(
    pool,
    lockedIds,
    horizon,
    excludedIds,
  );
  const scoreCache = new Map<number, number>(
    candidates
      .concat(squad)
      .map((player) => [player.id, horizonProjection(player, horizon)]),
  );
  const playerScore = (player: Player) =>
    scoreCache.get(player.id) ?? horizonProjection(player, horizon);

  // Two-tier scoring:
  // 1. proxyScore: cheap lineup-aware score for screening candidates in the
  //    swap loops. Uses a single bestXI + captain bonus over the full horizon
  //    projection — captures the starter/bench split and captain bonus without
  //    the per-gameweek overhead of draftSquadScore.
  // 2. draftSquadScore: full multi-GW lineup-aware score used only for final
  //    acceptance of each pass winner.
  const proxyScoreCache = new Map<string, number>();
  const proxyScore = (candidateSquad: Player[]) => {
    const key = candidateSquad
      .map((p) => p.id)
      .sort((a, b) => a - b)
      .join(",");
    const cached = proxyScoreCache.get(key);
    if (cached !== undefined) return cached;
    const lineup = bestXIWithScore(candidateSquad, playerScore);
    if (lineup.length !== 11) { proxyScoreCache.set(key, -Infinity); return -Infinity; }
    const starterPts = lineup.reduce((sum, p) => sum + playerScore(p), 0);
    const captainPts = Math.max(...lineup.map(playerScore));
    const score = starterPts + captainPts;
    proxyScoreCache.set(key, score);
    return score;
  };
  const fullScoreCache = new Map<string, number>();
  const fullScore = (candidateSquad: Player[]) => {
    const key = candidateSquad
      .map((p) => p.id)
      .sort((a, b) => a - b)
      .join(",");
    const cached = fullScoreCache.get(key);
    if (cached !== undefined) return cached;
    const score = draftSquadScore(horizon, candidateSquad).total;
    fullScoreCache.set(key, score);
    return score;
  };
  const legal = (candidateSquad: Player[]) =>
    validateInitialSquad(candidateSquad, budget).length === 0;
  let currentProxyScore = proxyScore(squad);
  let currentFullScore = fullScore(squad);

  for (let pass = 0; pass < 10; pass++) {
    let bestSquad: Player[] | null = null,
      bestProxy = currentProxyScore;
    const ownedIds = new Set(squad.map((player) => player.id));
    const outgoing = squad.filter((player) => !lockedIds.has(player.id));
    for (const out of outgoing) {
      for (const incoming of candidates) {
        if (incoming.position !== out.position || ownedIds.has(incoming.id))
          continue;
        const next = squad.map((player) =>
          player.id === out.id ? incoming : player,
        );
        if (!legal(next)) continue;
        const nextProxy = proxyScore(next);
        if (nextProxy > bestProxy + 0.001) {
          bestProxy = nextProxy;
          bestSquad = next;
        }
      }
    }
    if (bestSquad) {
      // Verify with full draftSquadScore before accepting
      const candidateFull = fullScore(bestSquad);
      if (candidateFull > currentFullScore + 0.001) {
        squad = bestSquad;
        currentProxyScore = bestProxy;
        currentFullScore = candidateFull;
        continue;
      }
      // Proxy improved but full score didn't — accept anyway to keep
      // exploring (the proxy is a reasonable approximation)
      squad = bestSquad;
      currentProxyScore = bestProxy;
      currentFullScore = candidateFull;
      continue;
    }

    const shortlistByPosition = new Map<Position, Player[]>();
    for (const position of ["GK", "DEF", "MID", "FWD"] as Position[])
      shortlistByPosition.set(
        position,
        candidates
          .filter(
            (player) =>
              player.position === position && !ownedIds.has(player.id),
          )
          .sort((a, b) => playerScore(b) - playerScore(a))
          // Keep a broad shortlist here. A budget-neutral improvement often
          // needs a two-position trade (for example, upgrading a £4.0m
          // goalkeeper while downgrading a defender), and the best funding
          // player may not be among the first few projection-only picks.
          .slice(0, 40),
      );
    // Collect the top dual-swap candidates by proxy score, then verify the best
    const dualCandidates: { squad: Player[]; proxy: number }[] = [];
    for (let left = 0; left < outgoing.length; left++)
      for (let right = left + 1; right < outgoing.length; right++) {
        const firstOut = outgoing[left],
          secondOut = outgoing[right];
        for (const firstIn of shortlistByPosition.get(firstOut.position) || [])
          for (const secondIn of shortlistByPosition.get(secondOut.position) ||
            []) {
            if (firstIn.id === secondIn.id) continue;
            const next = squad.map((player) =>
              player.id === firstOut.id
                ? firstIn
                : player.id === secondOut.id
                  ? secondIn
                  : player,
            );
            if (!legal(next)) continue;
            const nextProxy = proxyScore(next);
            if (nextProxy > currentProxyScore + 0.001) {
              dualCandidates.push({ squad: next, proxy: nextProxy });
            }
          }
      }
    if (!dualCandidates.length) break;
    // Sort by proxy and verify top candidates with full draftSquadScore
    dualCandidates.sort((a, b) => b.proxy - a.proxy);
    let accepted = false;
    for (const candidate of dualCandidates.slice(0, 20)) {
      const candidateFull = fullScore(candidate.squad);
      if (candidateFull > currentFullScore + 0.001) {
        squad = candidate.squad;
        currentProxyScore = candidate.proxy;
        currentFullScore = candidateFull;
        accepted = true;
        break;
      }
    }
    if (!accepted) break;
  }
  return [...squad].sort(
    (a, b) =>
      ({ GK: 0, DEF: 1, MID: 2, FWD: 3 })[a.position] -
        { GK: 0, DEF: 1, MID: 2, FWD: 3 }[b.position] ||
      playerScore(b) - playerScore(a),
  );
}

export function buildDraftImprovementPlan(
  current: Player[],
  pool: Player[],
  options: InitialSquadOptions = {},
): DraftImprovementPlan | null {
  if (
    validateInitialSquad(current, options.budget ?? INITIAL_SQUAD_BUDGET).length
  )
    return null;
  const optimized = optimizeInitialSquad(pool, options);
  if (optimized.length !== 15) return null;
  const horizon = options.horizon ?? 5;
  const currentScore = draftSquadScore(horizon, current).total,
    optimizedScore = draftSquadScore(horizon, optimized).total;
  if (optimizedScore <= currentScore + 0.04) return null;
  const optimizedIds = new Set(optimized.map((player) => player.id)),
    currentIds = new Set(current.map((player) => player.id));
  const outgoing = current.filter((player) => !optimizedIds.has(player.id)),
    incoming = optimized.filter((player) => !currentIds.has(player.id));
  const changes: DraftChange[] = [];
  for (const position of ["GK", "DEF", "MID", "FWD"] as Position[]) {
    const outs = outgoing
      .filter((player) => player.position === position)
      .sort((a, b) => b.price - a.price);
    const ins = incoming
      .filter((player) => player.position === position)
      .sort((a, b) => b.price - a.price);
    outs.forEach((out, index) => {
      const incomingPlayer = ins[index];
      if (incomingPlayer)
        changes.push({
          out,
          in: incomingPlayer,
          priceDelta: +(incomingPlayer.price - out.price).toFixed(1),
          projectionDelta: +(
            horizonProjection(incomingPlayer, horizon) -
            horizonProjection(out, horizon)
          ).toFixed(1),
        });
    });
  }
  return {
    currentScore: +currentScore.toFixed(1),
    optimizedScore: +optimizedScore.toFixed(1),
    gain: +(optimizedScore - currentScore).toFixed(1),
    currentCost: +current
      .reduce((sum, player) => sum + player.price, 0)
      .toFixed(1),
    optimizedCost: +optimized
      .reduce((sum, player) => sum + player.price, 0)
      .toFixed(1),
    changes,
    squad: optimized,
  };
}

export type DraftChangeBundle = {
  id: string;
  label: string;
  changes: DraftChange[];
  netCost: number;
  netGain: number;
  isLegal: boolean;
};

export function groupLegalChangeBundles(
  currentSquad: Player[],
  changes: DraftChange[],
  bank: number = 0,
  horizon: number = 5,
  budgetCap: number = INITIAL_SQUAD_BUDGET,
): DraftChangeBundle[] {
  if (!changes || changes.length === 0 || currentSquad.length !== 15) return [];

  const rawBundles: { id: string; label: string; changes: DraftChange[]; netCost: number }[] = [];

  // Single changes
  changes.forEach((change) => {
    const netCost = +(change.in.price - change.out.price).toFixed(1);
    rawBundles.push({
      id: `single-${change.out.id}-${change.in.id}`,
      label: `${change.out.name} → ${change.in.name}`,
      changes: [change],
      netCost,
    });
  });

  // Paired/grouped budget-linked bundles
  for (let i = 0; i < changes.length; i++) {
    for (let j = i + 1; j < changes.length; j++) {
      const c1 = changes[i];
      const c2 = changes[j];
      if (c1.out.id === c2.out.id) continue;
      const netCost = +((c1.in.price - c1.out.price) + (c2.in.price - c2.out.price)).toFixed(1);

      rawBundles.push({
        id: `bundle-${c1.out.id}-${c1.in.id}-${c2.out.id}-${c2.in.id}`,
        label: `${c1.out.name} → ${c1.in.name} & ${c2.out.name} → ${c2.in.name}`,
        changes: [c1, c2],
        netCost,
      });
    }
  }

  const currentScore = draftSquadScore(horizon, currentSquad).total;
  const validBundles: DraftChangeBundle[] = [];
  const seenIds = new Set<string>();

  for (const raw of rawBundles) {
    if (seenIds.has(raw.id)) continue;
    seenIds.add(raw.id);

    // Apply changes to build full candidate squad
    const swapMap = new Map<number, Player>();
    raw.changes.forEach((c) => swapMap.set(c.out.id, c.in));
    const candidateSquad = currentSquad.map((p) => swapMap.get(p.id) || p);

    // Validate rules (3 per club, positional counts, budget cap)
    const issues = validateInitialSquad(candidateSquad, budgetCap);
    const isLegal = issues.length === 0;

    if (!isLegal) continue;

    // Lineup, bench, captaincy aware score difference
    const candidateScore = draftSquadScore(horizon, candidateSquad).total;
    const netGain = +(candidateScore - currentScore).toFixed(1);

    if (netGain > 0) {
      validBundles.push({
        id: raw.id,
        label: raw.label,
        changes: raw.changes,
        netCost: raw.netCost,
        netGain,
        isLegal: true,
      });
    }
  }

  return validBundles.sort((a, b) => b.netGain - a.netGain);
}

export type ChipType = "WC" | "FH" | "BB" | "TC" | null;

export type ChipImpact = {
  chip: "WC" | "FH" | "BB" | "TC";
  name: string;
  shortName: string;
  description: string;
  projectedGain: number | null;
  notes: string;
};

export type FixtureTickerItem = {
  gameweek: number;
  opponent: string;
  venue: "H" | "A";
  difficulty: number;
  difficultyClass: string;
};

export function getPlayerFixtureTicker(
  player: Player,
  horizon: number = 5,
): FixtureTickerItem[] {
  const upcoming =
    player.upcomingFixtures && player.upcomingFixtures.length > 0
      ? player.upcomingFixtures
      : CLUB_FIXTURES[player.club] || getPlayerUpcomingFixtures(player);
  return upcoming.slice(0, horizon).map((f) => {
    const diff = Math.min(5, Math.max(1, Math.round(f.difficulty)));
    return {
      gameweek: f.gameweek,
      opponent: f.opponent,
      venue: f.venue,
      difficulty: diff,
      difficultyClass: `fdr-${diff}`,
    };
  });
}

export function calculateChipImpact(
  squad: Player[],
  targetGameweek = 1,
): ChipImpact[] {
  const starters = bestXIForGameweek(targetGameweek, squad);
  const starterIds = new Set(starters.map(player => player.id));
  const bench = squad
    .filter(player => !starterIds.has(player.id))
    .sort((left, right) => gameweekProjection(right, targetGameweek) - gameweekProjection(left, targetGameweek));
  const topStarter = [...starters].sort(
    (left, right) => gameweekProjection(right, targetGameweek) - gameweekProjection(left, targetGameweek),
  )[0];
  const captainXpts = topStarter ? gameweekProjection(topStarter, targetGameweek) : 0;
  const tcGain = +captainXpts.toFixed(1);

  const benchXpts = bench.reduce(
    (sum, p) => sum + gameweekProjection(p, targetGameweek),
    0,
  );
  const bbGain = +benchXpts.toFixed(1);


  return [
    {
      chip: "TC",
      name: "Triple Captain",
      shortName: "TC",
      description: "Triples your captain's score instead of doubling it.",
      projectedGain: tcGain,
      notes: topStarter
        ? `GW${targetGameweek}: adds +${tcGain} xPts from ${topStarter.name}`
        : "No captain selected",
    },
    {
      chip: "BB",
      name: "Bench Boost",
      shortName: "BB",
      description: "Includes all 4 bench players in your gameweek points total.",
      projectedGain: bbGain,
      notes: `GW${targetGameweek}: adds +${bbGain} xPts from 4 bench players`,
    },
    {
      chip: "WC",
      name: "Wildcard",
      shortName: "WC",
      description:
        "Unlimited free transfers to permanently restructure your squad with £0 hit cost.",
      projectedGain: null,
      notes: "Generate a forecast-backed chip recommendation to calculate this counterfactual.",
    },
    {
      chip: "FH",
      name: "Free Hit",
      shortName: "FH",
      description: "Make unlimited free transfers for one single gameweek only.",
      projectedGain: null,
      notes: "Generate a forecast-backed chip recommendation to calculate this counterfactual.",
    },
  ];
}

export function generateSquadExportText(
  squad: Player[],
  horizon: 1 | 3 | 5 = 5,
  bank: number = 0,
  freeTransfers: number = 1,
  activeChip: ChipType = null,
): string {
  const score = draftSquadScore(horizon, squad);
  const starters = bestXI(horizon, squad);
  const bench = benchOrder(horizon, squad, starters);
  const captain = starters[0];
  const viceCaptain = starters[1];

  const startersByPos = (pos: Position) =>
    starters
      .filter((p) => p.position === pos)
      .map((p) => {
        const isC = p.id === captain?.id;
        const isV = p.id === viceCaptain?.id;
        const badge = isC ? " (C)" : isV ? " (V)" : "";
        return `${p.name} (£${p.price.toFixed(1)}m, ${p.club})${badge} [${horizonProjection(p, horizon).toFixed(1)} xPts]`;
      });

  const benchPlayers = bench.map(
    (p, i) =>
      `${i + 1}. ${p.name} (${p.position}, £${p.price.toFixed(1)}m, ${p.club}) - ${horizonProjection(p, horizon).toFixed(1)} xPts`,
  );

  const chipStr = activeChip ? ` | Active Chip: ${activeChip}` : "";

  return [
    `⚡ Insomnia FPL Squad Report (GW Horizon: ${horizon}${chipStr})`,
    `----------------------------------------`,
    `💰 Bank: £${bank.toFixed(1)}m | FT: ${freeTransfers} | Projected xPts: ${score.total.toFixed(1)}`,
    ``,
    `🛡️ GOALKEEPERS:`,
    ...startersByPos("GK").map((s) => `  • ${s}`),
    ``,
    `🧱 DEFENDERS:`,
    ...startersByPos("DEF").map((s) => `  • ${s}`),
    ``,
    `🎯 MIDFIELDERS:`,
    ...startersByPos("MID").map((s) => `  • ${s}`),
    ``,
    `⚡ FORWARDS:`,
    ...startersByPos("FWD").map((s) => `  • ${s}`),
    ``,
    `🪑 BENCH:`,
    ...benchPlayers.map((b) => `  • ${b}`),
    ``,
    `----------------------------------------`,
    `Generated by Insomnia FPL`,
  ].join("\n");
}

export type DifferentialPick = {
  player: Player;
  type: "DIFFERENTIAL" | "ENABLER" | "VALUE_GEM";
  xPtsPerMillion: number;
  reason: string;
};

export function getDifferentialsAndEnablers(
  catalog: Player[],
  horizon: 1 | 3 | 5 = 5,
  limit: number = 10,
): DifferentialPick[] {
  const active = catalog.filter((p) => p.active !== false && p.minutes > 0);
  const picks: DifferentialPick[] = [];

  for (const p of active) {
    const xPts = horizonProjection(p, horizon);
    const ppm = +(xPts / p.price).toFixed(2);
    const isLowOwnership = (p.ownership ?? 0) < 10.0;
    const isBudgetEnabler =
      (p.position === "GK" && p.price <= 4.5) ||
      (p.position === "DEF" && p.price <= 4.5) ||
      (p.position === "MID" && p.price <= 5.5) ||
      (p.position === "FWD" && p.price <= 6.0);

    if (isLowOwnership && xPts >= 3.0) {
      picks.push({
        player: p,
        type: "DIFFERENTIAL",
        xPtsPerMillion: ppm,
        reason: `${p.name} has only ${p.ownership ?? 0}% ownership with ${xPts.toFixed(1)} xPts over ${horizon} GWs.`,
      });
    } else if (isBudgetEnabler && ppm >= 0.8) {
      picks.push({
        player: p,
        type: "ENABLER",
        xPtsPerMillion: ppm,
        reason: `Budget enabler at £${p.price.toFixed(1)}m offering ${ppm} xPts/£m.`,
      });
    } else if (ppm >= 1.1) {
      picks.push({
        player: p,
        type: "VALUE_GEM",
        xPtsPerMillion: ppm,
        reason: `High value density of ${ppm} xPts/£m.`,
      });
    }
  }

  return picks
    .sort((a, b) => b.xPtsPerMillion - a.xPtsPerMillion)
    .slice(0, limit);
}

export type CaptaincyBreakdown = {
  totalXpts: number;
  attackingXpts: number;
  defensiveXpts: number;
  bonusAppearanceXpts: number;
  attackingPct: number;
  defensivePct: number;
  bonusAppearancePct: number;
};

export function getCaptaincyBreakdown(
  player: Player,
  horizon: 1 | 3 | 5 = 5,
): CaptaincyBreakdown {
  const breakdown = projectionBreakdown(player, horizon);
  const total = Math.max(0.1, horizonProjection(player, horizon));

  const attacking = Math.max(0, breakdown.attackingContribution || 0);
  const defensive = Math.max(0, breakdown.cleanSheetContribution || 0);
  const bonusApp = Math.max(0, total - attacking - defensive);

  const attackingPct = Math.round((attacking / total) * 100);
  const defensivePct = Math.round((defensive / total) * 100);
  const bonusAppearancePct = Math.max(0, 100 - attackingPct - defensivePct);

  return {
    totalXpts: +total.toFixed(1),
    attackingXpts: +attacking.toFixed(1),
    defensiveXpts: +defensive.toFixed(1),
    bonusAppearanceXpts: +bonusApp.toFixed(1),
    attackingPct,
    defensivePct,
    bonusAppearancePct,
  };
}

export type RivalEOStats = {
  sharedPlayersCount: number;
  userOnlyDifferentials: Player[];
  rivalOnlyDifferentials: Player[];
  effectiveOwnership: Record<
    number,
    { name: string; eoPct: number; userOwns: boolean; isCaptain: boolean }
  >;
};

export function calculateRivalEO(
  rivalPicks: { playerId: number; isCaptain?: boolean; isViceCaptain?: boolean }[],
  userSquad: Player[],
  catalog: Player[],
): RivalEOStats {
  const catalogMap = new Map(catalog.map((p) => [p.id, p]));
  const rivalIds = new Set(rivalPicks.map((rp) => rp.playerId));
  const userIds = new Set(userSquad.map((p) => p.id));

  let sharedCount = 0;
  const userOnly: Player[] = [];
  const rivalOnly: Player[] = [];
  const eo: Record<
    number,
    { name: string; eoPct: number; userOwns: boolean; isCaptain: boolean }
  > = {};

  userSquad.forEach((p) => {
    if (rivalIds.has(p.id)) {
      sharedCount++;
    } else {
      userOnly.push(p);
    }
  });

  rivalPicks.forEach((rp) => {
    const player = catalogMap.get(rp.playerId);
    if (!player) return;
    if (!userIds.has(player.id)) {
      rivalOnly.push(player);
    }
    const ownership = player.ownership ?? 10;
    const eoPct = rp.isCaptain ? ownership + 100 : ownership;
    eo[player.id] = {
      name: player.name,
      eoPct,
      userOwns: userIds.has(player.id),
      isCaptain: Boolean(rp.isCaptain),
    };
  });

  return {
    sharedPlayersCount: sharedCount,
    userOnlyDifferentials: userOnly,
    rivalOnlyDifferentials: rivalOnly,
    effectiveOwnership: eo,
  };
}
