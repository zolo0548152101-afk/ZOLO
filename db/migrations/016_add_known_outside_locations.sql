-- Up Migration
-- Keep the existing migration checksums immutable; add newly verified outside
-- endpoints in a forward-only migration.
INSERT INTO service_locations(name,aliases,decision,is_city) VALUES
 ('אילת',ARRAY['אילת'],'outside',true)
ON CONFLICT(name) DO UPDATE SET aliases=EXCLUDED.aliases,decision=EXCLUDED.decision,is_city=EXCLUDED.is_city,updated_at=clock_timestamp();

-- Down Migration
DELETE FROM service_locations WHERE name='אילת';
