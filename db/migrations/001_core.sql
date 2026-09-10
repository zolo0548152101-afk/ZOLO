-- Up Migration
CREATE TABLE contacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 phone text NOT NULL UNIQUE CHECK (phone ~ '^[2-9][0-9]{7,8}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE contact_identities (
 session text NOT NULL, chat_id text NOT NULL, contact_id uuid NOT NULL REFERENCES contacts(id),
 resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(session,chat_id)
);
CREATE INDEX identities_contact_idx ON contact_identities(contact_id);
CREATE TABLE conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL REFERENCES contacts(id),
 channel text NOT NULL DEFAULT 'whatsapp', session text NOT NULL, chat_id text NOT NULL,
 mode text NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot','human')),
 selected_request_id uuid, version integer NOT NULL DEFAULT 0 CHECK(version>=0),
 UNIQUE(channel,session,contact_id)
);
CREATE TABLE service_locations (
 name text PRIMARY KEY, aliases text[] NOT NULL DEFAULT '{}',
 decision text NOT NULL CHECK(decision IN ('allowed','outside','review')),
 is_city boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX location_aliases_idx ON service_locations USING gin(aliases);
CREATE TABLE transport_runs (
 date date PRIMARY KEY CHECK(extract(isodow FROM date)=2),
 capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 100),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE request_counter (id boolean PRIMARY KEY DEFAULT true CHECK(id), value bigint NOT NULL CHECK(value>=0));
INSERT INTO request_counter VALUES(true,0);
CREATE TABLE requests (
 id uuid PRIMARY KEY, number bigint NOT NULL UNIQUE CHECK(number>0),
 version integer NOT NULL DEFAULT 0 CHECK(version>=0),
 status text NOT NULL CHECK(status IN ('collecting','available','awaiting_approval','waiting_capacity','coordinated','human','cancel_pending','cancelled','closed','rejected')),
 origin text NOT NULL CHECK(origin IN ('donation','direct')),
 run_date date REFERENCES transport_runs(date), earliest_run_date date CHECK(extract(isodow FROM earliest_run_date)=2), human_reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(status<>'coordinated' OR run_date IS NOT NULL)
);
ALTER TABLE conversations ADD CONSTRAINT conversations_selected_fk FOREIGN KEY(selected_request_id) REFERENCES requests(id);
CREATE INDEX conversations_selected_idx ON conversations(selected_request_id) WHERE selected_request_id IS NOT NULL;
CREATE INDEX requests_open_idx ON requests(status,number) WHERE status NOT IN ('closed','cancelled','rejected');
CREATE INDEX requests_run_idx ON requests(run_date) WHERE run_date IS NOT NULL;
CREATE TABLE request_parties (
 request_id uuid NOT NULL REFERENCES requests(id), role text NOT NULL CHECK(role IN ('donor','receiver')),
 contact_id uuid NOT NULL REFERENCES contacts(id), name text, settlement text REFERENCES service_locations(name), address text,
 floor smallint CHECK(floor BETWEEN -3 AND 100), floor_note_shown boolean NOT NULL DEFAULT false,
 approved_at timestamptz, approved_by uuid REFERENCES contacts(id), schedule_approved boolean NOT NULL DEFAULT false,
 PRIMARY KEY(request_id,role),
 CHECK((approved_at IS NULL AND approved_by IS NULL) OR (approved_at IS NOT NULL AND approved_by=contact_id))
);
CREATE INDEX parties_contact_idx ON request_parties(contact_id,request_id);
CREATE INDEX parties_approved_by_idx ON request_parties(approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX parties_settlement_idx ON request_parties(settlement) WHERE settlement IS NOT NULL;
CREATE TABLE request_items (
 request_id uuid NOT NULL REFERENCES requests(id), position smallint NOT NULL CHECK(position BETWEEN 0 AND 1),
 kind text NOT NULL CHECK(kind IN ('bed','sofa','wardrobe','fridge','oven','table_set','table','chairs','washing_machine','dryer','freezer','dishwasher','other','piano','house_move')),
 description text NOT NULL CHECK(length(description) BETWEEN 1 AND 160), quantity smallint NOT NULL CHECK(quantity BETWEEN 1 AND 2),
 free boolean, working boolean, needs_disassembly boolean, wardrobe_small_whole boolean,
 oven_type text CHECK(oven_type IN ('built_in','combined')), evacuation text CHECK(evacuation IN ('none','equivalent','different')),
 PRIMARY KEY(request_id,position)
);
CREATE INDEX items_matching_idx ON request_items(kind,request_id);
CREATE TABLE messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 channel text NOT NULL DEFAULT 'whatsapp', session text NOT NULL, external_id text NOT NULL,
 trace_id uuid NOT NULL, mode text NOT NULL CHECK(mode IN ('shadow','live','simulation')),
 chat_id text NOT NULL, contact_id uuid REFERENCES contacts(id), conversation_id uuid REFERENCES conversations(id),
 kind text NOT NULL CHECK(kind IN ('text','image','voice','contact','location')),
 text text NOT NULL DEFAULT '', contacts jsonb NOT NULL DEFAULT '[]', location jsonb,
 media_url text, media_id uuid, media_state text NOT NULL DEFAULT 'none' CHECK(media_state IN ('none','pending','ready','failed')),
 transcript text, ai_plan jsonb, plan_versions jsonb, ai_metadata jsonb,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(), processed_at timestamptz, reply text, error_code text,
 UNIQUE(channel,session,external_id)
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id,seq);
CREATE INDEX messages_contact_idx ON messages(contact_id,seq);
CREATE INDEX messages_trace_idx ON messages(trace_id);
CREATE INDEX messages_pending_idx ON messages(seq) WHERE processed_at IS NULL;
CREATE TABLE media (
 id uuid PRIMARY KEY, message_id uuid NOT NULL UNIQUE REFERENCES messages(id),
 storage_key text NOT NULL CHECK(storage_key ~ '^[a-f0-9]{64}\.(jpg|png|webp|ogg|mp3|m4a|wav)$'),
 checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'), mime_type text NOT NULL,
 size_bytes bigint NOT NULL CHECK(size_bytes>0), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE messages ADD CONSTRAINT messages_media_fk FOREIGN KEY(media_id) REFERENCES media(id);
CREATE INDEX messages_media_idx ON messages(media_id) WHERE media_id IS NOT NULL;
CREATE TABLE request_media (
 request_id uuid NOT NULL REFERENCES requests(id), media_id uuid NOT NULL REFERENCES media(id),
 added_by uuid NOT NULL REFERENCES contacts(id), PRIMARY KEY(request_id,media_id)
);
CREATE INDEX request_media_media_idx ON request_media(media_id);
CREATE INDEX request_media_added_idx ON request_media(added_by);
CREATE TABLE searches (
 contact_id uuid PRIMARY KEY REFERENCES contacts(id), kind text NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','matched','closed')), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX searches_kind_idx ON searches(kind) WHERE state='active';
CREATE TABLE matches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES requests(id), contact_id uuid NOT NULL REFERENCES contacts(id),
 state text NOT NULL CHECK(state IN ('waiting_photo','queued_photo','presented','interested','unavailable')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), presented_at timestamptz, UNIQUE(request_id,contact_id)
);
CREATE INDEX matches_contact_idx ON matches(contact_id,state);
CREATE TABLE outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 dedupe_key text NOT NULL UNIQUE, message_id uuid REFERENCES messages(id), request_id uuid REFERENCES requests(id),
 trace_id uuid NOT NULL, mode text NOT NULL CHECK(mode IN ('live','shadow','simulation')),
 phone text NOT NULL CHECK(phone ~ '^[2-9][0-9]{7,8}$'), chat_id text NOT NULL, text text NOT NULL,
 media_id uuid REFERENCES media(id), match_id uuid REFERENCES matches(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','shadow','simulation','uncertain','failed','cancelled')),
 provider_id text, job_id uuid, error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), sent_at timestamptz
);
CREATE INDEX outbox_recipient_idx ON outbox(phone,seq) WHERE state IN ('pending','sending','uncertain','failed');
CREATE INDEX outbox_message_idx ON outbox(message_id);
CREATE INDEX outbox_request_idx ON outbox(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX outbox_media_idx ON outbox(media_id) WHERE media_id IS NOT NULL;
CREATE INDEX outbox_match_idx ON outbox(match_id) WHERE match_id IS NOT NULL;
CREATE TABLE request_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, request_id uuid REFERENCES requests(id), message_id uuid REFERENCES messages(id),
 trace_id uuid NOT NULL, actor text NOT NULL, event_type text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX events_request_idx ON request_events(request_id,id);
CREATE INDEX events_message_idx ON request_events(message_id);
CREATE INDEX events_trace_idx ON request_events(trace_id);
CREATE TABLE command_results (
 message_id uuid PRIMARY KEY REFERENCES messages(id), command jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE integrations (name text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, config jsonb NOT NULL DEFAULT '{}');
CREATE TABLE integration_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id bigint NOT NULL REFERENCES request_events(id), integration text NOT NULL REFERENCES integrations(name),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','failed')), UNIQUE(event_id,integration)
);
CREATE INDEX integration_outbox_pending_idx ON integration_outbox(integration,id) WHERE state='pending';
CREATE TABLE schema_checksums (name text PRIMARY KEY, checksum text NOT NULL);
CREATE TABLE worker_heartbeats (id text PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT clock_timestamp());

-- The aggregate quantity is a cross-row invariant; a deferred constraint trigger
-- validates the complete item set at commit, including writes from future adapters.
CREATE FUNCTION check_request_quantity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM requests WHERE id=NEW.request_id FOR UPDATE;
 IF (SELECT COALESCE(sum(quantity),0) FROM request_items WHERE request_id=NEW.request_id)>2 THEN
  RAISE EXCEPTION 'request exceeds two items' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER request_quantity AFTER INSERT OR UPDATE ON request_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_request_quantity();

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'Destructive down migration disabled. Roll back the image, retain the schema, or restore a verified backup into a new database.'; END $$;
