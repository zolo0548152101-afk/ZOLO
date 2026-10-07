ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS pending_extra_item jsonb;
