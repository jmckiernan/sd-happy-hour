-- Foundation for the Live Promotions redesign.
--
-- This migration is deliberately additive. The venue-keyed `promotions`,
-- `live_overrides`, and `notification_log` tables remain intact while the
-- application moves to promotion campaigns and event-based delivery.

-- ---------------------------------------------------------------------------
-- Promotion campaigns
-- ---------------------------------------------------------------------------

CREATE TABLE promotion_campaigns (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id                    integer NOT NULL CHECK (venue_id > 0),
  type                        text NOT NULL DEFAULT 'special_deal'
                              CHECK (type IN ('special_deal', 'extended_happy_hour', 'event', 'other')),
  -- Drafts may be incomplete. Publishing is the point at which a nonblank
  -- headline and a complete, valid time window become mandatory.
  title                       text,
  description                 text NOT NULL DEFAULT '',
  deal_code                   text,
  starts_at                   timestamptz,
  ends_at                     timestamptz,
  created_by_user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at                timestamptz,
  ended_at                    timestamptz,
  cancelled_at                timestamptz,
  -- Links an imported draft to the old one-row-per-venue record without
  -- making legacy storage part of the new runtime model.
  legacy_promotion_venue_id   integer UNIQUE,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotion_campaigns_id_venue_key UNIQUE (id, venue_id),
  CONSTRAINT promotion_campaigns_time_window CHECK (
    (starts_at IS NULL AND ends_at IS NULL)
    OR (
      starts_at IS NOT NULL
      AND ends_at IS NOT NULL
      AND ends_at > starts_at
      AND ends_at - starts_at <= interval '24 hours'
    )
  ),
  CONSTRAINT promotion_campaigns_published_complete CHECK (
    published_at IS NULL OR (
      title IS NOT NULL
      AND btrim(title) <> ''
      AND starts_at IS NOT NULL
      AND ends_at IS NOT NULL
      AND ends_at > starts_at
    )
  ),
  CONSTRAINT promotion_campaigns_terminal_state CHECK (
    ended_at IS NULL OR cancelled_at IS NULL
  ),
  CONSTRAINT promotion_campaigns_terminal_published CHECK (
    (ended_at IS NULL OR published_at IS NOT NULL)
    AND (cancelled_at IS NULL OR published_at IS NOT NULL)
  )
);

CREATE INDEX promotion_campaigns_venue_created_idx
  ON promotion_campaigns (venue_id, created_at DESC);
-- This is intentionally a lookup index, not an overlap exclusion. Phase 2
-- owns transactional overlap/concurrency enforcement in the promotion service.
CREATE INDEX promotion_campaigns_active_window_idx
  ON promotion_campaigns (venue_id, starts_at, ends_at)
  WHERE published_at IS NOT NULL AND ended_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX promotion_campaigns_created_by_idx
  ON promotion_campaigns (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE TRIGGER promotion_campaigns_updated_at
  BEFORE UPDATE ON promotion_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Existing venue-keyed promotions have no trustworthy title, creator, or
-- timing. Preserve their offer text/code verbatim and import them as incomplete
-- drafts; merchants can finish and publish them through the new workflow.
INSERT INTO promotion_campaigns (
  venue_id,
  type,
  title,
  description,
  deal_code,
  legacy_promotion_venue_id,
  created_at,
  updated_at
)
SELECT
  venue_id,
  'special_deal',
  NULL,
  description,
  deal_code,
  venue_id,
  updated_at,
  updated_at
FROM promotions
WHERE true
ON CONFLICT (legacy_promotion_venue_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Saved-alert content preferences
-- ---------------------------------------------------------------------------

ALTER TABLE alerts
  ADD COLUMN alert_kinds text[] NOT NULL DEFAULT ARRAY['happy_hour']::text[],
  ADD CONSTRAINT alerts_alert_kinds_valid CHECK (
    alert_kinds = ARRAY['happy_hour']::text[]
    OR alert_kinds = ARRAY['promotion']::text[]
    OR alert_kinds = ARRAY['happy_hour', 'promotion']::text[]
  );

-- ---------------------------------------------------------------------------
-- Venue follows (separate from saved_spots)
-- ---------------------------------------------------------------------------

CREATE TABLE venue_follows (
  user_id                     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_id                    integer NOT NULL CHECK (venue_id > 0),
  happy_hour_alerts_enabled   boolean NOT NULL DEFAULT false,
  promotion_alerts_enabled    boolean NOT NULL DEFAULT true,
  channel_email               boolean NOT NULL DEFAULT true,
  channel_text                boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, venue_id)
);

CREATE INDEX venue_follows_venue_idx ON venue_follows (venue_id);
CREATE INDEX venue_follows_happy_hour_idx
  ON venue_follows (venue_id)
  WHERE happy_hour_alerts_enabled;
CREATE INDEX venue_follows_promotion_idx
  ON venue_follows (venue_id)
  WHERE promotion_alerts_enabled;

CREATE TRIGGER venue_follows_updated_at
  BEFORE UPDATE ON venue_follows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Notification-worthy events and per-recipient delivery deduplication
-- ---------------------------------------------------------------------------

CREATE TABLE notification_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key     text NOT NULL UNIQUE CHECK (btrim(event_key) <> ''),
  event_type    text NOT NULL CHECK (event_type IN ('happy_hour_started', 'promotion_started')),
  venue_id      integer NOT NULL CHECK (venue_id > 0),
  promotion_id  uuid,
  available_at  timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  cancelled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_events_window CHECK (expires_at > available_at),
  CONSTRAINT notification_events_subject CHECK (
    (event_type = 'happy_hour_started' AND promotion_id IS NULL)
    OR (event_type = 'promotion_started' AND promotion_id IS NOT NULL)
  ),
  CONSTRAINT notification_events_promotion_venue_fk
    FOREIGN KEY (promotion_id, venue_id)
    REFERENCES promotion_campaigns (id, venue_id)
    ON DELETE RESTRICT
);

CREATE INDEX notification_events_available_idx
  ON notification_events (available_at, expires_at)
  WHERE cancelled_at IS NULL;
CREATE UNIQUE INDEX notification_events_promotion_started_unique
  ON notification_events (promotion_id)
  WHERE event_type = 'promotion_started';

CREATE TRIGGER notification_events_updated_at
  BEFORE UPDATE ON notification_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notification_deliveries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel               text NOT NULL CHECK (channel IN ('email', 'text')),
  distribution_source   text NOT NULL
                        CHECK (distribution_source IN ('organic_follow', 'saved_alert', 'paid_boost')),
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempt_count         integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at       timestamptz DEFAULT now(),
  lease_expires_at      timestamptz,
  batch_id              uuid,
  sent_at               timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id, channel),
  CONSTRAINT notification_deliveries_lease_state CHECK (
    (status = 'sending') = (lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT notification_deliveries_pending_schedule CHECK (
    status <> 'pending' OR next_attempt_at IS NOT NULL
  ),
  CONSTRAINT notification_deliveries_attempt_progress CHECK (
    status = 'pending' OR attempt_count > 0
  ),
  CONSTRAINT notification_deliveries_sent_timestamp CHECK (
    (status = 'sent') = (sent_at IS NOT NULL)
  ),
  CONSTRAINT notification_deliveries_sent_text_batch CHECK (
    channel <> 'text' OR status <> 'sent' OR batch_id IS NOT NULL
  )
);

CREATE INDEX notification_deliveries_ready_idx
  ON notification_deliveries (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX notification_deliveries_lease_idx
  ON notification_deliveries (lease_expires_at)
  WHERE status = 'sending';
CREATE INDEX notification_deliveries_sms_cap_idx
  ON notification_deliveries (user_id, sent_at DESC, batch_id)
  WHERE channel = 'text' AND status = 'sent';

CREATE TRIGGER notification_deliveries_updated_at
  BEFORE UPDATE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
