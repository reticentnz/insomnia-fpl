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
  | "TRANSFER_OPINION";

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

export type RoleSignalValue = {
  startProbability?: number;
  minutesIfStarting?: number;
  substituteProbabilityWhenBenched?: number;
  minutesIfSubstitute?: number;
  depthRole?: "FIRST_CHOICE" | "ROTATION" | "BACKUP" | "OUT";
  note?: string;
};

export type PlayerSignal = {
  id: string | number;
  playerId: number;
  gameweek?: number | null;
  kind: SignalKind;
  value: RoleSignalValue;
  sourceType: SignalSourceType;
  sourceUrl?: string | null;
  evidenceSummary: string;
  confidence: number;
  observedAt: string;
  validUntil: string;
  status: SignalStatus;
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

function confidenceLabel(confidence: number): RoleConfidence {
  return confidence >= 0.8 ? "HIGH" : confidence >= 0.55 ? "MEDIUM" : "LOW";
}

function signalRole(signal: PlayerSignal): RoleSignalValue {
  // Null is an explicit "not supplied" value in LLM-normalized signals.
  // Only a numeric start probability should override the depth-role fallback.
  if (typeof signal.value.startProbability === "number") return signal.value;
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

export function resolvePlayerRole(
  base: PlayerRoleProfile,
  signals: PlayerSignal[],
  options: { now?: Date; gameweek?: number } = {},
): PlayerRoleProfile {
  const now = options.now ?? new Date();
  const eligible = signals.filter(
    (signal) =>
      signal.status === "VERIFIED" &&
      signal.confidence > 0 &&
      new Date(signal.validUntil).getTime() >= now.getTime() &&
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
  const inputs = overrides.length ? [overrides[0]] : roleInputs;
  const weighted = <K extends keyof RoleSignalValue>(key: K, fallback: number) => {
    const values: { value: number; weight: number }[] = [];
    inputs.forEach((signal) => {
      const value = signalRole(signal)[key];
      if (typeof value === "number") {
        values.push({ value, weight: clamp(signal.confidence) });
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
    inputs.reduce((sum, signal) => sum + clamp(signal.confidence), 0) /
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
