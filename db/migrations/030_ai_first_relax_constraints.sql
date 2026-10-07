-- Up Migration
-- AI-first: allow name-only receiver parties (no phone yet) and relax the
-- hard 2-item DB ceiling so the AI's item count is not blocked by schema.
-- Behavior (max two furniture, grouping, duplicates) lives in prompts only.

ALTER TABLE request_parties
  ALTER COLUMN contact_id DROP NOT NULL;

ALTER TABLE request_parties
  DROP CONSTRAINT IF EXISTS request_parties_name_or_contact;
ALTER TABLE request_parties
  ADD CONSTRAINT request_parties_name_or_contact
  CHECK (contact_id IS NOT NULL OR (name IS NOT NULL AND length(trim(name)) > 0));

ALTER TABLE request_items
  DROP CONSTRAINT IF EXISTS request_items_position_check;
ALTER TABLE request_items
  ADD CONSTRAINT request_items_position_check
  CHECK (position BETWEEN 0 AND 19);

ALTER TABLE request_items
  DROP CONSTRAINT IF EXISTS request_items_quantity_check;
ALTER TABLE request_items
  ADD CONSTRAINT request_items_quantity_check
  CHECK (quantity BETWEEN 1 AND 20);

-- Down Migration
ALTER TABLE request_items DROP CONSTRAINT IF EXISTS request_items_quantity_check;
ALTER TABLE request_items ADD CONSTRAINT request_items_quantity_check CHECK (quantity BETWEEN 1 AND 2);
ALTER TABLE request_items DROP CONSTRAINT IF EXISTS request_items_position_check;
ALTER TABLE request_items ADD CONSTRAINT request_items_position_check CHECK (position BETWEEN 0 AND 1);
ALTER TABLE request_parties DROP CONSTRAINT IF EXISTS request_parties_name_or_contact;
-- Re-adding NOT NULL would fail if name-only rows exist; leave nullable on down.
