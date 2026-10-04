-- Up Migration
-- Keep the immutable source identity while preserving whether an apply followed a dry-run.
ALTER TABLE sheets_import_batches
  ADD COLUMN IF NOT EXISTS initial_mode text;
UPDATE sheets_import_batches SET initial_mode = mode WHERE initial_mode IS NULL;
ALTER TABLE sheets_import_batches
  ALTER COLUMN initial_mode SET DEFAULT 'dry_run';
ALTER TABLE sheets_import_batches
  ALTER COLUMN initial_mode SET NOT NULL;
ALTER TABLE sheets_import_batches
  ADD COLUMN IF NOT EXISTS applied_from_dry_run boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE sheets_import_batches DROP COLUMN IF EXISTS applied_from_dry_run;
ALTER TABLE sheets_import_batches DROP COLUMN IF EXISTS initial_mode;
