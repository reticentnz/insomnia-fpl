export type SignalKind =
  | "START_PROBABILITY"
  | "DEPTH_CHART"
  | "INJURY"
  | "EXPECTED_ROLE"
  | "PENALTIES"
  | "SET_PIECES"
  | "PRESEASON_MINUTES"
  | "TACTICAL_ROLE"
  | "VALUE_OPINION"
  | "STATISTICAL_CLAIM"
  | "TRANSFER_OPINION"
  | "PERFORMANCE_FORECAST";

export type SignalSourceType =
  | "OFFICIAL_FPL"
  | "OFFICIAL_CLUB"
  | "OFFICIAL_PL"
  | "JOURNALIST"
  | "PREDICTED_LINEUP"
  | "USER_FEEDBACK"
  | "LLM_RESEARCH"
  | "MANUAL_OVERRIDE"
  | "YOUTUBE_TRANSCRIPT"
  | "SCRAPE";

export type SignalStatus = "PENDING" | "VERIFIED" | "REJECTED" | "EXPIRED";
export type RoleConfidence = "LOW" | "MEDIUM" | "HIGH";
export type SignalClaimClass =
  | "REAL_WORLD_ROLE"
  | "ROTATION"
  | "AVAILABILITY"
  | "INJURY"
  | "SET_PIECES"
  | "PENALTIES"
  | "FPL_SELECTION"
  | "CREATOR_RATING"
  | "VALUE_OPINION"
  | "STATISTICAL_CONTEXT"
  | "PERFORMANCE_FORECAST"
  | "UNKNOWN";

export type RoleSignalValue = {
  startProbability?: number;
  minutesIfStarting?: number;
  substituteProbabilityWhenBenched?: number;
  minutesIfSubstitute?: number;
  depthRole?: "FIRST_CHOICE" | "ROTATION" | "BACKUP" | "OUT";
  /** A manager-confirmed responsibility that adds a conservative attacking-rate uplift. */
  setPieceRole?: "SET_PIECES" | "PENALTIES" | "PENALTIES_AND_SET_PIECES";
  note?: string;
  forecastMetric?: "EXPECTED_POINTS" | "PRICE";
  forecastDirection?: "UNDERPERFORM" | "OUTPERFORM" | "PRICE_FALL" | "PRICE_RISE";
  forecastProbability?: number;
  forecastHorizon?: string;
  /**
   * Optional provenance supplied by structured ingestion.  It prevents several
   * articles repeating one team-sheet from looking like independent evidence.
   */
  evidenceKey?: string;
  evidenceScope?: "SINGLE_MATCH_LINEUP" | "MANAGER_COMMENT" | "SEASON_ROLE";
};

export type RoleCalibration = {
  completedGameweeks: number;
  earlySeason: boolean;
  independentEvidenceCount: number;
  correlatedEvidenceCount: number;
  singleMatchEvidenceCount: number;
  startProbabilityWithoutLatestEvidence: number;
  latestEvidenceDelta: number;
  sensitivity: "NONE" | "EARLY_SEASON" | "LATEST_MATCH_SENSITIVE";
  reasons: string[];
};

export type PlayerSignal = {
  id: string | number;
  playerId: number;
  gameweek?: number | null;
  kind: SignalKind;
  value: RoleSignalValue;
  sourceType: SignalSourceType;
  sourceUrl?: string | null;
  sourceName?: string | null;
  sourceDate?: string | null;
  evidenceSummary: string;
  evidenceText?: string;
  claimClass?: SignalClaimClass;
  confidence: number;
  observedAt: string;
  validUntil: string;
  status: SignalStatus;
  interpretation?: {
    id: string | null;
    origin: "AUTO" | "USER";
    claimClass: SignalClaimClass;
    modelImpact: "ROLE" | "NONE";
    value: RoleSignalValue;
    rationale: string;
    confidence: number;
    status: "PROPOSED" | "APPROVED" | "REJECTED" | "SUPERSEDED";
  };
};

export type PlayerRoleProfile = {
  startProbability: number;
  minutesIfStarting: number;
  substituteProbabilityWhenBenched: number;
  minutesIfSubstitute: number;
  confidence: RoleConfidence;
  derivedFromSignalIds: Array<string | number>;
  updatedAt?: string;
  /** Present for role estimates resolved against a known season context. */
  calibration?: RoleCalibration;
};

import { signalSourceTrust } from "./signal-sources.ts";

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

export function sanitizeExternalUrl(url?: string | null): string | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (
    !trimmed ||
    trimmed === "#" ||
    /^(untitled(\s+source)?|n\/a|none|null|undefined|about:blank)$/i.test(trimmed)
  ) {
    return null;
  }
  let target = trimmed;
  if (!/^(https?:\/\/)/i.test(target)) {
    if (/^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/.*)?$/.test(target)) {
      target = `https://${target}`;
    } else {
      return null;
    }
  }
  try {
    const parsed = new URL(target);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

export function normalizeRoleProfile(profile: PlayerRoleProfile): PlayerRoleProfile {
  return {
    ...profile,
    startProbability: clamp(profile.startProbability),
    minutesIfStarting: clamp(profile.minutesIfStarting, 0, 90),
    substituteProbabilityWhenBenched: clamp(profile.substituteProbabilityWhenBenched),
    minutesIfSubstitute: clamp(profile.minutesIfSubstitute, 0, 45),
    derivedFromSignalIds: [...new Set(profile.derivedFromSignalIds)],
    calibration: profile.calibration && {
      ...profile.calibration,
      completedGameweeks: Math.max(0, Math.floor(profile.calibration.completedGameweeks || 0)),
      independentEvidenceCount: Math.max(0, Math.floor(profile.calibration.independentEvidenceCount || 0)),
      correlatedEvidenceCount: Math.max(0, Math.floor(profile.calibration.correlatedEvidenceCount || 0)),
      singleMatchEvidenceCount: Math.max(0, Math.floor(profile.calibration.singleMatchEvidenceCount || 0)),
      startProbabilityWithoutLatestEvidence: clamp(profile.calibration.startProbabilityWithoutLatestEvidence),
      latestEvidenceDelta: Number.isFinite(profile.calibration.latestEvidenceDelta) ? profile.calibration.latestEvidenceDelta : 0,
      reasons: [...new Set(profile.calibration.reasons || [])],
    },
  };
}

export function expectedRoleMinutes(profile: PlayerRoleProfile) {
  const role = normalizeRoleProfile(profile);
  return (
    role.startProbability * role.minutesIfStarting +
    (1 - role.startProbability) *
      role.substituteProbabilityWhenBenched *
      role.minutesIfSubstitute
  );
}

export function isSignalAppliedToRole(
  profile: PlayerRoleProfile | undefined,
  signalId: string | number,
) {
  return Boolean(
    profile?.derivedFromSignalIds.some((id) => String(id) === String(signalId)),
  );
}

function confidenceLabel(confidence: number): RoleConfidence {
  return confidence >= 0.8 ? "HIGH" : confidence >= 0.55 ? "MEDIUM" : "LOW";
}

function signalRole(signal: PlayerSignal): RoleSignalValue {
  // Null is an explicit "not supplied" value in LLM-normalized signals.
  // Only a numeric start probability should override the depth-role fallback.
  if (typeof signal.value.startProbability === "number") {
    const prob = signal.value.startProbability > 1 ? signal.value.startProbability / 100 : signal.value.startProbability;
    return { ...signal.value, startProbability: prob };
  }
  if (signal.value.depthRole === "FIRST_CHOICE")
    return { ...signal.value, startProbability: 0.88 };
  if (signal.value.depthRole === "ROTATION")
    return { ...signal.value, startProbability: 0.55 };
  if (signal.value.depthRole === "BACKUP")
    return { ...signal.value, startProbability: 0.08 };
  if (signal.value.depthRole === "OUT")
    return { ...signal.value, startProbability: 0 };
  return signal.value;
}

function roleSourceRecencyDays(kind: string) {
  if (kind === "INJURY") return 10;
  if (["START_PROBABILITY", "DEPTH_CHART", "EXPECTED_ROLE", "PRESEASON_MINUTES", "TACTICAL_ROLE"].includes(kind)) return 14;
  return null;
}

const contextOnlyClaimClasses = new Set(["FPL_SELECTION", "CREATOR_RATING", "VALUE_OPINION", "STATISTICAL_CONTEXT", "PERFORMANCE_FORECAST", "UNKNOWN"]);

function hasFreshSourceDate(signal: PlayerSignal, now: Date) {
  const maxAgeDays = roleSourceRecencyDays(String(signal.kind));
  if (maxAgeDays == null || !signal.sourceDate) return true;
  const sourceDate = Date.parse(signal.sourceDate);
  if (!Number.isFinite(sourceDate)) return false;
  const ageDays = (now.getTime() - sourceDate) / (24 * 60 * 60 * 1000);
  return ageDays >= -1 && ageDays <= maxAgeDays;
}

function sourceIdentity(signal: PlayerSignal, source: string) {
  try {
    const parsed = new URL(source);
    if (signal.sourceType === "YOUTUBE_TRANSCRIPT") {
      // Timestamped transcript citations from different videos must not
      // supersede one another merely because they share youtube.com.
      parsed.searchParams.delete("t");
      return parsed.toString();
    }
    return parsed.hostname;
  } catch {
    return source;
  }
}

function signalText(signal: PlayerSignal) {
  return `${signal.evidenceSummary || ""} ${signal.evidenceText || ""} ${signal.value.note || ""}`.toLowerCase();
}

function isOpeningFixtureOnlySignal(signal: PlayerSignal, gameweek: number | undefined) {
  if (gameweek == null || gameweek <= 1) return false;
  // A pre-season/opening-day claim is useful for GW1 but must not suppress a
  // proven starter in later gameweeks merely because it has a long validity
  // window. Explicit GW-scoped signals are handled separately above.
  return /\b(opening day|opening (?:league )?game|gameweek\s*1|gw\s*1|first league game)\b/.test(signalText(signal));
}

function isConfirmatoryFirstChoiceSignal(signal: PlayerSignal) {
  const value = signalRole(signal);
  if (value.depthRole !== 'FIRST_CHOICE' || typeof value.startProbability !== 'number') return false;
  return !/\b(not expected to start|rotation|rotated|benched|bench|minutes management|rested|injur(?:y|ed)|doubt|competition)\b/.test(signalText(signal));
}

/**
 * Ingestion can provide an exact evidence key.  Older signals are classified
 * conservatively from their text, so reports of a named/starting XI are only
 * one observation even when several publishers repeat it.
 */
function evidenceClusterKey(signal: PlayerSignal) {
  if (signal.value.evidenceKey) return `key:${signal.value.evidenceKey}`;
  if (signal.value.evidenceScope === "SINGLE_MATCH_LINEUP") return `lineup:${signal.gameweek ?? "unknown"}`;
  const text = signalText(signal);
  if (/\b(starting xi|starting eleven|starting lineup|starting line-?up|named in (?:the )?lineup|named among the starters|made (?:the )?start)\b/.test(text)) {
    return `lineup:${signal.gameweek ?? (signal.sourceDate || signal.observedAt || "").slice(0, 10)}`;
  }
  return `signal:${String(signal.id)}`;
}

function isSingleMatchEvidence(signal: PlayerSignal) {
  return signal.value.evidenceScope === "SINGLE_MATCH_LINEUP" || evidenceClusterKey(signal).startsWith("lineup:");
}

function isExplicitManagerEvidence(signal: PlayerSignal) {
  return signal.value.evidenceScope === "MANAGER_COMMENT" || /\b(manager|head coach|boss|g[aá]ffer)\b/.test(signalText(signal));
}

function roleCalibration(base: PlayerRoleProfile, evidenceInputs: PlayerSignal[], resolvedStartProbability: number, completedGameweeks: number | undefined): RoleCalibration | undefined {
  if (completedGameweeks == null) return undefined;
  const completed = Math.max(0, Math.floor(completedGameweeks));
  const clusters = new Map<string, PlayerSignal[]>();
  for (const signal of evidenceInputs) {
    const key = evidenceClusterKey(signal);
    clusters.set(key, [...(clusters.get(key) || []), signal]);
  }
  const independentEvidenceCount = clusters.size;
  const correlatedEvidenceCount = Math.max(0, evidenceInputs.length - independentEvidenceCount);
  const singleMatchEvidenceCount = [...clusters.values()].filter(cluster => cluster.some(isSingleMatchEvidence)).length;
  const latest = [...evidenceInputs].sort((left, right) => Date.parse(right.sourceDate || right.observedAt) - Date.parse(left.sourceDate || left.observedAt))[0];
  // This is deliberately a sensitivity bound rather than a fabricated second
  // forecast: it tells the recommender whether removing the newest piece of
  // role evidence would materially change availability.
  const latestStart = latest ? signalRole(latest).startProbability : undefined;
  const latestEvidenceDelta = typeof latestStart === "number" ? resolvedStartProbability - base.startProbability : 0;
  const earlySeason = completed <= 3;
  const latestMatchSensitive = earlySeason && singleMatchEvidenceCount > 0 && Math.abs(latestEvidenceDelta) >= .08;
  const reasons: string[] = [];
  if (earlySeason) reasons.push(`Only ${completed} completed gameweek${completed === 1 ? "" : "s"} informs the role prior.`);
  if (correlatedEvidenceCount) reasons.push(`${correlatedEvidenceCount + 1} role reports share a match-evidence cluster and are counted once.`);
  if (singleMatchEvidenceCount) reasons.push("A single-match lineup observation is not treated as proof of a season-long role.");
  return {
    completedGameweeks: completed,
    earlySeason,
    independentEvidenceCount,
    correlatedEvidenceCount,
    singleMatchEvidenceCount,
    startProbabilityWithoutLatestEvidence: base.startProbability,
    latestEvidenceDelta,
    sensitivity: latestMatchSensitive ? "LATEST_MATCH_SENSITIVE" : earlySeason ? "EARLY_SEASON" : "NONE",
    reasons,
  };
}

export function resolvePlayerRole(
  base: PlayerRoleProfile,
  signals: PlayerSignal[],
  options: { now?: Date; gameweek?: number; decayHalfLifeDays?: number; completedGameweeks?: number } = {},
): PlayerRoleProfile {
  const now = options.now ?? new Date();
  const decayHalfLifeDays = options.decayHalfLifeDays ?? 14;
  const eligible = signals.filter(
    (signal) =>
      signal.status === "VERIFIED" &&
      signal.confidence > 0 &&
      (!signal.interpretation || (signal.interpretation.status === "APPROVED" && signal.interpretation.modelImpact === "ROLE" && !contextOnlyClaimClasses.has(String(signal.interpretation.claimClass)))) &&
      new Date(signal.validUntil).getTime() >= now.getTime() &&
      hasFreshSourceDate(signal, now) &&
      (signal.gameweek == null || signal.gameweek === options.gameweek) &&
      !isOpeningFixtureOnlySignal(signal, options.gameweek),
  );
  if (!eligible.length) return normalizeRoleProfile(base);

  const roleInputs = eligible.filter((signal) => {
    const value = signalRole(signal);
    return (
      typeof value.startProbability === "number" ||
      typeof value.minutesIfStarting === "number" ||
      typeof value.substituteProbabilityWhenBenched === "number" ||
      typeof value.minutesIfSubstitute === "number" ||
      Boolean(value.depthRole)
    );
  });
  if (!roleInputs.length) return normalizeRoleProfile(base);
  const overrides = roleInputs
    .filter((signal) => signal.sourceType === "MANUAL_OVERRIDE")
    .sort(
      (a, b) =>
        new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime(),
    );
  const superseded = new Set<string | number>();
  const latestByOrigin = new Map<string, PlayerSignal>();
  roleInputs.forEach((signal) => {
    const source = sanitizeExternalUrl(signal.sourceUrl);
    if (!source) return;
    const key = `${signal.kind}|${signal.sourceType}|${sourceIdentity(signal, source)}`;
    const previous = latestByOrigin.get(key);
    if (!previous || Date.parse(signal.observedAt) > Date.parse(previous.observedAt)) {
      if (previous) superseded.add(previous.id);
      latestByOrigin.set(key, signal);
    } else superseded.add(signal.id);
  });
  const currentInputs = roleInputs.filter((signal) => !superseded.has(signal.id));
  const strongestTrust = Math.max(...currentInputs.map((signal) => signalSourceTrust(signal.sourceType, signal.sourceUrl)));
  // Conflicting lower-authority claims remain visible for review, but cannot
  // pull an official/reputable role estimate away from stronger evidence.
  const trustedInputs = currentInputs.filter((signal) => signalSourceTrust(signal.sourceType, signal.sourceUrl) >= strongestTrust - .08);
  // One report of a starting XI can be syndicated widely.  Keep a single
  // representative from each cluster, choosing the higher-trust/newer source.
  const clustered = new Map<string, PlayerSignal>();
  const evidenceInputs = overrides.length ? [overrides[0]] : trustedInputs;
  for (const signal of evidenceInputs) {
    const key = evidenceClusterKey(signal);
    const previous = clustered.get(key);
    if (!previous || signalSourceTrust(signal.sourceType, signal.sourceUrl) > signalSourceTrust(previous.sourceType, previous.sourceUrl) ||
      (signalSourceTrust(signal.sourceType, signal.sourceUrl) === signalSourceTrust(previous.sourceType, previous.sourceUrl) && Date.parse(signal.observedAt) > Date.parse(previous.observedAt))) {
      clustered.set(key, signal);
    }
  }
  const inputs = [...clustered.values()];
  const effectiveConfidence = (signal: PlayerSignal) =>
    clamp(Math.min(signal.confidence, signal.interpretation?.confidence ?? signal.confidence));
  const effectiveWeight = (signal: PlayerSignal) => {
    // Manual overrides intentionally bypass both decay and weighted averaging.
    if (signal.sourceType === "MANUAL_OVERRIDE") return effectiveConfidence(signal);
    if (!(decayHalfLifeDays > 0)) return effectiveConfidence(signal);
    const observedAt = new Date(signal.sourceDate || signal.observedAt).getTime();
    const ageDays = Number.isFinite(observedAt)
      ? Math.max(0, (now.getTime() - observedAt) / (24 * 60 * 60 * 1000))
      : 0;
    return effectiveConfidence(signal) * signalSourceTrust(signal.sourceType, signal.sourceUrl) * 2 ** (-ageDays / decayHalfLifeDays);
  };
  const weighted = <K extends keyof RoleSignalValue>(key: K, fallback: number) => {
    const values: { value: number; weight: number }[] = [];
    inputs.forEach((signal) => {
      const value = signalRole(signal)[key];
      if (typeof value === "number") {
        values.push({ value, weight: effectiveWeight(signal) });
      }
    });
    if (!values.length) return fallback;
    const denominator = values.reduce((sum, item) => sum + item.weight, 0);
    return denominator
      ? values.reduce((sum, item) => sum + item.value * item.weight, 0) /
          denominator
      : fallback;
  };
  const aggregateConfidence =
    inputs.reduce((sum, signal) => sum + effectiveWeight(signal), 0) /
    inputs.length;

  const manual = overrides.length > 0;
  let rawStartProbability = weighted("startProbability", base.startProbability);
  // Confirmation that a known first-choice player started does not constitute
  // evidence that their established availability has fallen to 88%. Preserve
  // the prior unless the signal actually contains rotation/injury evidence.
  if (!manual && rawStartProbability < base.startProbability && inputs.length > 0 && inputs.every(isConfirmatoryFirstChoiceSignal)) {
    rawStartProbability = base.startProbability;
  }
  const completed = options.completedGameweeks;
  const earlySeason = completed != null && completed <= 3;
  const highStartClaim = rawStartProbability >= .85 && rawStartProbability > base.startProbability;
  const hasManagerEvidence = inputs.some(isExplicitManagerEvidence);
  const independentEvidenceCount = new Set(inputs.map(evidenceClusterKey)).size;
  // A lone, early-season FIRST_CHOICE/high-start claim may be a single lineup
  // observation. It can move the prior, but cannot by itself create an 88–90%
  // availability estimate. Explicit manager comments and corroborated sources
  // remain capable of doing so; manual overrides always retain precedence.
  const earlyStartEvidenceWeight = !manual && earlySeason && highStartClaim
    ? hasManagerEvidence || independentEvidenceCount >= 2 ? 1 : .45
    : 1;
  const calibratedStartProbability = base.startProbability + (rawStartProbability - base.startProbability) * earlyStartEvidenceWeight;
  const calibration = roleCalibration(base, evidenceInputs, calibratedStartProbability, completed);

  return normalizeRoleProfile({
    startProbability: calibratedStartProbability,
    minutesIfStarting: weighted("minutesIfStarting", base.minutesIfStarting),
    substituteProbabilityWhenBenched: weighted(
      "substituteProbabilityWhenBenched",
      base.substituteProbabilityWhenBenched,
    ),
    minutesIfSubstitute: weighted(
      "minutesIfSubstitute",
      base.minutesIfSubstitute,
    ),
    confidence: confidenceLabel(aggregateConfidence),
    derivedFromSignalIds: inputs.map((signal) => signal.id),
    updatedAt: inputs
      .map((signal) => signal.observedAt)
      .sort()
      .slice(-1)[0],
    calibration,
  });
}
