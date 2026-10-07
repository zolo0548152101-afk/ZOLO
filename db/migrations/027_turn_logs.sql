-- Up Migration
-- Durable per-turn debug log for admin read-only inspection.
CREATE TABLE turn_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id),
  turn_id uuid REFERENCES conversation_turns(id),
  phone text,
  message_ids uuid[] NOT NULL DEFAULT '{}',
  merged_text text NOT NULL DEFAULT '',
  turn_fate text NOT NULL CHECK (turn_fate IN (
    'completed','superseded','coalesced','released','failed'
  )),
  fate_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_before jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_after jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_input jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_output jsonb NOT NULL DEFAULT '{}'::jsonb,
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
  policies jsonb NOT NULL DEFAULT '{}'::jsonb,
  reply_text text,
  outbox_id uuid,
  error_code text,
  opened_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX turn_logs_phone_created_idx ON turn_logs(phone, created_at DESC);
CREATE INDEX turn_logs_turn_idx ON turn_logs(turn_id);
CREATE INDEX turn_logs_conversation_idx ON turn_logs(conversation_id, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS turn_logs;
