-- Up Migration
CREATE TABLE request_locations (
 request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('donor','receiver')),
 latitude numeric(9,6) NOT NULL CHECK(latitude BETWEEN -90 AND 90),
 longitude numeric(9,6) NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 message_id uuid NOT NULL UNIQUE REFERENCES messages(id),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(request_id,role)
);

-- Down Migration
DROP TABLE request_locations;
