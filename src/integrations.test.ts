import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchFplAccount, leagueSquadValue } from './integrations'

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
