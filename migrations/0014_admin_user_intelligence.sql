-- Super-admin user management and privacy-limited product intelligence.
-- This migration is additive: existing auth, list, restaurant, and alert
-- records stay canonical while bounded analytics tables support reporting.

-- ---------------------------------------------------------------------------
-- Account lifecycle and consent
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN account_status text NOT NULL DEFAULT 'active'
    CHECK (account_status IN ('active', 'inactive', 'anonymized')),
  ADD COLUMN deactivated_at timestamptz,
  ADD COLUMN anonymized_at timestamptz,
  ADD COLUMN last_activity_at timestamptz,
  ADD COLUMN location_analytics_consent_at timestamptz,
  ADD COLUMN location_analytics_revoked_at timestamptz;

-- An anonymized account deliberately has no reusable login credential.
ALTER TABLE users DROP CONSTRAINT users_has_credential;
ALTER TABLE users ADD CONSTRAINT users_has_credential CHECK (
  account_status = 'anonymized'
  OR google_id IS NOT NULL
  OR password_hash IS NOT NULL
);

ALTER TABLE users ADD CONSTRAINT users_status_timestamps CHECK (
  (account_status = 'active' AND deactivated_at IS NULL AND anonymized_at IS NULL)
  OR (account_status = 'inactive' AND deactivated_at IS NOT NULL AND anonymized_at IS NULL)
  OR (account_status = 'anonymized' AND anonymized_at IS NOT NULL)
);

CREATE INDEX users_status_created_idx ON users (account_status, created_at DESC, id DESC);
CREATE INDEX users_last_activity_idx ON users (last_activity_at DESC, id DESC)
  WHERE last_activity_at IS NOT NULL;
CREATE INDEX users_name_prefix_idx ON users (lower(name) text_pattern_ops);
CREATE INDEX users_email_prefix_idx ON users (lower(email) text_pattern_ops);

-- ---------------------------------------------------------------------------
-- Product sessions and durable daily engagement summaries
-- ---------------------------------------------------------------------------

CREATE TABLE user_activity_sessions (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_activity_sessions_order CHECK (
    last_seen_at >= started_at
    AND (ended_at IS NULL OR ended_at >= started_at)
  )
);

CREATE INDEX user_activity_sessions_user_started_idx
  ON user_activity_sessions (user_id, started_at DESC);
CREATE INDEX user_activity_sessions_open_idx
  ON user_activity_sessions (last_seen_at)
  WHERE ended_at IS NULL;

CREATE TABLE user_engagement_daily (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_date    date NOT NULL,
  session_count    integer NOT NULL DEFAULT 0 CHECK (session_count >= 0),
  active_seconds   bigint NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
  meaningful_events integer NOT NULL DEFAULT 0 CHECK (meaningful_events >= 0),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, activity_date)
);

CREATE INDEX user_engagement_daily_date_idx
  ON user_engagement_daily (activity_date DESC, user_id);

CREATE TRIGGER user_engagement_daily_updated_at
  BEFORE UPDATE ON user_engagement_daily
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Delivery summaries survive the short-lived notification dedup log.
-- "delivered" is provider-confirmed; it is intentionally distinct from sent.
-- ---------------------------------------------------------------------------

CREATE TABLE user_notification_daily_metrics (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric_date    date NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('email', 'text')),
  sent_count     integer NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  delivered_count integer NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
  failed_count   integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  simulated_count integer NOT NULL DEFAULT 0 CHECK (simulated_count >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, metric_date, channel)
);

CREATE INDEX user_notification_daily_metrics_date_idx
  ON user_notification_daily_metrics (metric_date DESC, channel, user_id);

CREATE TRIGGER user_notification_daily_metrics_updated_at
  BEFORE UPDATE ON user_notification_daily_metrics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Coarse, consented market activity. Raw coordinates are never stored.
-- ---------------------------------------------------------------------------

CREATE TABLE user_area_activity_daily (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area_key       text NOT NULL CHECK (btrim(area_key) <> ''),
  activity_date  date NOT NULL,
  source         text NOT NULL CHECK (source IN ('near_me')),
  event_count    integer NOT NULL DEFAULT 1 CHECK (event_count > 0),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, area_key, activity_date, source),
  CONSTRAINT user_area_activity_daily_order CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX user_area_activity_daily_area_date_idx
  ON user_area_activity_daily (area_key, activity_date DESC, user_id);
CREATE INDEX user_area_activity_daily_user_date_idx
  ON user_area_activity_daily (user_id, activity_date DESC);

-- ---------------------------------------------------------------------------
-- Small, allowlisted product event stream and admin audit log
-- ---------------------------------------------------------------------------

CREATE TABLE product_analytics_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  session_id  uuid REFERENCES user_activity_sessions(id) ON DELETE SET NULL,
  event_name  text NOT NULL CHECK (btrim(event_name) <> ''),
  properties  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX product_analytics_events_name_created_idx
  ON product_analytics_events (event_name, created_at DESC);
CREATE INDEX product_analytics_events_user_created_idx
  ON product_analytics_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE TABLE admin_user_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action         text NOT NULL CHECK (action IN (
    'account_deactivated',
    'account_reactivated',
    'account_anonymized'
  )),
  reason         text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_user_actions_target_created_idx
  ON admin_user_actions (target_user_id, created_at DESC);
CREATE INDEX admin_user_actions_actor_created_idx
  ON admin_user_actions (actor_user_id, created_at DESC);

