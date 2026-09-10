ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS pending_counterparty_name text;
