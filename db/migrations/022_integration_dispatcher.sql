-- Up Migration
UPDATE integration_outbox SET state='dead_letter' WHERE state='failed';
ALTER TABLE integration_outbox DROP CONSTRAINT integration_outbox_state_check;
ALTER TABLE integration_outbox ADD CONSTRAINT integration_outbox_state_check CHECK(state IN ('pending','active','delivered','dead_letter'));
ALTER TABLE integration_outbox ADD COLUMN idempotency_key text;
UPDATE integration_outbox SET idempotency_key='integration:'||integration||':'||event_id::text WHERE idempotency_key IS NULL;
ALTER TABLE integration_outbox ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE integration_outbox ADD CONSTRAINT integration_outbox_idempotency_key_unique UNIQUE(idempotency_key);
ALTER TABLE integration_outbox ADD COLUMN last_attempt_at timestamptz;
ALTER TABLE integration_outbox ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE integration_outbox ADD COLUMN terminal_at timestamptz;
ALTER TABLE integration_outbox ADD COLUMN error_class text;
ALTER TABLE integration_outbox ADD CONSTRAINT integration_outbox_error_class_check CHECK(error_class IS NULL OR error_class IN ('retryable','retry_exhausted','terminal','ambiguous'));
CREATE INDEX integration_outbox_order_idx ON integration_outbox(integration,event_id) WHERE state<>'delivered';

-- Down Migration
DROP INDEX integration_outbox_order_idx;
ALTER TABLE integration_outbox DROP CONSTRAINT integration_outbox_error_class_check;
ALTER TABLE integration_outbox DROP COLUMN error_class;
ALTER TABLE integration_outbox DROP COLUMN terminal_at;
ALTER TABLE integration_outbox DROP COLUMN next_attempt_at;
ALTER TABLE integration_outbox DROP COLUMN last_attempt_at;
ALTER TABLE integration_outbox DROP CONSTRAINT integration_outbox_idempotency_key_unique;
ALTER TABLE integration_outbox DROP COLUMN idempotency_key;
ALTER TABLE integration_outbox DROP CONSTRAINT integration_outbox_state_check;
ALTER TABLE integration_outbox ADD CONSTRAINT integration_outbox_state_check CHECK(state IN ('pending','delivered','failed'));
