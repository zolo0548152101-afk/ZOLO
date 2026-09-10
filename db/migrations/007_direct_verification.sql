-- Up Migration
-- A direct handoff may contact the other party only after the initiating
-- party explicitly asks us to do so.
ALTER TABLE requests
  ADD COLUMN verification_contacted boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE requests DROP COLUMN verification_contacted;
