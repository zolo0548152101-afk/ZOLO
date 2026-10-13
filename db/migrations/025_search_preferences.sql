-- Up Migration
ALTER TABLE searches
  ADD COLUMN IF NOT EXISTS settlement text REFERENCES service_locations(name),
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS floor smallint,
  ADD COLUMN IF NOT EXISTS name text;

-- Down Migration
ALTER TABLE searches
  DROP COLUMN IF EXISTS name,
  DROP COLUMN IF EXISTS floor,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS settlement;
