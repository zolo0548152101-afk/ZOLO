-- Up Migration
ALTER TABLE outbox ADD COLUMN delivery_state text NOT NULL DEFAULT 'queued'
  CHECK(delivery_state IN ('queued','accepted','delivered','read','failed','uncertain'));
ALTER TABLE outbox ADD COLUMN provider_accepted_at timestamptz;
ALTER TABLE outbox ADD COLUMN delivered_at timestamptz;
ALTER TABLE outbox ADD COLUMN read_at timestamptz;
CREATE INDEX outbox_delivery_state_idx ON outbox(delivery_state,created_at);

-- Down Migration
DROP INDEX outbox_delivery_state_idx;
ALTER TABLE outbox DROP COLUMN read_at;
ALTER TABLE outbox DROP COLUMN delivered_at;
ALTER TABLE outbox DROP COLUMN provider_accepted_at;
ALTER TABLE outbox DROP COLUMN delivery_state;
