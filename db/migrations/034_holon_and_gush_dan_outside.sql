-- Up Migration
-- Conv #3: «חולון» was auto-inserted as decision=review via ensureLocation,
-- which left needs_distance_check sticky after the customer corrected to בית שאן.
-- Seed clear Gush Dan / central cities as outside (same class as תל אביב).
INSERT INTO service_locations(name, aliases, decision, is_city) VALUES
  ('חולון', ARRAY['חולון'], 'outside', true),
  ('בת ים', ARRAY['בת ים'], 'outside', true),
  ('רמת גן', ARRAY['רמת גן'], 'outside', true),
  ('פתח תקווה', ARRAY['פתח תקווה', 'פתח תקוה'], 'outside', true),
  ('ראשון לציון', ARRAY['ראשון לציון'], 'outside', true),
  ('רחובות', ARRAY['רחובות'], 'outside', true),
  ('כפר סבא', ARRAY['כפר סבא'], 'outside', true),
  ('הרצליה', ARRAY['הרצליה'], 'outside', true),
  ('רעננה', ARRAY['רעננה'], 'outside', true),
  ('הוד השרון', ARRAY['הוד השרון'], 'outside', true),
  ('גבעתיים', ARRAY['גבעתיים'], 'outside', true),
  ('בני ברק', ARRAY['בני ברק'], 'outside', true),
  ('לוד', ARRAY['לוד'], 'outside', true),
  ('רמלה', ARRAY['רמלה'], 'outside', true),
  ('מודיעין', ARRAY['מודיעין', 'מודיעין מכבים רעות'], 'outside', true),
  ('אשדוד', ARRAY['אשדוד'], 'outside', true),
  ('אשקלון', ARRAY['אשקלון'], 'outside', true),
  ('נתניה', ARRAY['נתניה'], 'outside', true)
ON CONFLICT (name) DO UPDATE
  SET aliases = EXCLUDED.aliases,
      decision = 'outside',
      is_city = EXCLUDED.is_city,
      updated_at = clock_timestamp();

-- Down Migration
-- Keep rows; only revert Holon-style cities if they were newly added is unsafe.
-- No-op down: outside catalog growth is forward-only.
SELECT 1;
