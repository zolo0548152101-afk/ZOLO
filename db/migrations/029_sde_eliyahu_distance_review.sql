-- שדה אליהו is in the service area (with טירת צבי and the Beit She'an valley).
INSERT INTO service_locations(name, aliases, decision, is_city) VALUES
  ('שדה אליהו', ARRAY['שדה אליהו', 'קיבוץ שדה אליהו'], 'allowed', false)
ON CONFLICT (name) DO UPDATE
  SET aliases = EXCLUDED.aliases,
      decision = 'allowed',
      is_city = EXCLUDED.is_city,
      updated_at = clock_timestamp();

-- Remove the review row whose alias stole «טירת צבי».
DELETE FROM service_locations WHERE name = 'טירת צבי — בירור';

UPDATE service_locations
   SET aliases = ARRAY['טירת צבי', 'קיבוץ טירת צבי'],
       decision = 'allowed',
       updated_at = clock_timestamp()
 WHERE name = 'טירת צבי';

-- Mark distance-check / parked team notes without stopping the request.
ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS needs_distance_check boolean NOT NULL DEFAULT false;
ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS team_notes text;
