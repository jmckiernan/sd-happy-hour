-- Paid merchant reporting, privacy-safe venue analytics, report schedules,
-- and time-limited access codes. This is intentionally additive: the legacy
-- venue_claims.plan flag remains a compatibility entitlement until billing is
-- introduced, while merchant_entitlements becomes the extensible source for
-- admin grants, access codes, and future billing records.

-- ---------------------------------------------------------------------------
-- Paid reporting access and time-limited access codes
-- ---------------------------------------------------------------------------

CREATE TABLE merchant_access_codes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash          text NOT NULL UNIQUE CHECK (char_length(code_hash) = 64),
  code_hint          text NOT NULL CHECK (char_length(code_hint) BETWEEN 4 AND 16),
  duration_months    integer NOT NULL CHECK (duration_months BETWEEN 1 AND 36),
  max_redemptions    integer NOT NULL DEFAULT 1 CHECK (max_redemptions BETWEEN 1 AND 1000),
  redemption_count   integer NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  active             boolean NOT NULL DEFAULT true,
  expires_at         timestamptz,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_access_codes_redemption_limit CHECK (
    redemption_count <= max_redemptions
  )
);

CREATE INDEX merchant_access_codes_active_idx
  ON merchant_access_codes (active, expires_at, created_at DESC);
CREATE TRIGGER merchant_access_codes_updated_at
  BEFORE UPDATE ON merchant_access_codes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE merchant_access_code_redemptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_code_id      uuid NOT NULL REFERENCES merchant_access_codes(id) ON DELETE RESTRICT,
  venue_id             integer NOT NULL CHECK (venue_id > 0),
  redeemed_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  access_starts_at     timestamptz NOT NULL,
  access_ends_at       timestamptz NOT NULL,
  redeemed_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (access_code_id, venue_id),
  CONSTRAINT merchant_access_code_redemptions_window CHECK (
    access_ends_at > access_starts_at
  )
);

CREATE INDEX merchant_access_code_redemptions_venue_idx
  ON merchant_access_code_redemptions (venue_id, redeemed_at DESC);

CREATE TABLE merchant_entitlements (
  venue_id             integer PRIMARY KEY CHECK (venue_id > 0),
  source               text NOT NULL CHECK (source IN (
    'legacy_paid', 'admin_grant', 'access_code', 'billing'
  )),
  access_starts_at     timestamptz NOT NULL DEFAULT now(),
  access_ends_at       timestamptz,
  code_redemption_id   uuid REFERENCES merchant_access_code_redemptions(id) ON DELETE SET NULL,
  granted_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_entitlements_window CHECK (
    access_ends_at IS NULL OR access_ends_at > access_starts_at
  ),
  CONSTRAINT merchant_entitlements_code_source CHECK (
    (source = 'access_code') = (code_redemption_id IS NOT NULL)
  )
);

CREATE INDEX merchant_entitlements_active_idx
  ON merchant_entitlements (access_ends_at, venue_id);
CREATE TRIGGER merchant_entitlements_updated_at
  BEFORE UPDATE ON merchant_entitlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Preserve the meaning of pre-existing paid claims without forcing an admin
-- to grant them again after this migration.
INSERT INTO merchant_entitlements (
  venue_id, source, access_starts_at, access_ends_at
)
SELECT venue_id, 'legacy_paid', created_at, NULL
FROM venue_claims
WHERE status = 'verified' AND plan = 'paid'
ON CONFLICT (venue_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Merchant-facing event stream
-- ---------------------------------------------------------------------------

CREATE TABLE merchant_analytics_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name            text NOT NULL CHECK (event_name IN (
    'venue_page_view',
    'website_click',
    'call_click',
    'directions_click',
    'save',
    'unsave',
    'share',
    'follow',
    'unfollow',
    'alert_subscribe',
    'alert_unsubscribe',
    'promotion_view',
    'promotion_click',
    'campaign_launch',
    'campaign_pause',
    'campaign_end',
    'export_generated',
    'report_email_sent'
  )),
  venue_id              integer NOT NULL CHECK (venue_id > 0),
  -- Snapshot the controlling owner so future ownership transfers never mix
  -- two merchant accounts in a single historical export.
  venue_owner_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  promotion_id          uuid,
  user_id               uuid REFERENCES users(id) ON DELETE SET NULL,
  visitor_id            uuid,
  visit_id              uuid,
  authenticated         boolean NOT NULL DEFAULT false,
  source                text NOT NULL DEFAULT 'venue_page' CHECK (char_length(source) <= 80),
  device_type           text NOT NULL DEFAULT 'unknown'
                        CHECK (device_type IN ('mobile', 'tablet', 'desktop', 'unknown')),
  properties            jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_analytics_events_promotion_venue_fk
    FOREIGN KEY (promotion_id, venue_id)
    REFERENCES promotion_campaigns (id, venue_id)
    ON DELETE RESTRICT,
  CONSTRAINT merchant_analytics_events_public_identity CHECK (
    event_name IN ('campaign_launch', 'campaign_pause', 'campaign_end', 'export_generated', 'report_email_sent')
    OR visitor_id IS NOT NULL
  )
);

CREATE INDEX merchant_analytics_events_venue_occurred_idx
  ON merchant_analytics_events (venue_id, occurred_at DESC, event_name);
CREATE INDEX merchant_analytics_events_owner_occurred_idx
  ON merchant_analytics_events (venue_owner_user_id, occurred_at DESC)
  WHERE venue_owner_user_id IS NOT NULL;
CREATE INDEX merchant_analytics_events_promotion_occurred_idx
  ON merchant_analytics_events (promotion_id, occurred_at DESC, event_name)
  WHERE promotion_id IS NOT NULL;
CREATE INDEX merchant_analytics_events_visitor_occurred_idx
  ON merchant_analytics_events (visitor_id, occurred_at DESC)
  WHERE visitor_id IS NOT NULL;
CREATE INDEX merchant_analytics_events_visit_occurred_idx
  ON merchant_analytics_events (visit_id, occurred_at DESC)
  WHERE visit_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Scheduled weekly/monthly email reports and delivery audit trail
-- ---------------------------------------------------------------------------

CREATE TABLE merchant_report_schedules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id          integer NOT NULL CHECK (venue_id > 0),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_email   text NOT NULL CHECK (position('@' IN recipient_email) > 1),
  frequency         text NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  day_of_week       smallint NOT NULL DEFAULT 1 CHECK (day_of_week BETWEEN 0 AND 6),
  day_of_month      smallint NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 28),
  send_hour_local   smallint NOT NULL DEFAULT 8 CHECK (send_hour_local BETWEEN 0 AND 23),
  timezone          text NOT NULL DEFAULT 'America/Los_Angeles'
                    CHECK (timezone = 'America/Los_Angeles'),
  enabled           boolean NOT NULL DEFAULT true,
  next_send_at      timestamptz NOT NULL,
  last_sent_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, user_id)
);

CREATE INDEX merchant_report_schedules_due_idx
  ON merchant_report_schedules (next_send_at, id)
  WHERE enabled;
CREATE TRIGGER merchant_report_schedules_updated_at
  BEFORE UPDATE ON merchant_report_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE merchant_report_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id       uuid REFERENCES merchant_report_schedules(id) ON DELETE SET NULL,
  venue_id          integer NOT NULL CHECK (venue_id > 0),
  recipient_email   text NOT NULL,
  range_starts_at   timestamptz NOT NULL,
  range_ends_at     timestamptz NOT NULL,
  status            text NOT NULL CHECK (status IN ('sent', 'simulated', 'failed')),
  provider_error    text NOT NULL DEFAULT '' CHECK (char_length(provider_error) <= 500),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_report_deliveries_range CHECK (range_ends_at > range_starts_at)
);

CREATE INDEX merchant_report_deliveries_venue_created_idx
  ON merchant_report_deliveries (venue_id, created_at DESC);
