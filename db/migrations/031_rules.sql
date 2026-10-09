-- Up Migration
-- Business-rule facts the AI receives as data. Code still re-checks the four
-- hard boundaries transactionally at write time; this table is the shared
-- source of truth for limits, window and service area.
CREATE TABLE rules (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO rules(key, value) VALUES
  ('transport_capacity_limit', '10'::jsonb),
  (
    'transport_window',
    '{"weekday":"tuesday","tz":"Asia/Jerusalem","start":"16:00","end":"20:00"}'::jsonb
  ),
  (
    'service_area',
    '{"allowed":["בית שאן","מסילות","ירדנה","בית אלפא","טירת צבי","שדה אליהו","כפר רופין","מחולה"],"borderline":["שדה אליהו"],"notes":"Beit Shean and nearby settlements; borderline needs escalate"}'::jsonb
  ),
  (
    'hard_boundaries',
    '["capacity_full","outside_area","schedule_window","duplicate_request"]'::jsonb
  );

-- Down Migration
DROP TABLE IF EXISTS rules;
