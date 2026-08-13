-- Initial schema. See README-NEON-MIGRATION.md for the full design
-- rationale (§3 decisions, §4 walks through every table).
--
-- No extensions required, deliberately — gen_random_uuid() is core in
-- Postgres 13+, and citext is avoided (not available on the local PGlite
-- dev database, see README-NEON-MIGRATION.md §10) in favor of a
-- lower(email) functional unique index. Verified against Postgres 17.5.

CREATE TABLE schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL DEFAULT '',
  email                text NOT NULL,
  password_salt        text,
  password_hash        text,
  google_id            text,
  picture              text NOT NULL DEFAULT '',
  share_id             text NOT NULL UNIQUE,
  phone                text NOT NULL DEFAULT '',
  sms_consent_at       timestamptz,
  weekly_digest_opt_in boolean NOT NULL DEFAULT false,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Verified against api/account/profile.ts and api/account/google.ts
  -- (README-NEON-MIGRATION.md §4's "verify before adding" note): neither
  -- route ever clears password_hash or google_id to null without the other
  -- being set, so every account genuinely does arrive via one or both.
  CONSTRAINT users_has_credential CHECK (google_id IS NOT NULL OR password_hash IS NOT NULL)
);

-- Case-insensitive uniqueness without citext. Always write emails already
-- lowercased; this index is the backstop, and it also serves lookups by
-- `WHERE lower(email) = lower($1)`.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- Partial: many users have no Google identity, and NULLs aren't unique.
CREATE UNIQUE INDEX users_google_id_key ON users (google_id)
  WHERE google_id IS NOT NULL;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- restaurants — a second, separate login from consumer accounts (see
-- README-NOTIFICATIONS-SETUP.md).
-- ---------------------------------------------------------------------------

CREATE TABLE restaurants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  email               text NOT NULL,
  password_salt       text,
  password_hash       text,
  website             text NOT NULL DEFAULT '',
  verified            boolean NOT NULL DEFAULT false,
  verification_method text CHECK (verification_method IN ('domain','manual')),
  verification_status text NOT NULL DEFAULT 'pending'
                        CHECK (verification_status IN ('verified','pending','denied')),
  claim_note          text NOT NULL DEFAULT '',
  denial_reason       text,
  plan                text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','paid')),
  sms_funding_enabled boolean NOT NULL DEFAULT false,
  -- Deliberately not unique / not a real FK — venues live in
  -- public/data/happy-hours.json, not this database (see §7), and venue
  -- claims are trusted rather than admin-arbitrated today (kv.ts's old
  -- comment on Restaurant.venueId). When that's tightened, add:
  --   CREATE UNIQUE INDEX ON restaurants (venue_id)
  --     WHERE venue_id IS NOT NULL AND verification_status = 'verified';
  venue_id            integer CHECK (venue_id IS NULL OR venue_id > 0),
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX restaurants_email_lower_key ON restaurants (lower(email));
CREATE INDEX restaurants_venue_id_idx ON restaurants (venue_id)
  WHERE venue_id IS NOT NULL;
CREATE INDEX restaurants_verification_status_idx ON restaurants (verification_status);

CREATE TRIGGER restaurants_updated_at BEFORE UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- sessions — replaces Redis TTL. Id stays `text`: it's the existing
-- 32-byte hex token from session.ts, generated in application code.
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id            text PRIMARY KEY,
  role          text NOT NULL CHECK (role IN ('user','restaurant')),
  user_id       uuid REFERENCES users(id)       ON DELETE CASCADE,
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  CONSTRAINT sessions_subject CHECK (
    (role = 'user'       AND user_id IS NOT NULL AND restaurant_id IS NULL) OR
    (role = 'restaurant' AND restaurant_id IS NOT NULL AND user_id IS NULL)
  )
);

CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- saved_spots
-- ---------------------------------------------------------------------------

CREATE TABLE saved_spots (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_id   integer NOT NULL CHECK (venue_id > 0),
  status     text NOT NULL CHECK (status IN ('favorite','want-to-try','been-to')),
  note       text NOT NULL DEFAULT '',
  rating     smallint CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, venue_id)
);

CREATE INDEX saved_spots_user_id_idx ON saved_spots (user_id);

CREATE TRIGGER saved_spots_updated_at BEFORE UPDATE ON saved_spots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- alerts
-- ---------------------------------------------------------------------------

CREATE TABLE alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  filters         jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel_email   boolean NOT NULL DEFAULT true,
  channel_text    boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT true,
  source_alert_id uuid REFERENCES alerts(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX alerts_user_id_idx ON alerts (user_id);
CREATE INDEX alerts_active_idx  ON alerts (active) WHERE active;
CREATE INDEX alerts_filters_gin ON alerts USING gin (filters);

CREATE TRIGGER alerts_updated_at BEFORE UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- live_overrides and promotions — both keyed by venue, so venue_id is the
-- natural primary key. No surrogate id needed.
-- ---------------------------------------------------------------------------

CREATE TABLE live_overrides (
  venue_id   integer PRIMARY KEY CHECK (venue_id > 0),
  active     boolean NOT NULL DEFAULT false,
  since      timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Only active, unexpired rows are ever read.
CREATE INDEX live_overrides_active_idx ON live_overrides (expires_at) WHERE active;

CREATE TRIGGER live_overrides_updated_at BEFORE UPDATE ON live_overrides
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE promotions (
  venue_id    integer PRIMARY KEY CHECK (venue_id > 0),
  deal_code   text NOT NULL,
  description text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER promotions_updated_at BEFORE UPDATE ON promotions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- submissions
-- ---------------------------------------------------------------------------

CREATE TABLE submissions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','denied')),
  contact_name        text NOT NULL DEFAULT '',
  contact_email       text NOT NULL,
  contact_notes       text NOT NULL DEFAULT '',
  -- Stays jsonb on purpose: a staging payload validated by validateListing()
  -- and then written into public/data/happy-hours.json. Its shape must
  -- track that JSON file, so pinning it to columns would mean a migration
  -- every time the venue format changes.
  listing             jsonb NOT NULL,
  denial_reason       text,
  approved_listing_id integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX submissions_status_created_at_idx ON submissions (status, created_at DESC);

CREATE TRIGGER submissions_updated_at BEFORE UPDATE ON submissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- notification_log — backs dedup + the per-user daily SMS cap. Retention
-- (7 days) is enforced in application code (store.ts) via a plain DELETE,
-- not here.
-- ---------------------------------------------------------------------------

CREATE TABLE notification_log (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_id integer NOT NULL CHECK (venue_id > 0),
  channel  text NOT NULL CHECK (channel IN ('email','text')),
  sent_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_log_dedup_idx ON notification_log (user_id, venue_id, sent_at DESC);
CREATE INDEX notification_log_sent_at_idx ON notification_log (sent_at);
CREATE INDEX notification_log_sms_cap_idx ON notification_log (user_id, sent_at DESC)
  WHERE channel = 'text';
