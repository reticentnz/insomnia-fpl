ALTER TABLE "AppUserState"
  ADD COLUMN "draft_season" TEXT;

ALTER TABLE "AppUserState"
  ADD COLUMN "draft_player_ids_json" TEXT;

ALTER TABLE "AppUserState"
  ADD COLUMN "draft_locked_player_ids_json" TEXT;

ALTER TABLE "AppUserState"
  ADD COLUMN "draft_revision" TEXT;

ALTER TABLE "AppUserState"
  ADD COLUMN "draft_updated_at" TEXT;

ALTER TABLE "AppUserState"
  ADD COLUMN "season_mode_manager_account_id" TEXT;

ALTER TABLE "AppUserState"
  ADD COLUMN "season_mode_season" TEXT;
