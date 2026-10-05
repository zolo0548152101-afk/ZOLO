-- Up Migration
-- A run_date on a non-coordinated row was historically used as a proposal.
-- Preserve it as a proposal, but never as confirmed scheduling evidence.
UPDATE requests
SET proposed_run_date = run_date,
    run_date = NULL
WHERE status <> 'coordinated'
  AND run_date IS NOT NULL;

-- Down Migration
-- Deliberately irreversible: restoring these values to run_date would
-- recreate unconfirmed transport dates and could cause false coordination.
DO $$ BEGIN
  RAISE EXCEPTION 'Destructive down migration disabled; restore a verified backup instead.';
END $$;
