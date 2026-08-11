import { describe, expect, it } from 'vitest'
import { calculateAffordability, evaluateSimultaneousTransfers, type EconomicsPlayer } from './transfers'

function fullSquad(): EconomicsPlayer[] {
  return [
    { id: 'gk-1', club: 'A', position: 'GK', sellingPriceTenths: 40 },
    { id: 'gk-2', club: 'B', position: 'GK', sellingPriceTenths: 40 },
    ...['def-1', 'def-2', 'def-3', 'def-4', 'def-5'].map((id, index) => ({ id, club: ['C', 'D', 'E', 'A', 'B'][index], position: 'DEF' as const, sellingPriceTenths: 50 })),
    ...['mid-1', 'mid-2', 'mid-3', 'mid-4', 'mid-5'].map((id, index) => ({ id, club: ['C', 'D', 'E', 'A', 'B'][index], position: 'MID' as const, sellingPriceTenths: 60 })),
    { id: 'fwd-1', club: 'C', position: 'FWD', sellingPriceTenths: 70 },
    { id: 'fwd-2', club: 'D', position: 'FWD', sellingPriceTenths: 70 },
    { id: 'fwd-3', club: 'E', position: 'FWD', sellingPriceTenths: 70 },
  ]
}

describe('exact transfer economics', () => {
  it('uses the official selling price and never current market price for an outgoing player', () => {
    const outgoing = { id: 'owned', club: 'A', position: 'MID' as const, sellingPriceTenths: 52, purchasePriceTenths: 50, currentPriceTenths: 54 } as EconomicsPlayer & { currentPriceTenths: number }
    const result = calculateAffordability({ bankBeforeTenths: 0, outgoing: [outgoing], incoming: [] })
    expect(result.status).toBe('EXACT')
    expect(result.bankAfterTenths).toBe(52)
  })

  it('returns AFFORDABILITY_UNKNOWN when selling price is missing', () => {
    const result = calculateAffordability({
      bankBeforeTenths: 0,
      outgoing: [{ id: 'owned', club: 'A', position: 'MID', sellingPriceTenths: null, purchasePriceTenths: 50 }],
      incoming: [],
    })
    expect(result.status).toBe('AFFORDABILITY_UNKNOWN')
    expect(result.bankAfterTenths).toBeNull()
  })

  it('funds two simultaneous transfers from final-squad economics', () => {
    const result = evaluateSimultaneousTransfers({
      squad: fullSquad(),
      bankBeforeTenths: 5,
      freeTransfers: 0,
      moves: [
        { outId: 'def-1', incoming: { id: 'new-def', club: 'F', position: 'DEF', active: true, purchasePriceTenths: 45, sellingPriceTenths: 45 } },
        { outId: 'mid-1', incoming: { id: 'new-mid', club: 'F', position: 'MID', active: true, purchasePriceTenths: 68, sellingPriceTenths: 68 } },
      ],
    })
    expect(result.status).toBe('LEGAL')
    expect(result.bankAfterTenths).toBe(2)
    expect(result.hitCost).toBe(8)
  })

  it('checks club limits after simultaneous sales and purchases', () => {
    const squad = fullSquad().map(player => ['gk-1', 'def-1', 'mid-1'].includes(String(player.id)) ? { ...player, club: 'ARS' } : player)
    const result = evaluateSimultaneousTransfers({
      squad,
      bankBeforeTenths: 100,
      freeTransfers: 1,
      moves: [{ outId: 'gk-1', incoming: { id: 'new-gk', club: 'ARS', position: 'GK', active: true, purchasePriceTenths: 40, sellingPriceTenths: 40 } }],
    })
    expect(result.status).toBe('LEGAL')
  })
})
