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

export function resolvePlayerRole(
  base: PlayerRoleProfile,
  signals: PlayerSignal[],
  options: { now?: Date; gameweek?: number; decayHalfLifeDays?: number } = {},
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
      (signal.gameweek == null || signal.gameweek === options.gameweek),
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
  const inputs = overrides.length ? [overrides[0]] : trustedInputs;
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

  return normalizeRoleProfile({
    startProbability: weighted("startProbability", base.startProbability),
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
  });
}
