import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchFplAccount, fetchFplLiveScore, fetchLeagueLiveState, leagueSquadValue } from './integrations'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchFplAccount', () => {
  it('preserves classic and head-to-head leagues returned by the manager import', async () => {
    const classicLeague = { id: 321, name: 'Cash League', entry_rank: 4 }
    const h2hLeague = { id: 654, name: 'Head to Head' }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      account: {
        id: 'manager:123',
        teamId: 123,
        teamName: 'Test FC',
        leagues: { classic: [classicLeague], h2h: [h2hLeague] },
      },
      squad: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchFplAccount(123, 1)

    expect(result.account.leagues).toEqual({
      classic: [classicLeague],
      h2h: [h2hLeague],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses empty league lists when an older server response omits them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      account: { teamId: 123, teamName: 'Test FC' },
      squad: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const result = await fetchFplAccount(123, 1)

    expect(result.account.leagues).toEqual({ classic: [], h2h: [] })
  })
})

describe('fetchFplLiveScore', () => {
  it('requests an uncached score for the linked team and current gameweek', async () => {
    const payload = { gameweek: 2, gameweekPoints: 47, updatedAt: '2026-08-22T03:00:00.000Z', chipsUsed: [{ name: 'bboost', time: '2026-08-22T03:00:00.000Z', event: 2 }] }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchFplLiveScore(123, 2)).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/manager/live-score?teamId=123&gameweek=2',
      { cache: 'no-store' },
    )
  })
})

describe('leagueSquadValue', () => {
  it('removes bank funds from FPL total team value', () => {
    expect(leagueSquadValue(101, 1)).toBe(100)
    expect(leagueSquadValue(100, 1)).toBe(99)
    expect(leagueSquadValue(100, 1.5)).toBe(98.5)
  })

  it('preserves unavailable values', () => {
    expect(leagueSquadValue(null, 1)).toBeNull()
  })
})

describe('fetchLeagueLiveState', () => {
  it('requests an uncached live update scoped to the league, GW, and manager', async () => {
    const payload = { updatedAt: '2026-08-22T03:00:00.000Z', standings: [] }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchLeagueLiveState(321, 2, 123)).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/fpl-league-live?leagueId=321&gameweek=2&youEntry=123',
      { cache: 'no-store' },
    )
  })
})
