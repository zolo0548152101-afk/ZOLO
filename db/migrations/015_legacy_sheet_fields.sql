-- Up Migration
-- Preserve legacy Sheets values until the reviewed importer can normalize them.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS preferred_time text;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS represents_both_parties boolean NOT NULL DEFAULT false;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS closed_at timestamptz;

-- Down Migration
ALTER TABLE requests DROP COLUMN IF EXISTS closed_at;
ALTER TABLE requests DROP COLUMN IF EXISTS represents_both_parties;
ALTER TABLE requests DROP COLUMN IF EXISTS preferred_time;
