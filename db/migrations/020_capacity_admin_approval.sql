-- Up Migration
ALTER TABLE transport_runs
  DROP CONSTRAINT IF EXISTS transport_runs_capacity_check;
ALTER TABLE transport_runs
  ADD CONSTRAINT transport_runs_capacity_check CHECK (capacity BETWEEN 1 AND 100);

CREATE TABLE transport_capacity_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date date NOT NULL REFERENCES transport_runs(date),
  requested_capacity integer NOT NULL CHECK (requested_capacity BETWEEN 2 AND 100),
  request_id uuid REFERENCES requests(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolved_by text,
  UNIQUE (run_date, requested_capacity)
);
CREATE INDEX transport_capacity_approvals_pending_idx
  ON transport_capacity_approvals(run_date, requested_at)
  WHERE status = 'pending';

-- Down Migration
DROP TABLE transport_capacity_approvals;
UPDATE transport_runs SET capacity=10 WHERE capacity>10;
ALTER TABLE transport_runs
  DROP CONSTRAINT IF EXISTS transport_runs_capacity_check;
ALTER TABLE transport_runs
  ADD CONSTRAINT transport_runs_capacity_check CHECK (capacity BETWEEN 1 AND 10);
