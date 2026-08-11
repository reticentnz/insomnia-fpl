import { randomUUID } from 'node:crypto'
import { migrateDatabase } from './db-migrate.mjs'
import { closeDb, getDb } from './db.mjs'
import { canonicalJson } from './feed-run.mjs'
import { ensureInitialPlanForSnapshot, getActivePlan } from './plan-service.mjs'

function integer(value, label, { nullable = false, minimum = 0 } = {}) {
  if (value === null || value === undefined || value === '') {
    if (nullable) return null
    throw new Error(`${label} is required`)
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${label} must be an integer >= ${minimum}`)
  return parsed
}

function seasonFromConfiguration(season) {
  if (season || process.env.FPL_SEASON) return String(season || process.env.FPL_SEASON)
  const startYear = Number(process.env.FPL_SEASON_START_YEAR)
  if (Number.isInteger(startYear)) return `${startYear}/${String(startYear + 1).slice(-2)}`
  throw new Error('FPL season is required; set FPL_SEASON or FPL_SEASON_START_YEAR')
}

function managerId(fplEntryId) {
  return `manager:${fplEntryId}`
}

function mapAccount(row) {
  return {
    id: row.id,
    teamId: Number(row.fpl_entry_id),
    teamName: row.team_name,
    managerName: row.manager_name,
    totalPoints: Number(row.total_points),
    gameweekPoints: Number(row.gameweek_points),
    squadValue: Number(row.squad_value_tenths || 0) / 10,
    bank: Number(row.bank_tenths || 0) / 10,
    bankTenths: Number(row.bank_tenths || 0),
    overallRank: row.overall_rank === null ? null : Number(row.overall_rank),
    transfersCost: Number(row.event_transfer_cost || 0),
    eventTransfers: Number(row.event_transfers || 0),
    totalTransfers: Number(row.total_transfers || 0),
    currentGameweek: row.current_gameweek === null ? null : Number(row.current_gameweek),
    lastSynced: row.last_imported_at || row.updated_at,
  }
}

function parseJson(value) {
  try { return JSON.parse(value || '{}') } catch { return {} }
}

async function officialJson(endpoint) {
  const response = await fetch(`https://fantasy.premierleague.com/api/${endpoint}`, {
    headers: { 'User-Agent': 'Insomnia-FPL/1.0' },
  })
  if (!response.ok) throw new Error(`FPL manager source ${endpoint} returned HTTP ${response.status}`)
  return response.json()
}

export async function fetchManagerPayload({ teamId, gameweek, fetchJson = officialJson } = {}) {
  const entryId = integer(teamId, 'teamId', { minimum: 1 })
  const entry = await fetchJson(`entry/${entryId}/`)
  const selectedGameweek = integer(gameweek ?? entry.current_event ?? entry.summary_overall_event, 'gameweek', { minimum: 1 })
  const picks = await fetchJson(`entry/${entryId}/event/${selectedGameweek}/picks/`)
  return { entry, picks, gameweek: selectedGameweek }
}

async function playerForPick(db, season, pick, importedAt) {
  const fplId = integer(pick.element, 'pick.element', { minimum: 1 })
  const result = await db.query(
    `SELECT p."id", p."fpl_id", po."position"
     FROM "Player" p
     JOIN "PlayerObservation" po ON po."player_id"=p."id"
     WHERE p."season"=$1 AND p."fpl_id"=$2 AND po."observed_at" <= $3
       AND po."observed_at"=(
         SELECT MAX(candidate."observed_at") FROM "PlayerObservation" candidate
         WHERE candidate."player_id"=p."id" AND candidate."observed_at" <= $3
       )
     ORDER BY po."id" DESC
     LIMIT 1`,
    [season, fplId, importedAt],
  )
  if (!result.rows[0]) throw new Error(`Player ${fplId} is not present in the imported official catalogue for ${season}`)
  return result.rows[0]
}

function pickPrice(pick, key) {
  return integer(pick[key], `pick.${key}`, { nullable: true, minimum: 0 })
}

function pickEconomics(pick) {
  const purchasePriceTenths = pickPrice(pick, 'purchase_price')
  const sellingPriceTenths = pickPrice(pick, 'selling_price')
  return {
    purchasePriceTenths,
    sellingPriceTenths,
    economicsSource: purchasePriceTenths !== null && sellingPriceTenths !== null ? 'OFFICIAL' : 'UNKNOWN',
  }
}

export async function importManagerPayload(db, {
  entry,
  picks,
  gameweek,
  season,
  importedAt = new Date().toISOString(),
} = {}) {
  const resolvedSeason = seasonFromConfiguration(season)
  const fplEntryId = integer(entry?.id, 'entry.id', { minimum: 1 })
  const gameweekFplId = integer(gameweek, 'gameweek', { minimum: 1 })
  if (!Array.isArray(picks?.picks) || picks.picks.length === 0) throw new Error('Official picks payload contains no squad')

  const gameweekResult = await db.query(
    'SELECT "id" FROM "Gameweek" WHERE "season"=$1 AND "fpl_id"=$2',
    [resolvedSeason, gameweekFplId],
  )
  if (!gameweekResult.rows[0]) throw new Error(`Gameweek ${gameweekFplId} is not present for ${resolvedSeason}`)
  const gameweekId = gameweekResult.rows[0].id
  const importedPlayers = []
  for (const pick of picks.picks) {
    const player = await playerForPick(db, resolvedSeason, pick, importedAt)
    importedPlayers.push({ pick, player, economics: pickEconomics(pick) })
  }

  const managerAccountId = managerId(fplEntryId)
  const entryHistory = picks.entry_history || {}
  const teamName = String(entry.name || `Team #${fplEntryId}`)
  const managerName = `${entry.player_first_name || ''} ${entry.player_last_name || ''}`.trim()
  const bankTenths = integer(entryHistory.bank ?? entry.last_deadline_bank ?? 0, 'bank_tenths', { minimum: 0 })
  const squadValueTenths = integer(entryHistory.value ?? entry.last_deadline_value ?? 0, 'squad_value_tenths', { minimum: 0 })
  const eventTransfers = integer(entryHistory.event_transfers ?? 0, 'event_transfers', { minimum: 0 })
  const eventTransferCost = integer(entryHistory.event_transfers_cost ?? 0, 'event_transfer_cost', { minimum: 0 })
  const totalTransfers = integer(entry.last_deadline_total_transfers ?? 0, 'total_transfers', { minimum: 0 })
  const activeChip = picks.active_chip ?? entryHistory.active_chip ?? entry.active_chip ?? null
  const captain = importedPlayers.find(item => item.pick.is_captain === true || item.pick.is_captain === 1)?.player.id || null
  const viceCaptain = importedPlayers.find(item => item.pick.is_vice_captain === true || item.pick.is_vice_captain === 1)?.player.id || null
  const now = importedAt
  let transactionOpen = false
  try {
    db.sqlite.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    await db.query(
      `INSERT INTO "ManagerAccount" (
        "id", "fpl_entry_id", "team_name", "manager_name", "total_points", "gameweek_points",
        "overall_rank", "current_gameweek", "last_imported_at", "created_at", "updated_at"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT ("fpl_entry_id") DO UPDATE SET
        "team_name"=EXCLUDED."team_name", "manager_name"=EXCLUDED."manager_name",
        "total_points"=EXCLUDED."total_points", "gameweek_points"=EXCLUDED."gameweek_points",
        "overall_rank"=EXCLUDED."overall_rank", "current_gameweek"=EXCLUDED."current_gameweek",
        "last_imported_at"=EXCLUDED."last_imported_at", "updated_at"=EXCLUDED."updated_at"`,
      [
        managerAccountId, fplEntryId, teamName, managerName,
        integer(entryHistory.total_points ?? entry.summary_overall_points ?? 0, 'total_points', { minimum: 0 }),
        integer(entryHistory.points ?? entry.summary_event_points ?? 0, 'gameweek_points', { minimum: 0 }),
        integer(entry.summary_overall_rank, 'overall_rank', { nullable: true, minimum: 0 }),
        gameweekFplId, importedAt, now, now,
      ],
    )

    const snapshotId = randomUUID()
    await db.query(
      `INSERT INTO "OfficialSquadSnapshot" (
        "id", "manager_account_id", "gameweek_id", "imported_at", "bank_tenths", "squad_value_tenths",
        "active_chip", "event_transfers", "event_transfer_cost", "captain_player_id", "vice_captain_player_id", "raw_payload_json"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        snapshotId, managerAccountId, gameweekId, importedAt, bankTenths, squadValueTenths,
        activeChip, eventTransfers, eventTransferCost, captain, viceCaptain,
        canonicalJson({ entry, picks }),
      ],
    )
    for (let index = 0; index < importedPlayers.length; index += 1) {
      const { pick, player, economics } = importedPlayers[index]
      await db.query(
        `INSERT INTO "OfficialSquadPlayer" (
          "squad_snapshot_id", "player_id", "position", "squad_order", "multiplier",
          "is_captain", "is_vice_captain", "purchase_price_tenths", "selling_price_tenths", "economics_source"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          snapshotId, player.id, player.position,
          integer(pick.position ?? index + 1, 'pick.position', { minimum: 0 }),
          integer(pick.multiplier ?? 1, 'pick.multiplier', { minimum: 0 }),
          Boolean(pick.is_captain), Boolean(pick.is_vice_captain),
          economics.purchasePriceTenths, economics.sellingPriceTenths, economics.economicsSource,
        ],
      )
    }
    db.sqlite.exec('COMMIT')
    transactionOpen = false
    await ensureInitialPlanForSnapshot(db, { managerAccountId, snapshotId, createdAt: importedAt })
    return getCurrentManager(db, { fplEntryId, season: resolvedSeason })
  } catch (error) {
    if (transactionOpen) {
      try { db.sqlite.exec('ROLLBACK') } catch {}
    }
    throw error
  }
}

async function managerAccountRow(db, { fplEntryId } = {}) {
  const result = fplEntryId === undefined
    ? await db.query('SELECT * FROM "ManagerAccount" ORDER BY "updated_at" DESC LIMIT 1')
    : await db.query('SELECT * FROM "ManagerAccount" WHERE "fpl_entry_id"=$1 LIMIT 1', [fplEntryId])
  return result.rows[0] || null
}

function assumptionValue(row) {
  return parseJson(row.value_json)
}

async function currentAssumptions(db, accountId, gameweekId) {
  const result = await db.query(
    `SELECT * FROM "ManagerAssumption"
     WHERE "manager_account_id"=$1 AND "gameweek_id"=$2
     ORDER BY "created_at" ASC, "id" ASC`,
    [accountId, gameweekId],
  )
  let freeTransfers = null
  const sellingOverrides = new Map()
  for (const row of result.rows) {
    const value = assumptionValue(row)
    if (row.kind === 'FREE_TRANSFERS') freeTransfers = Number(value.freeTransfers)
    if (row.kind === 'SELLING_PRICE') sellingOverrides.set(String(value.playerId), { ...value, assumptionId: row.id, source: row.source, createdAt: row.created_at })
  }
  return { rows: result.rows.map(row => ({ ...row, value: assumptionValue(row) })), freeTransfers, sellingOverrides }
}

export async function getCurrentManager(db, { fplEntryId, season } = {}) {
  const accountRow = await managerAccountRow(db, { fplEntryId: fplEntryId === undefined ? undefined : integer(fplEntryId, 'teamId', { minimum: 1 }) })
  if (!accountRow) return { account: null, snapshot: null, squad: [], assumptions: [], activePlan: null }
  const snapshotResult = await db.query(
    `SELECT snapshot.*, gameweek."season", gameweek."fpl_id" AS "gameweek_fpl_id", gameweek."name" AS "gameweek_name"
     FROM "OfficialSquadSnapshot" snapshot
     JOIN "Gameweek" gameweek ON gameweek."id"=snapshot."gameweek_id"
     WHERE snapshot."manager_account_id"=$1
     ORDER BY snapshot."imported_at" DESC, snapshot."id" DESC
     LIMIT 1`,
    [accountRow.id],
  )
  const snapshot = snapshotResult.rows[0]
  if (!snapshot) return { account: mapAccount(accountRow), snapshot: null, squad: [], assumptions: [], activePlan: null }
  if (season && snapshot.season !== season) throw new Error(`Latest manager snapshot is for ${snapshot.season}, not ${season}`)

  const assumptions = await currentAssumptions(db, accountRow.id, snapshot.gameweek_id)
  const squadResult = await db.query(
    `SELECT squad.*, player."fpl_id", player."first_name", player."second_name", player."web_name"
     FROM "OfficialSquadPlayer" squad
     JOIN "Player" player ON player."id"=squad."player_id"
     WHERE squad."squad_snapshot_id"=$1
     ORDER BY squad."squad_order" ASC`,
    [snapshot.id],
  )
  const squad = squadResult.rows.map(row => {
    const override = assumptions.sellingOverrides.get(String(row.player_id))
    const sellingPriceTenths = row.selling_price_tenths ?? (override ? integer(override.sellingPriceTenths, 'sellingPriceTenths', { minimum: 0 }) : null)
    return {
      id: row.player_id,
      fplId: Number(row.fpl_id),
      firstName: row.first_name,
      secondName: row.second_name,
      webName: row.web_name,
      position: row.position,
      squadOrder: Number(row.squad_order),
      multiplier: Number(row.multiplier),
      isCaptain: Boolean(row.is_captain),
      isViceCaptain: Boolean(row.is_vice_captain),
      purchasePriceTenths: row.purchase_price_tenths === null ? null : Number(row.purchase_price_tenths),
      sellingPriceTenths,
      officialSellingPriceTenths: row.selling_price_tenths === null ? null : Number(row.selling_price_tenths),
      economicsSource: row.selling_price_tenths !== null ? row.economics_source : override ? 'USER_CONFIRMED' : 'UNKNOWN',
    }
  })
  const economicsUnknown = squad.some(player => player.sellingPriceTenths === null)
  return {
    account: {
      ...mapAccount(accountRow),
      squadValue: Number(snapshot.squad_value_tenths) / 10,
      bank: Number(snapshot.bank_tenths) / 10,
      bankTenths: Number(snapshot.bank_tenths),
      currentGameweek: Number(snapshot.gameweek_fpl_id),
      transfersCost: Number(snapshot.event_transfer_cost),
      eventTransfers: Number(snapshot.event_transfers),
    },
    snapshot: {
      id: snapshot.id,
      season: snapshot.season,
      gameweek: Number(snapshot.gameweek_fpl_id),
      gameweekName: snapshot.gameweek_name,
      importedAt: snapshot.imported_at,
      bankTenths: Number(snapshot.bank_tenths),
      squadValueTenths: Number(snapshot.squad_value_tenths),
      activeChip: snapshot.active_chip,
      eventTransfers: Number(snapshot.event_transfers),
      eventTransferCost: Number(snapshot.event_transfer_cost),
    },
    squad,
    assumptions: assumptions.rows,
    freeTransfers: assumptions.freeTransfers,
    freeTransfersSource: assumptions.freeTransfers === null ? 'UNKNOWN' : 'USER_CONFIRMED',
    economics: {
      status: economicsUnknown ? 'AFFORDABILITY_UNKNOWN' : 'EXACT',
      exactSellingPrices: !economicsUnknown,
    },
    activePlan: await getActivePlan(db, { managerAccountId: accountRow.id }),
  }
}

async function latestAssumptionForPlayer(db, accountId, gameweekId, playerId) {
  const result = await db.query(
    `SELECT * FROM "ManagerAssumption"
     WHERE "manager_account_id"=$1 AND "gameweek_id"=$2 AND "kind"='SELLING_PRICE'
     ORDER BY "created_at" DESC, "id" DESC`,
    [accountId, gameweekId],
  )
  return result.rows.find(row => String(assumptionValue(row).playerId) === String(playerId)) || null
}

export async function updateManagerAssumptions(db, {
  fplEntryId,
  season,
  gameweek,
  freeTransfers,
  sellingPrices,
  createdAt = new Date().toISOString(),
} = {}) {
  const account = await managerAccountRow(db, { fplEntryId: integer(fplEntryId, 'teamId', { minimum: 1 }) })
  if (!account) throw new Error('Manager account must be imported before assumptions can be confirmed')
  const current = await getCurrentManager(db, { fplEntryId: account.fpl_entry_id })
  const gameweekFplId = integer(gameweek ?? current.snapshot?.gameweek, 'gameweek', { minimum: 1 })
  const resolvedSeason = seasonFromConfiguration(season || current.snapshot?.season)
  const gameweekResult = await db.query('SELECT "id" FROM "Gameweek" WHERE "season"=$1 AND "fpl_id"=$2', [resolvedSeason, gameweekFplId])
  if (!gameweekResult.rows[0]) throw new Error(`Gameweek ${gameweekFplId} is not present for ${resolvedSeason}`)
  const gameweekId = gameweekResult.rows[0].id
  const updates = []
  if (freeTransfers !== undefined) updates.push({ kind: 'FREE_TRANSFERS', value: { freeTransfers: integer(freeTransfers, 'freeTransfers', { minimum: 0 }) } })
  if (sellingPrices !== undefined) {
    if (!Array.isArray(sellingPrices)) throw new Error('sellingPrices must be an array')
    for (const item of sellingPrices) {
      const player = current.squad.find(candidate => String(candidate.id) === String(item.playerId) || Number(candidate.fplId) === Number(item.fplId))
      if (!player) throw new Error(`Cannot confirm a selling price for an unowned player: ${item.playerId ?? item.fplId}`)
      updates.push({
        kind: 'SELLING_PRICE',
        value: { playerId: player.id, sellingPriceTenths: integer(item.sellingPriceTenths ?? item.selling_price_tenths, 'sellingPriceTenths', { minimum: 0 }) },
        supersedes: await latestAssumptionForPlayer(db, account.id, gameweekId, player.id),
      })
    }
  }
  if (!updates.length) throw new Error('freeTransfers or sellingPrices is required')
  let transactionOpen = false
  try {
    db.sqlite.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    for (const update of updates) {
      const supersedes = update.supersedes || (await db.query(
        `SELECT "id" FROM "ManagerAssumption"
         WHERE "manager_account_id"=$1 AND "gameweek_id"=$2 AND "kind"=$3
         ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
        [account.id, gameweekId, update.kind],
      )).rows[0]
      await db.query(
        `INSERT INTO "ManagerAssumption" (
          "id", "manager_account_id", "gameweek_id", "kind", "value_json", "source", "created_at", "supersedes_id"
        ) VALUES ($1, $2, $3, $4, $5, 'USER_CONFIRMED', $6, $7)`,
        [randomUUID(), account.id, gameweekId, update.kind, canonicalJson(update.value), createdAt, supersedes?.id || null],
      )
    }
    db.sqlite.exec('COMMIT')
    transactionOpen = false
    return getCurrentManager(db, { fplEntryId: account.fpl_entry_id })
  } catch (error) {
    if (transactionOpen) {
      try { db.sqlite.exec('ROLLBACK') } catch {}
    }
    throw error
  }
}

export async function importManager({ dbPath, fetchJson = officialJson, teamId, gameweek, season, importedAt } = {}) {
  await migrateDatabase(dbPath)
  const db = getDb(dbPath)
  try {
    const payload = await fetchManagerPayload({ teamId, gameweek, fetchJson })
    return importManagerPayload(db, { ...payload, season, importedAt })
  } finally {
    await closeDb()
  }
}
