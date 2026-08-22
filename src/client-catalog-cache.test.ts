import { describe, expect, it } from "vitest";
import { clientCatalogCacheKey, readCachedClientCatalog, writeCachedClientCatalog } from "./client-catalog-cache";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const player = { id: 1, name: "Cached Player", club: "ARS", position: "MID", price: 7.5, projection: 5 } as any;
const now = Date.parse("2026-08-22T00:00:00.000Z");

describe("client catalogue cache", () => {
  it("round-trips a recent successful catalogue", () => {
    const storage = memoryStorage();
    writeCachedClientCatalog({ capturedAt: "2026-08-21T23:55:00.000Z", currentGameweek: 1, deadline: null, season: "2026/27", players: [player] }, storage, now);

    expect(readCachedClientCatalog(storage, now)).toMatchObject({ currentGameweek: 1, season: "2026/27", players: [player] });
  });

  it("ignores expired and malformed entries", () => {
    const expired = memoryStorage({
      [clientCatalogCacheKey]: JSON.stringify({ schemaVersion: 1, cachedAt: "2026-08-20T00:00:00.000Z", players: [player] }),
    });
    const malformed = memoryStorage({ [clientCatalogCacheKey]: "not-json" });

    expect(readCachedClientCatalog(expired, now)).toBeNull();
    expect(readCachedClientCatalog(malformed, now)).toBeNull();
  });
});
