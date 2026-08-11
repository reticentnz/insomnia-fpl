function parseJson(value, fallback) {
  try { return value == null ? fallback : JSON.parse(value) } catch { return fallback }
}

function integer(value, label, { nullable = false, minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === '') {
    if (nullable) return null
    throw new Error(`${label} is required`)
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

async function ensureState(db) {
  await db.query(
    `INSERT INTO "AppUserState" ("id", "updated_at") VALUES ('default', $1)
     ON CONFLICT ("id") DO NOTHING`,
    [new Date().toISOString()],
  )
}

export async function getUserState(db) {
  await ensureState(db)
  const result = await db.query('SELECT * FROM "AppUserState" WHERE "id"=\'default\'')
  const row = result.rows[0]
  return {
    activeManagerAccountId: row.active_manager_account_id || null,
    preferences: {
      userName: row.user_name || '',
      bank: row.exploratory_bank_tenths === null ? null : Number(row.exploratory_bank_tenths) / 10,
      freeTransfers: row.exploratory_free_transfers === null ? null : Number(row.exploratory_free_transfers),
      defaultLeagueId: row.default_league_id === null ? null : Number(row.default_league_id),
      onboardingCompleted: Boolean(row.onboarding_completed),
      challengeResult: parseJson(row.challenge_result_json, null),
      stagedReviews: parseJson(row.staged_reviews_json, {}),
      draftSeason: row.draft_season || null,
      draftPlayerIds: parseJson(row.draft_player_ids_json, []),
      draftLockedPlayerIds: parseJson(row.draft_locked_player_ids_json, []),
      draftRevision: row.draft_revision || '',
      draftUpdatedAt: row.draft_updated_at || null,
      seasonModeManagerAccountId: row.season_mode_manager_account_id || null,
      seasonModeSeason: row.season_mode_season || null,
    },
    // Credentials are deliberately never persisted in SQLite. The provider is
    // configuration metadata only; the optional key lives in the protected
    // local settings file or the environment.
    ai: { provider: row.ai_provider || '' },
  }
}

export async function setActiveManager(db, managerAccountId, updatedAt = new Date().toISOString()) {
  await ensureState(db)
  if (managerAccountId !== null) {
    const manager = await db.query('SELECT 1 FROM "ManagerAccount" WHERE "id"=$1', [managerAccountId])
    if (!manager.rows[0]) throw new Error(`Manager account ${managerAccountId} does not exist`)
  }
  await db.query(
    `UPDATE "AppUserState"
     SET "active_manager_account_id"=$1, "updated_at"=$2
     WHERE "id"='default'`,
    [managerAccountId, updatedAt],
  )
}

export async function updateUserState(db, update, updatedAt = new Date().toISOString()) {
  await ensureState(db)
  const sets = []
  const params = []
  const add = (column, value) => { sets.push(`"${column}"=$${params.length + 1}`); params.push(value) }
  if (typeof update.userName === 'string') add('user_name', update.userName.slice(0, 120))
  if (Object.prototype.hasOwnProperty.call(update, 'bank')) {
    const bank = update.bank === null ? null : Math.round(Number(update.bank) * 10)
    add('exploratory_bank_tenths', integer(bank, 'bank', { nullable: true }))
  }
  if (Object.prototype.hasOwnProperty.call(update, 'freeTransfers')) {
    add('exploratory_free_transfers', integer(update.freeTransfers, 'freeTransfers', { nullable: true, maximum: 5 }))
  }
  if (Object.prototype.hasOwnProperty.call(update, 'defaultLeagueId')) {
    add('default_league_id', integer(update.defaultLeagueId, 'defaultLeagueId', { nullable: true, minimum: 1 }))
  }
  if (Object.prototype.hasOwnProperty.call(update, 'onboardingCompleted')) add('onboarding_completed', update.onboardingCompleted ? 1 : 0)
  if (Object.prototype.hasOwnProperty.call(update, 'challengeResult')) add('challenge_result_json', update.challengeResult == null ? null : JSON.stringify(update.challengeResult))
  if (Object.prototype.hasOwnProperty.call(update, 'stagedReviews')) add('staged_reviews_json', JSON.stringify(update.stagedReviews || {}))
  const isUpdatingDraft = Object.prototype.hasOwnProperty.call(update, 'draftPlayerIds') ||
    Object.prototype.hasOwnProperty.call(update, 'draftLockedPlayerIds') ||
    Object.prototype.hasOwnProperty.call(update, 'draftSeason')

  const currentState = isUpdatingDraft ? await getUserState(db) : null

  if (Object.prototype.hasOwnProperty.call(update, 'draftSeason')) {
    if (update.draftSeason && !/^\d{4}\/\d{2}$/.test(String(update.draftSeason))) {
      throw new Error('draftSeason must be formatted as YYYY/YY')
    }
    add('draft_season', update.draftSeason ? String(update.draftSeason) : null)
  }

  let effectivePlayerIds = currentState?.preferences.draftPlayerIds || []
  if (Object.prototype.hasOwnProperty.call(update, 'draftPlayerIds')) {
    if (Array.isArray(update.draftPlayerIds) && update.draftPlayerIds.length > 0) {
      if (update.draftPlayerIds.length !== 15) {
        throw new Error('draftPlayerIds must contain exactly 15 unique integer player IDs')
      }
      const ids = update.draftPlayerIds.map(id => integer(id, 'draftPlayerId', { minimum: 1 }))
      const unique = new Set(ids)
      if (unique.size !== 15) {
        throw new Error('draftPlayerIds must contain exactly 15 unique integer player IDs')
      }
      effectivePlayerIds = ids
      add('draft_player_ids_json', JSON.stringify(ids))
      const serverFingerprint = [...ids].sort((a, b) => a - b).join(',')
      add('draft_revision', serverFingerprint)
    } else {
      effectivePlayerIds = []
      add('draft_player_ids_json', '[]')
      add('draft_locked_player_ids_json', '[]')
      add('draft_revision', '')
    }
  }

  if (effectivePlayerIds.length === 0) {
    add('draft_locked_player_ids_json', '[]')
  } else if (Object.prototype.hasOwnProperty.call(update, 'draftLockedPlayerIds')) {
    const lockIds = Array.isArray(update.draftLockedPlayerIds)
      ? update.draftLockedPlayerIds.map(id => integer(id, 'draftLockedPlayerId', { minimum: 1 }))
      : []
    const uniqueLocks = new Set(lockIds)
    if (uniqueLocks.size !== lockIds.length) throw new Error('draftLockedPlayerIds must be unique')
    add('draft_locked_player_ids_json', JSON.stringify(lockIds))
    if (effectivePlayerIds.length > 0) {
      const draftSet = new Set(effectivePlayerIds)
      for (const lockId of lockIds) {
        if (!draftSet.has(lockId)) throw new Error(`Locked player ${lockId} is not present in draft player IDs`)
      }
    }
  } else if (currentState?.preferences.draftLockedPlayerIds?.length && Object.prototype.hasOwnProperty.call(update, 'draftPlayerIds')) {
    if (effectivePlayerIds.length > 0) {
      const draftSet = new Set(effectivePlayerIds)
      for (const lockId of currentState.preferences.draftLockedPlayerIds) {
        if (!draftSet.has(lockId)) throw new Error(`Existing locked player ${lockId} is not present in updated draft player IDs`)
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(update, 'draftUpdatedAt')) add('draft_updated_at', update.draftUpdatedAt ? String(update.draftUpdatedAt) : null)
  if (Object.prototype.hasOwnProperty.call(update, 'seasonModeManagerAccountId')) add('season_mode_manager_account_id', update.seasonModeManagerAccountId ? String(update.seasonModeManagerAccountId) : null)
  if (Object.prototype.hasOwnProperty.call(update, 'seasonModeSeason')) add('season_mode_season', update.seasonModeSeason ? String(update.seasonModeSeason) : null)
  if (!sets.length) return getUserState(db)
  add('updated_at', updatedAt)
  await db.query(`UPDATE "AppUserState" SET ${sets.join(', ')} WHERE "id"='default'`, params)
  return getUserState(db)
}

export async function updateAiState(db, { provider = '' }, updatedAt = new Date().toISOString()) {
  await ensureState(db)
  await db.query(
    `UPDATE "AppUserState" SET "ai_provider"=$1, "updated_at"=$2 WHERE "id"='default'`,
    [String(provider), updatedAt],
  )
  return getUserState(db)
}
