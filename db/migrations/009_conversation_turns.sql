-- Up Migration
-- Durable admission record for every quiet-window turn.  The turn is created
-- before text coalescing, so a restart cannot erase the messages that arrived
-- together or their original order.
CREATE TABLE conversation_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','superseded')),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX conversation_turns_pending_idx
  ON conversation_turns(conversation_id,status,opened_at);

CREATE TABLE turn_messages (
  turn_id uuid NOT NULL REFERENCES conversation_turns(id),
  message_id uuid NOT NULL REFERENCES messages(id),
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY(turn_id,message_id),
  UNIQUE(turn_id,position)
);

ALTER TABLE messages ADD COLUMN turn_id uuid REFERENCES conversation_turns(id);
ALTER TABLE messages ADD COLUMN turn_generation integer;
CREATE INDEX messages_turn_idx ON messages(turn_id,turn_generation);

-- Down Migration
ALTER TABLE messages DROP COLUMN turn_generation;
ALTER TABLE messages DROP COLUMN turn_id;
DROP TABLE turn_messages;
DROP TABLE conversation_turns;
