import { randomUUID } from 'node:crypto'
import { canonicalJson } from './feed-run.mjs'

function integer(value, label, { nullable = false, minimum = 0 } = {}) {
  if (value === null || value === undefined || value === '') {
    if (nullable) return null
    throw new Error(`${label} is required`)
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${label} must be an integer >= ${minimum}`)
  return parsed
}

function parseJson(value) {
  try { return JSON.parse(value || '{}') } catch { return {} }
}

async function resolveManager(db, { managerAccountId, fplEntryId } = {}) {
  if (managerAccountId) {
    const result = await db.query('SELECT * FROM "ManagerAccount" WHERE "id"=$1', [managerAccountId])
    if (!result.rows[0]) throw new Error(`Manager account ${managerAccountId} does not exist`)
    return result.rows[0]
  }
  if (fplEntryId === undefined) {
    const result = await db.query('SELECT * FROM "ManagerAccount" ORDER BY "updated_at" DESC LIMIT 1')
    if (!result.rows[0]) throw new Error('No manager account exists')
    return result.rows[0]
  }
  const entryId = integer(fplEntryId, 'teamId', { minimum: 1 })
  const result = await db.query('SELECT * FROM "ManagerAccount" WHERE "fpl_entry_id"=$1', [entryId])
  if (!result.rows[0]) throw new Error(`Manager account ${entryId} does not exist`)
  return result.rows[0]
}

async function snapshotRow(db, { snapshotId, managerAccountId } = {}) {
  const result = snapshotId
    ? await db.query('SELECT * FROM "OfficialSquadSnapshot" WHERE "id"=$1 AND "manager_account_id"=$2', [snapshotId, managerAccountId])
    : await db.query(
      `SELECT * FROM "OfficialSquadSnapshot"
       WHERE "manager_account_id"=$1
       ORDER BY "imported_at" DESC, "id" DESC
       LIMIT 1`,
      [managerAccountId],
    )
  if (!result.rows[0]) throw new Error('An official squad snapshot is required before creating a plan')
  return result.rows[0]
}

async function officialPlanPlayers(db, snapshotId) {
  const result = await db.query(
    `SELECT * FROM "OfficialSquadPlayer"
     WHERE "squad_snapshot_id"=$1
     ORDER BY "squad_order" ASC`,
    [snapshotId],
  )
  return result.rows.map(row => ({
    playerId: row.player_id,
    squadSlot: Number(row.squad_order),
    plannedPurchasePriceTenths: row.purchase_price_tenths === null ? null : Number(row.purchase_price_tenths),
    inheritedSellingPriceTenths: row.selling_price_tenths === null ? null : Number(row.selling_price_tenths),
    isCaptain: Boolean(row.is_captain),
    isViceCaptain: Boolean(row.is_vice_captain),
    benchOrder: Number(row.squad_order) > 11 ? Number(row.squad_order) - 11 : null,
    locked: false,
  }))
}

async function parentPlan(db, parentPlanId, managerAccountId) {
  if (!parentPlanId) return null
  const result = await db.query('SELECT * FROM "Plan" WHERE "id"=$1 AND "manager_account_id"=$2', [parentPlanId, managerAccountId])
  if (!result.rows[0]) throw new Error(`Parent plan ${parentPlanId} does not exist for this manager`)
  return result.rows[0]
}

async function planPlayers(db, planId) {
  const result = await db.query(
    `SELECT plan_player.*, player."fpl_id", player."web_name"
     FROM "PlanPlayer" plan_player
     JOIN "Player" player ON player."id"=plan_player."player_id"
     WHERE plan_player."plan_id"=$1
     ORDER BY plan_player."squad_slot" ASC`,
    [planId],
  )
  return result.rows.map(row => ({
    playerId: row.player_id,
    fplId: Number(row.fpl_id),
    webName: row.web_name,
    squadSlot: Number(row.squad_slot),
    plannedPurchasePriceTenths: row.planned_purchase_price_tenths === null ? null : Number(row.planned_purchase_price_tenths),
    inheritedSellingPriceTenths: row.inherited_selling_price_tenths === null ? null : Number(row.inherited_selling_price_tenths),
    isCaptain: Boolean(row.is_captain),
    isViceCaptain: Boolean(row.is_vice_captain),
    benchOrder: row.bench_order === null ? null : Number(row.bench_order),
    locked: Boolean(row.locked),
  }))
}

async function currentFreeTransfers(db, managerAccountId, gameweekId) {
  const result = await db.query(
    `SELECT "value_json" FROM "ManagerAssumption"
     WHERE "manager_account_id"=$1 AND "gameweek_id"=$2 AND "kind"='FREE_TRANSFERS'
     ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
    [managerAccountId, gameweekId],
  )
  if (!result.rows[0]) return 0
  const value = parseJson(result.rows[0].value_json)
  return integer(value.freeTransfers, 'freeTransfers', { minimum: 0 })
}

async function currentMarketPrice(db, playerId, observedAt) {
  const result = await db.query(
    `SELECT "price_tenths" FROM "PlayerObservation"
     WHERE "player_id"=$1 AND "observed_at" <= $2
     ORDER BY "observed_at" DESC, "id" DESC LIMIT 1`,
    [playerId, observedAt],
  )
  return result.rows[0]?.price_tenths === undefined ? null : Number(result.rows[0].price_tenths)
}

async function resolvePlayerIds(db, season, playerIds, createdAt) {
  const resolved = []
  for (const rawId of playerIds) {
    const result = await db.query(
      `SELECT "id", "fpl_id" FROM "Player"
       WHERE "season"=$1 AND ("id"=$2 OR "fpl_id"=$3)
       LIMIT 1`,
      [season, String(rawId), Number(rawId)],
    )
    if (!result.rows[0]) throw new Error(`Player ${rawId} is not present in season ${season}`)
    resolved.push({ id: result.rows[0].id, fplId: Number(result.rows[0].fpl_id), priceTenths: await currentMarketPrice(db, result.rows[0].id, createdAt) })
  }
  if (new Set(resolved.map(player => player.id)).size !== resolved.length) throw new Error('A plan cannot contain duplicate players')
  return resolved
}

function applyPlayerIds(basePlayers, resolvedPlayers) {
  const previous = new Map(basePlayers.map(player => [player.playerId, player]))
  return resolvedPlayers.map((player, index) => {
    const inherited = previous.get(player.id)
    return inherited || {
      playerId: player.id,
      squadSlot: index + 1,
      plannedPurchasePriceTenths: player.priceTenths,
      inheritedSellingPriceTenths: null,
      isCaptain: false,
      isViceCaptain: false,
      benchOrder: index > 10 ? index - 10 : null,
      locked: false,
    }
  }).map((player, index) => ({ ...player, squadSlot: index + 1 }))
}

export async function getPlan(db, planId) {
  const result = await db.query('SELECT * FROM "Plan" WHERE "id"=$1', [planId])
  if (!result.rows[0]) return null
  const row = result.rows[0]
  return {
    id: row.id,
    managerAccountId: row.manager_account_id,
    officialSquadSnapshotId: row.official_squad_snapshot_id,
    parentPlanId: row.parent_plan_id,
    name: row.name,
    status: row.status,
    bankTenths: row.bank_tenths === null ? null : Number(row.bank_tenths),
    freeTransfers: Number(row.free_transfers),
    createdAt: row.created_at,
    changeSummary: parseJson(row.change_summary_json),
    players: await planPlayers(db, row.id),
  }
}

export async function getActivePlan(db, { managerAccountId, fplEntryId } = {}) {
  const manager = await resolveManager(db, { managerAccountId, fplEntryId }).catch(() => null)
  if (!manager) return null
  const result = await db.query(
    `SELECT "id" FROM "Plan"
     WHERE "manager_account_id"=$1 AND "status"='ACTIVE'
     ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
    [manager.id],
  )
  return result.rows[0] ? getPlan(db, result.rows[0].id) : null
}

export async function createPlan(db, {
  managerAccountId,
  fplEntryId,
  snapshotId,
  parentPlanId,
  name = 'Active plan',
  status = 'ACTIVE',
  playerIds,
  bankTenths,
  freeTransfers,
  changeSummary = {},
  createdAt = new Date().toISOString(),
} = {}) {
  if (!['ACTIVE', 'SAVED', 'ARCHIVED'].includes(status)) throw new Error(`Invalid plan status: ${status}`)
  const manager = await resolveManager(db, { managerAccountId, fplEntryId })
  const parent = await parentPlan(db, parentPlanId, manager.id)
  const snapshot = await snapshotRow(db, {
    snapshotId: snapshotId || parent?.official_squad_snapshot_id,
    managerAccountId: manager.id,
  })
  const basePlayers = parent ? await planPlayers(db, parent.id) : await officialPlanPlayers(db, snapshot.id)
  const selectedPlayers = playerIds === undefined
    ? basePlayers
    : applyPlayerIds(basePlayers, await resolvePlayerIds(db, snapshot.season || (await db.query('SELECT "season" FROM "Gameweek" WHERE "id"=$1', [snapshot.gameweek_id])).rows[0]?.season, playerIds, createdAt))
  if (!selectedPlayers.length) throw new Error('A plan must contain at least one player')
  const planBank = bankTenths === undefined
    ? (parent ? parent.bank_tenths : snapshot.bank_tenths)
    : integer(bankTenths, 'bankTenths', { minimum: 0 })
  const planFreeTransfers = freeTransfers === undefined
    ? (parent ? Number(parent.free_transfers) : await currentFreeTransfers(db, manager.id, snapshot.gameweek_id))
    : integer(freeTransfers, 'freeTransfers', { minimum: 0 })
  const planId = randomUUID()
  let transactionOpen = false
  try {
    db.sqlite.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    if (status === 'ACTIVE') await db.query('UPDATE "Plan" SET "status"=\'SAVED\' WHERE "manager_account_id"=$1 AND "status"=\'ACTIVE\'', [manager.id])
    await db.query(
      `INSERT INTO "Plan" (
        "id", "manager_account_id", "official_squad_snapshot_id", "parent_plan_id", "name", "status",
        "bank_tenths", "free_transfers", "created_at", "change_summary_json"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [planId, manager.id, snapshot.id, parent?.id || null, String(name).slice(0, 120), status, planBank, planFreeTransfers, createdAt, canonicalJson(changeSummary)],
    )
    for (const player of selectedPlayers) {
      await db.query(
        `INSERT INTO "PlanPlayer" (
          "plan_id", "player_id", "squad_slot", "planned_purchase_price_tenths", "inherited_selling_price_tenths",
          "is_captain", "is_vice_captain", "bench_order", "locked"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [planId, player.playerId, player.squadSlot, player.plannedPurchasePriceTenths, player.inheritedSellingPriceTenths, player.isCaptain, player.isViceCaptain, player.benchOrder, player.locked],
      )
    }
    db.sqlite.exec('COMMIT')
    transactionOpen = false
    return getPlan(db, planId)
  } catch (error) {
    if (transactionOpen) {
      try { db.sqlite.exec('ROLLBACK') } catch {}
    }
    throw error
  }
}

export async function ensureInitialPlanForSnapshot(db, { managerAccountId, snapshotId, createdAt } = {}) {
  const existing = await getActivePlan(db, { managerAccountId })
  if (existing) return existing
  return createPlan(db, { managerAccountId, snapshotId, name: 'Active plan', status: 'ACTIVE', createdAt })
}

export async function selectPlan(db, planId) {
  const plan = await getPlan(db, planId)
  if (!plan) throw new Error(`Plan ${planId} does not exist`)
  let transactionOpen = false
  try {
    db.sqlite.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    await db.query('UPDATE "Plan" SET "status"=\'SAVED\' WHERE "manager_account_id"=$1 AND "status"=\'ACTIVE\'', [plan.managerAccountId])
    await db.query('UPDATE "Plan" SET "status"=\'ACTIVE\' WHERE "id"=$1', [planId])
    db.sqlite.exec('COMMIT')
    transactionOpen = false
    return getPlan(db, planId)
  } catch (error) {
    if (transactionOpen) {
      try { db.sqlite.exec('ROLLBACK') } catch {}
    }
    throw error
  }
}
