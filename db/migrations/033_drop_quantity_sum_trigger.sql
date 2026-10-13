-- Up Migration
-- Migration 030 raised per-row quantity to 1..20 and said the "max two
-- furniture" rule is prompt-owned. The deferred trigger from 001 still summed
-- quantity and rejected "12 כיסאות" (quantity=12) at COMMIT with
-- "request exceeds two items", while the agent had already recorded phantom
-- changed_fields. Drop the obsolete sum(quantity) ceiling.

DROP TRIGGER IF EXISTS request_quantity ON request_items;
DROP FUNCTION IF EXISTS check_request_quantity();

-- Down Migration
CREATE OR REPLACE FUNCTION check_request_quantity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM requests WHERE id=NEW.request_id FOR UPDATE;
 IF (SELECT COALESCE(sum(quantity),0) FROM request_items WHERE request_id=NEW.request_id)>2 THEN
  RAISE EXCEPTION 'request exceeds two items' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER request_quantity AFTER INSERT OR UPDATE ON request_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_request_quantity();
