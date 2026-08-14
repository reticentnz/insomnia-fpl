/** Values crossing from persisted observations into the projection model. */
export type SourceFreshness = {
  source: 'OFFICIAL_FPL' | 'UNDERLYING' | 'MARKET' | 'SIGNALS'
  observedAt: string | null
  feedRunIds: string[]
  status: 'FRESH' | 'STALE' | 'MISSING'
}

export type InputProvenance = {
  officialObservationId: string
  underlyingObservationId: string | null
  eligibleSignalIds: string[]
  manualOverrideSignalIds: string[]
  excluded: { underlying: string[]; signals: string[] }
}

export type ProjectionCatalogFixture = {
  id: string
  fplId: number
  gameweekId: string | null
  gameweekFplId: number | null
  kickoffAt: string | null
  isHome: boolean
  difficulty: number | null
  opponent: { id: string; fplId: number; name: string; shortName: string; teamStrength: Record<string, number | null> }
  market: {
    id: string
    homeExpectedGoals: number
    awayExpectedGoals: number
    homeCleanSheetProbability: number | null
    awayCleanSheetProbability: number | null
    derivationMethod: string
    capturedAt: string
    ageMs: number
  } | null
}

export type ProjectionCatalogPlayer = {
  id: string
  fplId: number
  name: string
  identityNames?: string[]
  team: { id: string; fplId: number; name: string; shortName: string }
  official: Record<string, unknown>
  teamStrength: Record<string, number | null>
  fixtures: ProjectionCatalogFixture[]
  underlying: Record<string, unknown> | null
  roleSignals: Array<Record<string, unknown>>
  provenance: InputProvenance
  // Fields added by the /api/catalog response transformer (used by client mapper)
  expectedMinutes?: number
  roleProfile?: any
  dataConfidence?: string
}

export type ProjectionInputCatalog = {
  asOf: string
  season: string
  players: ProjectionCatalogPlayer[]
  sourceRunIds: { official: string[]; underlying: string[]; market: string[] }
  freshness: Record<'official' | 'underlying' | 'market' | 'signals', SourceFreshness>
  inputHash: string
}
