-- Up Migration
UPDATE transport_runs SET capacity = 10 WHERE capacity > 10;

ALTER TABLE transport_runs
  DROP CONSTRAINT IF EXISTS transport_runs_capacity_check;

ALTER TABLE transport_runs
  ADD CONSTRAINT transport_runs_capacity_check
  CHECK (capacity BETWEEN 1 AND 10);

-- Down Migration
ALTER TABLE transport_runs
  DROP CONSTRAINT IF EXISTS transport_runs_capacity_check;
ALTER TABLE transport_runs
  ADD CONSTRAINT transport_runs_capacity_check CHECK (capacity BETWEEN 1 AND 100);
