-- Up Migration
ALTER TABLE outbox ADD COLUMN format_state text NOT NULL DEFAULT 'ready'
  CHECK(format_state IN ('ready','pending','failed'));
CREATE INDEX outbox_format_state_idx ON outbox(format_state,state);

-- Down Migration
DROP INDEX outbox_format_state_idx;
ALTER TABLE outbox DROP COLUMN format_state;
