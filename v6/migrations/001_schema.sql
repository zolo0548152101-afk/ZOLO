-- haim-v6 schema. Idempotent. PostgreSQL 16+ (Neon PG 18 compatible).
-- Business rows live in schema haim. Agent entry points are public functions
-- created in 002_functions.sql.

CREATE SCHEMA IF NOT EXISTS haim;

DO $$ BEGIN
  CREATE TYPE haim.delivery_state AS ENUM ('pending','sending','sent','uncertain','failed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS haim.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL UNIQUE CHECK (phone ~ '^[2-9][0-9]{7,8}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS haim.contact_identities (
  session text NOT NULL,
  chat_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES haim.contacts(id) ON DELETE CASCADE,
  resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session, chat_id)
);

CREATE TABLE IF NOT EXISTS haim.service_locations (
  name text PRIMARY KEY,
  aliases text[] NOT NULL DEFAULT '{}',
  decision text NOT NULL CHECK (decision IN ('allowed','outside','review')),
  is_city boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS haim.streets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement text NOT NULL DEFAULT 'בית שאן',
  name text NOT NULL,
  normalized text NOT NULL,
  UNIQUE (settlement, normalized)
);

CREATE TABLE IF NOT EXISTS haim.transport_runs (
  run_date date PRIMARY KEY CHECK (EXTRACT(ISODOW FROM run_date) = 2),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS haim.request_counter (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  value bigint NOT NULL CHECK (value >= 0)
);
INSERT INTO haim.request_counter (id, value) VALUES (true, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS haim.requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint NOT NULL UNIQUE CHECK (number > 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  status text NOT NULL CHECK (status IN (
    'collecting','available','awaiting_approval','waiting_capacity',
    'coordinated','human','cancel_pending','cancelled','closed','rejected'
  )),
  origin text NOT NULL CHECK (origin IN ('donation','direct')),
  verification_contacted boolean NOT NULL DEFAULT false,
  represents_both_parties boolean NOT NULL DEFAULT false,
  run_date date REFERENCES haim.transport_runs(run_date),
  proposed_run_date date,
  earliest_run_date date,
  preferred_time text,
  human_reason text,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status <> 'coordinated' OR run_date IS NOT NULL),
  CHECK (run_date IS NULL OR EXTRACT(ISODOW FROM run_date) = 2),
  CHECK (proposed_run_date IS NULL OR EXTRACT(ISODOW FROM proposed_run_date) = 2),
  CHECK (earliest_run_date IS NULL OR EXTRACT(ISODOW FROM earliest_run_date) = 2)
);

CREATE TABLE IF NOT EXISTS haim.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES haim.contacts(id) ON DELETE CASCADE,
  session text NOT NULL,
  chat_id text NOT NULL,
  mode text NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot','human')),
  selected_request_id uuid REFERENCES haim.requests(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  pending_counterparty_name text,
  pending_counterparty_phone text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (session, contact_id)
);

CREATE TABLE IF NOT EXISTS haim.request_parties (
  request_id uuid NOT NULL REFERENCES haim.requests(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('donor','receiver')),
  contact_id uuid NOT NULL REFERENCES haim.contacts(id),
  phone text NOT NULL CHECK (phone ~ '^[2-9][0-9]{7,8}$'),
  name text,
  settlement text,
  address text,
  floor smallint CHECK (floor IS NULL OR floor BETWEEN -3 AND 100),
  floor_note_shown boolean NOT NULL DEFAULT false,
  approved_at timestamptz,
  approved_by_phone text,
  schedule_approved boolean NOT NULL DEFAULT false,
  schedule_approved_date date,
  schedule_approved_at timestamptz,
  PRIMARY KEY (request_id, role),
  CHECK (
    (approved_at IS NULL AND approved_by_phone IS NULL)
    OR (approved_at IS NOT NULL AND approved_by_phone = phone)
  ),
  CHECK (schedule_approved_date IS NULL OR EXTRACT(ISODOW FROM schedule_approved_date) = 2)
);

CREATE TABLE IF NOT EXISTS haim.request_items (
  request_id uuid NOT NULL REFERENCES haim.requests(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 1),
  kind text NOT NULL CHECK (kind IN (
    'bed','sofa','wardrobe','fridge','oven','table_set','table','chairs',
    'washing_machine','dryer','freezer','dishwasher','other','piano','house_move'
  )),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 160),
  quantity smallint NOT NULL CHECK (quantity BETWEEN 1 AND 2),
  free boolean,
  working boolean,
  needs_disassembly boolean,
  wardrobe_small_whole boolean,
  oven_type text CHECK (oven_type IS NULL OR oven_type IN ('built_in','combined')),
  evacuation text CHECK (evacuation IS NULL OR evacuation IN ('none','equivalent','different')),
  PRIMARY KEY (request_id, position)
);

CREATE TABLE IF NOT EXISTS haim.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  session text NOT NULL,
  waha_message_id text NOT NULL,
  contact_id uuid REFERENCES haim.contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES haim.conversations(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('text','image','voice','contact','location')),
  text text NOT NULL DEFAULT '',
  contacts jsonb NOT NULL DEFAULT '[]',
  location jsonb,
  media jsonb,
  reply text,
  error_code text,
  turn_result jsonb,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  UNIQUE (session, waha_message_id)
);

CREATE TABLE IF NOT EXISTS haim.media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL UNIQUE REFERENCES haim.messages(id) ON DELETE CASCADE,
  mime_type text,
  waha_message_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS haim.request_media (
  request_id uuid NOT NULL REFERENCES haim.requests(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES haim.media(id) ON DELETE CASCADE,
  added_by uuid REFERENCES haim.contacts(id),
  PRIMARY KEY (request_id, media_id)
);

CREATE TABLE IF NOT EXISTS haim.request_locations (
  request_id uuid NOT NULL REFERENCES haim.requests(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('donor','receiver')),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  message_id uuid REFERENCES haim.messages(id) ON DELETE SET NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (request_id, role)
);

CREATE TABLE IF NOT EXISTS haim.request_verifications (
  request_id uuid NOT NULL REFERENCES haim.requests(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('donor','receiver')),
  state text NOT NULL DEFAULT 'not_offered' CHECK (state IN (
    'not_offered','offered','declined','consented','queued',
    'provider_accepted','delivered','approved','failed','uncertain'
  )),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text,
  PRIMARY KEY (request_id, role)
);

CREATE TABLE IF NOT EXISTS haim.searches (
  contact_id uuid PRIMARY KEY REFERENCES haim.contacts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','matched','closed')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS haim.matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES haim.requests(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES haim.contacts(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('waiting_photo','queued_photo','presented','interested','unavailable')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  presented_at timestamptz,
  UNIQUE (request_id, contact_id)
);

CREATE TABLE IF NOT EXISTS haim.deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  message_id uuid REFERENCES haim.messages(id) ON DELETE SET NULL,
  request_id uuid REFERENCES haim.requests(id) ON DELETE SET NULL,
  phone text NOT NULL CHECK (phone ~ '^[2-9][0-9]{7,8}$'),
  chat_id text NOT NULL,
  body text NOT NULL,
  state haim.delivery_state NOT NULL DEFAULT 'pending',
  provider_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz
);

CREATE TABLE IF NOT EXISTS haim.transport_capacity_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date date NOT NULL REFERENCES haim.transport_runs(run_date),
  requested_capacity integer NOT NULL CHECK (requested_capacity BETWEEN 2 AND 100),
  request_id uuid REFERENCES haim.requests(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolved_by text,
  UNIQUE (run_date, requested_capacity)
);

CREATE TABLE IF NOT EXISTS haim.request_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid REFERENCES haim.requests(id) ON DELETE SET NULL,
  message_id uuid REFERENCES haim.messages(id) ON DELETE SET NULL,
  actor text NOT NULL,
  event_type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS haim.conversation_resets (
  conversation_id uuid PRIMARY KEY REFERENCES haim.conversations(id) ON DELETE CASCADE,
  reset_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS haim.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS haim.logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT clock_timestamp(),
  level text NOT NULL CHECK (level IN ('debug','info','warn','error')),
  phone text,
  conversation_id uuid,
  request_id uuid,
  waha_message_id text,
  event text NOT NULL CHECK (event IN (
    'inbound','outbound','db_update','rejected_update','escalation','error','agent_note'
  )),
  details jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS logs_ts_idx ON haim.logs (ts DESC);
CREATE INDEX IF NOT EXISTS logs_phone_idx ON haim.logs (phone, ts DESC);
CREATE INDEX IF NOT EXISTS logs_event_idx ON haim.logs (event, ts DESC);
CREATE INDEX IF NOT EXISTS logs_conversation_idx ON haim.logs (conversation_id, ts DESC);
CREATE INDEX IF NOT EXISTS messages_pending_idx ON haim.messages (conversation_id, seq) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS requests_open_idx ON haim.requests (status, number);
CREATE INDEX IF NOT EXISTS deliveries_phone_idx ON haim.deliveries (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS parties_phone_idx ON haim.request_parties (phone);

CREATE OR REPLACE FUNCTION haim.check_request_quantity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  other_n int;
  furniture_n int;
  has_table boolean;
  has_chairs boolean;
BEGIN
  PERFORM id FROM haim.requests WHERE id = COALESCE(NEW.request_id, OLD.request_id) FOR UPDATE;
  SELECT
    COALESCE(SUM(quantity) FILTER (WHERE kind NOT IN ('table','chairs')), 0),
    COALESCE(SUM(quantity) FILTER (WHERE kind IN ('table','chairs')), 0),
    BOOL_OR(kind = 'table'),
    BOOL_OR(kind = 'chairs')
  INTO other_n, furniture_n, has_table, has_chairs
  FROM haim.request_items
  WHERE request_id = COALESCE(NEW.request_id, OLD.request_id);
  IF has_table AND has_chairs THEN
    furniture_n := 1;
  END IF;
  IF other_n + furniture_n > 2 THEN
    RAISE EXCEPTION 'request exceeds two items' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM haim.request_items
    WHERE request_id = COALESCE(NEW.request_id, OLD.request_id)
      AND kind IN ('piano','house_move')
  ) THEN
    RAISE EXCEPTION 'piano or house move is not transported' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS request_quantity ON haim.request_items;
CREATE TRIGGER request_quantity
  AFTER INSERT OR UPDATE OR DELETE ON haim.request_items
  FOR EACH ROW EXECUTE FUNCTION haim.check_request_quantity();
