-- Allow multiple active seeks per contact (e.g. fridge + bed).
-- Was: contact_id PRIMARY KEY → only one search row, second kind wiped the first.

ALTER TABLE searches DROP CONSTRAINT IF EXISTS searches_pkey;

ALTER TABLE searches
  ADD CONSTRAINT searches_contact_kind_pkey PRIMARY KEY (contact_id, kind);

CREATE INDEX IF NOT EXISTS searches_contact_active_idx
  ON searches(contact_id)
  WHERE state = 'active';
