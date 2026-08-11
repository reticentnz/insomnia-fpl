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
