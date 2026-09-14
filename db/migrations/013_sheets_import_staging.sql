-- Up Migration
-- Staging only: no business table is modified by loading a Sheets export.
CREATE TABLE sheets_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_label text NOT NULL,
  source_hash text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('dry_run','apply')),
  state text NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','validated','applied','failed')),
  row_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX sheets_import_batches_source_idx
  ON sheets_import_batches(source_label,source_hash);
CREATE TABLE sheets_import_rows (
  batch_id uuid NOT NULL REFERENCES sheets_import_batches(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  row_hash text NOT NULL,
  source jsonb NOT NULL,
  validation_state text NOT NULL DEFAULT 'pending' CHECK(validation_state IN ('pending','valid','invalid','duplicate')),
  error text,
  PRIMARY KEY(batch_id,row_number)
);
CREATE INDEX sheets_import_rows_hash_idx ON sheets_import_rows(row_hash);

-- Down Migration
DROP TABLE sheets_import_rows;
DROP INDEX sheets_import_batches_source_idx;
DROP TABLE sheets_import_batches;
