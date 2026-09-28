-- Up Migration
ALTER TABLE requests
  ADD COLUMN proposed_run_date date
  CHECK (proposed_run_date IS NULL OR extract(isodow FROM proposed_run_date) = 2);

ALTER TABLE request_parties
  ADD COLUMN schedule_approved_date date
    CHECK (schedule_approved_date IS NULL OR extract(isodow FROM schedule_approved_date) = 2),
  ADD COLUMN schedule_approved_at timestamptz;

-- Down Migration
ALTER TABLE request_parties
  DROP COLUMN schedule_approved_at,
  DROP COLUMN schedule_approved_date;
ALTER TABLE requests DROP COLUMN proposed_run_date;
