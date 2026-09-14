-- Up Migration
ALTER TABLE integration_outbox ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE integration_outbox ADD COLUMN last_error text;
ALTER TABLE integration_outbox ADD COLUMN delivered_at timestamptz;

-- Down Migration
ALTER TABLE integration_outbox DROP COLUMN delivered_at;
ALTER TABLE integration_outbox DROP COLUMN last_error;
ALTER TABLE integration_outbox DROP COLUMN attempts;
