-- Up Migration
-- Restore the baseline service-area policy if an operational cleanup removed
-- its reference rows. Existing administrator edits always take precedence.
INSERT INTO service_locations(name,aliases,decision,is_city) VALUES
 ('בית שאן',ARRAY['בית שאן','בית-שאן'],'allowed',true),
 ('מסילות',ARRAY['מסילות'],'allowed',false),
 ('ירדנה',ARRAY['ירדנה'],'allowed',false),
 ('בית אלפא',ARRAY['בית אלפא','בית-אלפא'],'allowed',false),
 ('טירת צבי',ARRAY['קיבוץ טירת צבי'],'allowed',false),
 ('כפר רופין',ARRAY['כפר רופין'],'allowed',false),
 ('מחולה',ARRAY['מחולה'],'allowed',false),
 ('טירת צבי — בירור',ARRAY['טירת צבי'],'review',false),
 ('חיפה',ARRAY['חיפה'],'outside',true),
 ('תל אביב',ARRAY['תל אביב','תל אביב יפו'],'outside',true),
 ('ירושלים',ARRAY['ירושלים'],'outside',true),
 ('עפולה',ARRAY['עפולה'],'outside',true),
 ('טבריה',ARRAY['טבריה'],'outside',true),
 ('באר שבע',ARRAY['באר שבע'],'outside',true)
ON CONFLICT(name) DO NOTHING;

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'Retain service location history on rollback.'; END $$;
