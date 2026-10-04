-- Up Migration
ALTER TABLE sheets_import_batches DROP CONSTRAINT sheets_import_batches_state_check;
ALTER TABLE sheets_import_batches ADD CONSTRAINT sheets_import_batches_state_check
  CHECK(state IN ('staged','validated','apply_ready','applied','failed','review_required','rolled_back'));
ALTER TABLE sheets_import_batches ADD COLUMN IF NOT EXISTS applied_at timestamptz;
ALTER TABLE sheets_import_batches ADD COLUMN IF NOT EXISTS rolled_back_at timestamptz;
ALTER TABLE sheets_import_batches ADD COLUMN IF NOT EXISTS rollback_error text;
ALTER TABLE sheets_import_rows ADD COLUMN IF NOT EXISTS exception_detail jsonb;
ALTER TABLE sheets_import_rows ADD COLUMN IF NOT EXISTS applied_at timestamptz;

CREATE TABLE sheets_import_field_reviews (
  batch_id uuid NOT NULL REFERENCES sheets_import_batches(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  field_name text NOT NULL,
  source_value text,
  target_value jsonb,
  transform_rule text NOT NULL,
  preserved_completely boolean NOT NULL,
  review_required boolean NOT NULL,
  reason text,
  PRIMARY KEY(batch_id,row_number,field_name)
);
CREATE TABLE sheets_import_lineage (
  batch_id uuid NOT NULL REFERENCES sheets_import_batches(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  row_hash text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  created_by_import boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(batch_id,row_number,entity_type,entity_id)
);
CREATE INDEX sheets_import_lineage_entity_idx ON sheets_import_lineage(entity_type,entity_id);

-- Down Migration
DROP TABLE sheets_import_lineage;
DROP TABLE sheets_import_field_reviews;
ALTER TABLE sheets_import_rows DROP COLUMN IF EXISTS applied_at;
ALTER TABLE sheets_import_rows DROP COLUMN IF EXISTS exception_detail;
ALTER TABLE sheets_import_batches DROP COLUMN IF EXISTS rollback_error;
ALTER TABLE sheets_import_batches DROP COLUMN IF EXISTS rolled_back_at;
ALTER TABLE sheets_import_batches DROP COLUMN IF EXISTS applied_at;
ALTER TABLE sheets_import_batches DROP CONSTRAINT sheets_import_batches_state_check;
ALTER TABLE sheets_import_batches ADD CONSTRAINT sheets_import_batches_state_check
  CHECK(state IN ('staged','validated','applied','failed'));
