import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateDatabase } from './db-migrate.mjs'
import { assertSafeResetPath } from './db-reset.mjs'

const temporaryDirectories: string[] = []

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-wp01-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'database.sqlite')
}

afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
})

describe('canonical database migrations', () => {
  it('applies the initial migration and makes the second run a no-op', async () => {
    const databasePath = temporaryDatabase()
    const first = await migrateDatabase(databasePath)
    const second = await migrateDatabase(databasePath)

    const migrations = ['001_initial_rebuild', '002_app_state_and_manager_totals', '003_remove_app_user_api_key', '004_recommendation_cache_index', '005_draft_and_season_mode', '006_signal_interpretations', '007_reclassify_creator_bench_context', '008_league_differential', '009_signal_source_date', '010_market_clean_sheet_probabilities', '011_signal_aliases_and_creator_claims', '012_creator_feed_ingestion', '013_ai_usage_ledger', '014_rss_feed_ingestion', '015_rss_feed_cache_validators', '016_add_rss_usage_feature', '016_rss_source_rate_limit_backoff', '017_creator_feed_cache_validators', '018_rss_article_enrichment', '019_creator_forecast_outcomes', '020_recommendation_safety_and_baselines', '021_roll_transfer_option_value', '022_auto_approve_pending_signals', '023_deduplicate_decision_records', '024_deduplicate_decisions_by_gameweek']
    expect(first.applied).toEqual(migrations)
    expect(second).toEqual({ applied: [], skipped: migrations })

    const db = new DatabaseSync(databasePath)
    const tables = db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE type = ?').get('table')
    expect(Number(tables.count)).toBe(39)
    db.close()
  })

  it('rejects a changed checksum for an already applied migration', async () => {
    const databasePath = temporaryDatabase()
    const db = new DatabaseSync(databasePath)
    db.exec('CREATE TABLE "SchemaMigration" ("version" TEXT PRIMARY KEY, "checksum" TEXT NOT NULL, "applied_at" TEXT NOT NULL)')
    db.prepare('INSERT INTO "SchemaMigration" ("version", "checksum", "applied_at") VALUES (?, ?, ?)').run('001_initial_rebuild', 'changed', new Date().toISOString())
    db.close()

    await expect(migrateDatabase(databasePath)).rejects.toThrow(/Migration 001_initial_rebuild checksum mismatch/)
  })

  it('enforces foreign keys for canonical child rows', async () => {
    const databasePath = temporaryDatabase()
    await migrateDatabase(databasePath)
    const db = new DatabaseSync(databasePath)
    db.exec('PRAGMA foreign_keys = ON')

    expect(() => db.prepare('INSERT INTO "OfficialSquadPlayer" ("squad_snapshot_id", "player_id", "position", "squad_order", "economics_source") VALUES (?, ?, ?, ?, ?)').run('missing-snapshot', 'missing-player', 'MID', 0, 'UNKNOWN')).toThrow()
    db.close()
  })

  it('refuses reset targets that are not recognisable SQLite database paths', () => {
    expect(() => assertSafeResetPath(path.resolve('package.json'), 'file:./package.json')).toThrow(/must use a .* extension/)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'insomnia-fpl-reset-'))
    temporaryDirectories.push(directory)
    const fake = path.join(directory, 'not-a-database.sqlite')
    fs.writeFileSync(fake, 'not sqlite')
    process.env.APP_DATA_DIR = directory
    try {
      expect(() => assertSafeResetPath(fake, `file:${fake}`)).toThrow(/not a SQLite database/)
    } finally {
      delete process.env.APP_DATA_DIR
    }
  })
})
