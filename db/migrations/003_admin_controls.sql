-- Up Migration
CREATE TABLE conversation_resets (
 conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 reset_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX conversation_resets_reset_idx ON conversation_resets(reset_at);
INSERT INTO app_settings(key,value) VALUES
 ('bot_access','{"mode":"open","phones":[]}')
ON CONFLICT(key) DO NOTHING;

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'Retain admin-control audit state on rollback.'; END $$;
