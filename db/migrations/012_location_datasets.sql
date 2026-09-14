-- Up Migration
-- A versioned street source keeps aliases auditable and makes activation a
-- single switch. The initial rows are only the explicitly approved local
-- aliases; future imports must add the complete municipal snapshot.
CREATE TABLE location_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL UNIQUE,
  source text NOT NULL,
  checksum text,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX location_datasets_one_active
  ON location_datasets(active) WHERE active;
CREATE TABLE streets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES location_datasets(id),
  name text NOT NULL,
  normalized text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  UNIQUE(dataset_id,normalized)
);
CREATE INDEX streets_lookup_idx ON streets(dataset_id,normalized);
INSERT INTO location_datasets(id,version,source,active)
VALUES('00000000-0000-0000-0000-000000000012','beit-shean-explicit-aliases-v1','manual-approved',true)
ON CONFLICT(version) DO NOTHING;
INSERT INTO streets(dataset_id,name,normalized,aliases) VALUES
 ('00000000-0000-0000-0000-000000000012','שיכון א','שיכון א',ARRAY['שיכון א','שיכון א׳']),
 ('00000000-0000-0000-0000-000000000012','רחוב העלייה','רחוב העלייה',ARRAY['העלייה','העליה','רחוב העליה'])
ON CONFLICT(dataset_id,normalized) DO NOTHING;

-- Down Migration
DROP TABLE streets;
DROP INDEX location_datasets_one_active;
DROP TABLE location_datasets;
