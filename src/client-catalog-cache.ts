import type { Player } from "./domain";

const CACHE_KEY = "insomnia-fpl:client-catalog:v1";
const CACHE_SCHEMA_VERSION = 1;
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

export type CachedClientCatalog = {
  schemaVersion: 1;
  cachedAt: string;
  capturedAt: string | null;
  currentGameweek: number | null;
  deadline: string | null;
  nextGameweek?: number | null;
  currentGameweekDeadline?: string | null;
  season: string | null;
  players: Player[];
};

type CatalogSnapshot = Omit<CachedClientCatalog, "schemaVersion" | "cachedAt">;
type CatalogStorage = Pick<Storage, "getItem" | "setItem">;

function isUsableCatalog(value: unknown, now: number): value is CachedClientCatalog {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CachedClientCatalog>;
  const cachedAt = Date.parse(candidate.cachedAt || "");
  return candidate.schemaVersion === CACHE_SCHEMA_VERSION
    && Number.isFinite(cachedAt)
    && now - cachedAt >= 0
    && now - cachedAt <= MAX_CACHE_AGE_MS
    && Array.isArray(candidate.players)
    && candidate.players.length > 0
    && candidate.players.every((player) => Number.isInteger(player?.id)
      && typeof player?.name === "string"
      && typeof player?.club === "string"
      && typeof player?.position === "string"
      && typeof player?.price === "number"
      && typeof player?.projection === "number");
}

export function readCachedClientCatalog(
  storage?: CatalogStorage | null,
  now = Date.now(),
): CachedClientCatalog | null {
  try {
    const target = storage === undefined
      ? (typeof window === "undefined" ? null : window.localStorage)
      : storage;
    if (!target) return null;
    const value = JSON.parse(target.getItem(CACHE_KEY) || "null") as unknown;
    return isUsableCatalog(value, now) ? value : null;
  } catch {
    return null;
  }
}

export function writeCachedClientCatalog(
  snapshot: CatalogSnapshot,
  storage?: CatalogStorage | null,
  now = Date.now(),
): void {
  try {
    const target = storage === undefined
      ? (typeof window === "undefined" ? null : window.localStorage)
      : storage;
    if (!target || snapshot.players.length === 0) return;
    target.setItem(CACHE_KEY, JSON.stringify({
      schemaVersion: CACHE_SCHEMA_VERSION,
      cachedAt: new Date(now).toISOString(),
      ...snapshot,
    } satisfies CachedClientCatalog));
  } catch {
    // Storage can be unavailable or full. A cache miss should never block startup.
  }
}

export const clientCatalogCacheKey = CACHE_KEY;
