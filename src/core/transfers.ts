export type TransferPosition = 'GK' | 'DEF' | 'MID' | 'FWD'

export type EconomicsPlayer = {
  id: string | number;
  club: string;
  position: TransferPosition;
  active?: boolean;
  purchasePriceTenths?: number | null;
  sellingPriceTenths?: number | null;
}

export type TransferMove = {
  outId: string | number;
  incoming: EconomicsPlayer;
}

export type AffordabilityResult = {
  status: 'EXACT' | 'AFFORDABILITY_UNKNOWN';
  bankBeforeTenths: number;
  bankAfterTenths: number | null;
  outgoingValueTenths: number | null;
  incomingValueTenths: number | null;
  missingSellingPlayerIds: string[];
  missingPurchasePlayerIds: string[];
}

export type TransferEvaluation = {
  status: 'LEGAL' | 'ILLEGAL' | 'AFFORDABILITY_UNKNOWN';
  legal: boolean | null;
  reason: string;
  bankBeforeTenths: number;
  bankAfterTenths: number | null;
  hitCost: number;
  missingSellingPlayerIds: string[];
  missingPurchasePlayerIds: string[];
  finalSquad: EconomicsPlayer[];
}

const REQUIRED_POSITIONS: Record<TransferPosition, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 }

function playerKey(id: string | number): string {
  return String(id)
}

function validTenths(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer number of tenths`)
  return value
}

function knownPrice(value: number | null | undefined): value is number {
  return value !== null && value !== undefined
}

export function calculateAffordability({
  bankBeforeTenths,
  outgoing,
  incoming,
}: {
  bankBeforeTenths: number;
  outgoing: EconomicsPlayer[];
  incoming: EconomicsPlayer[];
}): AffordabilityResult {
  const bank = validTenths(bankBeforeTenths, 'bankBeforeTenths')
  const missingSellingPlayerIds = outgoing.filter(player => !knownPrice(player.sellingPriceTenths)).map(player => playerKey(player.id))
  const missingPurchasePlayerIds = incoming.filter(player => !knownPrice(player.purchasePriceTenths)).map(player => playerKey(player.id))
  const outgoingValueTenths = missingSellingPlayerIds.length
    ? null
    : outgoing.reduce((sum, player) => sum + validTenths(player.sellingPriceTenths!, `sellingPriceTenths:${playerKey(player.id)}`), 0)
  const incomingValueTenths = missingPurchasePlayerIds.length
    ? null
    : incoming.reduce((sum, player) => sum + validTenths(player.purchasePriceTenths!, `purchasePriceTenths:${playerKey(player.id)}`), 0)

  if (outgoingValueTenths === null || incomingValueTenths === null) {
    return {
      status: 'AFFORDABILITY_UNKNOWN',
      bankBeforeTenths: bank,
      bankAfterTenths: null,
      outgoingValueTenths,
      incomingValueTenths,
      missingSellingPlayerIds,
      missingPurchasePlayerIds,
    }
  }

  return {
    status: 'EXACT',
    bankBeforeTenths: bank,
    bankAfterTenths: bank + outgoingValueTenths - incomingValueTenths,
    outgoingValueTenths,
    incomingValueTenths,
    missingSellingPlayerIds,
    missingPurchasePlayerIds,
  }
}

function finalSquadForMoves(squad: EconomicsPlayer[], moves: TransferMove[]) {
  const owned = new Map(squad.map(player => [playerKey(player.id), player]))
  const incomingById = new Map<string, EconomicsPlayer>()
  const outgoingIds = new Set<string>()
  const errors: string[] = []

  for (const move of moves) {
    const outId = playerKey(move.outId)
    const inId = playerKey(move.incoming?.id)
    if (outId === inId) errors.push(`transfer ${outId} cannot replace itself`)
    if (outgoingIds.has(outId)) errors.push(`player ${outId} is sold more than once`)
    outgoingIds.add(outId)
    if (!owned.has(outId)) errors.push(`outgoing player ${outId} is not owned`)
    if (incomingById.has(inId)) errors.push(`incoming player ${inId} is added more than once`)
    incomingById.set(inId, move.incoming)
  }

  const final = squad.filter(player => !outgoingIds.has(playerKey(player.id)))
  for (const [inId, player] of incomingById) {
    if (!player) {
      errors.push(`incoming player ${inId} is missing`)
      continue
    }
    if (owned.has(inId) && !outgoingIds.has(inId)) errors.push(`incoming player ${inId} is already owned`)
    if (player.active === false) errors.push(`incoming player ${inId} is inactive`)
    final.push(player)
  }
  return { final, errors }
}

export function evaluateSimultaneousTransfers({
  squad,
  moves,
  bankBeforeTenths,
  freeTransfers,
}: {
  squad: EconomicsPlayer[];
  moves: TransferMove[];
  bankBeforeTenths: number;
  freeTransfers: number;
}): TransferEvaluation {
  const bank = validTenths(bankBeforeTenths, 'bankBeforeTenths')
  if (!Number.isInteger(freeTransfers) || freeTransfers < 0) throw new Error('freeTransfers must be a non-negative integer')
  const owned = new Map(squad.map(player => [playerKey(player.id), player]))
  const outgoing = moves.map(move => owned.get(playerKey(move.outId))).filter((player): player is EconomicsPlayer => Boolean(player))
  const incoming = moves.map(move => move.incoming).filter((player): player is EconomicsPlayer => Boolean(player))
  const affordability = calculateAffordability({ bankBeforeTenths: bank, outgoing, incoming })
  const { final, errors } = finalSquadForMoves(squad, moves)
  const hitCost = Math.max(0, moves.length - freeTransfers) * 4

  if (affordability.status === 'AFFORDABILITY_UNKNOWN') {
    return {
      status: 'AFFORDABILITY_UNKNOWN',
      legal: null,
      reason: 'Exact purchase or selling prices are required before affordability can be established',
      bankBeforeTenths: bank,
      bankAfterTenths: null,
      hitCost,
      missingSellingPlayerIds: affordability.missingSellingPlayerIds,
      missingPurchasePlayerIds: affordability.missingPurchasePlayerIds,
      finalSquad: final,
    }
  }

  const positions = Object.fromEntries(Object.keys(REQUIRED_POSITIONS).map(position => [position, 0])) as Record<TransferPosition, number>
  const clubs = new Map<string, number>()
  for (const player of final) {
    positions[player.position] += 1
    clubs.set(player.club, (clubs.get(player.club) || 0) + 1)
  }
  for (const [position, required] of Object.entries(REQUIRED_POSITIONS) as Array<[TransferPosition, number]>) {
    if (positions[position] !== required) errors.push(`final ${position} count must be ${required}`)
  }
  for (const [club, count] of clubs) if (count > 3) errors.push(`final club ${club} count exceeds three`)
  if (new Set(final.map(player => playerKey(player.id))).size !== final.length) errors.push('final squad contains duplicate players')
  const bankAfterTenths = affordability.bankAfterTenths!
  if (bankAfterTenths < 0) errors.push('final bank is negative')

  return {
    status: errors.length ? 'ILLEGAL' : 'LEGAL',
    legal: errors.length === 0,
    reason: errors[0] || 'simultaneous transfer route is legal',
    bankBeforeTenths: bank,
    bankAfterTenths,
    hitCost,
    missingSellingPlayerIds: [],
    missingPurchasePlayerIds: [],
    finalSquad: final,
  }
}
