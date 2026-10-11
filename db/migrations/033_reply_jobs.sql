-- Up Migration
-- The action stage is committed before a second, independently retryable AI
-- reply stage. A unique message id makes the action stage exactly-once.
CREATE TABLE reply_jobs (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  request_id uuid REFERENCES requests(id) ON DELETE SET NULL,
  operation jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','processing','completed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);
CREATE INDEX reply_jobs_recover_idx ON reply_jobs(state, created_at)
  WHERE state IN ('pending','failed','processing');

-- Down Migration
DROP TABLE IF EXISTS reply_jobs;
