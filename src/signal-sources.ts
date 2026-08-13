import type { SignalSourceType } from './player-signals.ts'

export type SignalSourceCategory = 'OFFICIAL' | 'REPUTABLE_NEWS' | 'LINEUP_SPECIALIST' | 'CREATOR' | 'USER' | 'UNKNOWN'

const OFFICIAL_DOMAINS = [
  'premierleague.com', 'fantasy.premierleague.com', 'arsenal.com', 'avfc.co.uk',
  'afcb.co.uk', 'brentfordfc.com', 'brightonandhovealbion.com', 'burnleyfootballclub.com',
  'chelseafc.com', 'cpfc.co.uk', 'evertonfc.com', 'fulhamfc.com', 'itfc.co.uk',
  'leedsunited.com', 'lcfc.com', 'liverpoolfc.com', 'mancity.com', 'manutd.com',
  'newcastleunited.com', 'nottinghamforest.co.uk', 'safc.com', 'southamptonfc.com',
  'tottenhamhotspur.com', 'whufc.com', 'wolves.co.uk',
]
const NEWS_DOMAINS = ['bbc.com', 'bbc.co.uk', 'skysports.com', 'theguardian.com', 'theathletic.com']
const LINEUP_DOMAINS = ['fantasyfootballscout.co.uk', 'rotowire.com', 'premierinjuries.com']

function hostnameOf(url?: string | null) {
  if (!url) return null
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return null }
}

function domainMatches(hostname: string | null, domains: string[]) {
  return Boolean(hostname && domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`)))
}

export function classifySignalSource(sourceType: SignalSourceType, sourceUrl?: string | null) {
  const hostname = hostnameOf(sourceUrl)
  if (sourceType === 'MANUAL_OVERRIDE') return { hostname, category: 'USER' as const, curated: true, trustWeight: 1 }
  if (sourceType === 'OFFICIAL_FPL' || sourceType === 'OFFICIAL_PL') {
    const curated = !hostname || domainMatches(hostname, ['premierleague.com', 'fantasy.premierleague.com'])
    return { hostname, category: 'OFFICIAL' as const, curated, trustWeight: curated ? .98 : .55 }
  }
  if (sourceType === 'OFFICIAL_CLUB') {
    const curated = domainMatches(hostname, OFFICIAL_DOMAINS)
    return { hostname, category: 'OFFICIAL' as const, curated, trustWeight: curated ? .95 : .55 }
  }
  if (sourceType === 'JOURNALIST') {
    const curated = domainMatches(hostname, NEWS_DOMAINS)
    return { hostname, category: 'REPUTABLE_NEWS' as const, curated, trustWeight: curated ? .82 : .68 }
  }
  if (sourceType === 'PREDICTED_LINEUP') {
    const curated = domainMatches(hostname, LINEUP_DOMAINS)
    return { hostname, category: 'LINEUP_SPECIALIST' as const, curated, trustWeight: curated ? .76 : .62 }
  }
  if (sourceType === 'LLM_RESEARCH') return { hostname, category: 'UNKNOWN' as const, curated: false, trustWeight: .62 }
  if (sourceType === 'YOUTUBE_TRANSCRIPT') return { hostname, category: 'CREATOR' as const, curated: hostname === 'youtube.com' || hostname === 'youtu.be', trustWeight: .55 }
  if (sourceType === 'USER_FEEDBACK') return { hostname, category: 'USER' as const, curated: true, trustWeight: .45 }
  return { hostname, category: 'UNKNOWN' as const, curated: false, trustWeight: .4 }
}

export function signalSourceTrust(sourceType: SignalSourceType, sourceUrl?: string | null) {
  return classifySignalSource(sourceType, sourceUrl).trustWeight
}

export function sourceTypeMatchesUrl(sourceType: SignalSourceType, sourceUrl?: string | null) {
  if (!sourceUrl) return false
  const source = classifySignalSource(sourceType, sourceUrl)
  return source.curated || !['OFFICIAL_FPL', 'OFFICIAL_PL', 'OFFICIAL_CLUB', 'JOURNALIST', 'PREDICTED_LINEUP'].includes(sourceType)
}

export const SIGNAL_SOURCE_REGISTRY = {
  officialDomains: OFFICIAL_DOMAINS,
  newsDomains: NEWS_DOMAINS,
  lineupDomains: LINEUP_DOMAINS,
}
