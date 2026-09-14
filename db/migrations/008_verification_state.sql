-- Up Migration
-- Replace the ambiguous request-level boolean with one durable state per party.
-- The legacy column remains during the expand/dual-read period.
CREATE TABLE request_verifications (
  request_id uuid NOT NULL REFERENCES requests(id),
  role text NOT NULL CHECK(role IN ('donor','receiver')),
  state text NOT NULL DEFAULT 'not_offered' CHECK(state IN (
    'not_offered','offered','declined','consented','queued',
    'provider_accepted','delivered','approved','failed','uncertain'
  )),
  offered_at timestamptz,
  consented_at timestamptz,
  queued_at timestamptz,
  provider_accepted_at timestamptz,
  delivered_at timestamptz,
  approved_at timestamptz,
  failed_at timestamptz,
  uncertain_at timestamptz,
  outbox_id uuid REFERENCES outbox(id),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(request_id,role)
);
CREATE INDEX request_verifications_state_idx
  ON request_verifications(state,updated_at);

-- Existing true values are deliberately conservative: the old boolean did not
-- prove provider acceptance or delivery, so they become uncertain rather than
-- being reported as sent.
INSERT INTO request_verifications(request_id,role,state,uncertain_at)
SELECT r.id,p.role,
       CASE WHEN r.verification_contacted THEN 'uncertain' ELSE 'not_offered' END,
       CASE WHEN r.verification_contacted THEN clock_timestamp() ELSE NULL END
FROM requests r
JOIN request_parties p ON p.request_id=r.id
ON CONFLICT(request_id,role) DO NOTHING;

-- Down Migration
DROP TABLE request_verifications;
