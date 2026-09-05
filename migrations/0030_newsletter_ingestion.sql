-- Inbound venue newsletters. Subscription discovery/sign-up automation owns
-- newsletter_subscriptions; the inbound email webhook records each provider
-- message exactly once before handing extracted first-party links to the
-- existing content engine.

CREATE TABLE newsletter_subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id              integer CHECK (venue_id IS NULL OR venue_id > 0),
  publisher_name        text NOT NULL CHECK (btrim(publisher_name) <> ''),
  subscriber_email      text NOT NULL CHECK (btrim(subscriber_email) <> ''),
  website_url           text NOT NULL CHECK (website_url ~* '^https?://'),
  signup_url            text CHECK (signup_url IS NULL OR signup_url ~* '^https?://'),
  sender_email          text,
  sender_domain         text,
  allowed_link_domains  jsonb NOT NULL DEFAULT '[]'::jsonb
                          CHECK (jsonb_typeof(allowed_link_domains) = 'array'),
  content_source_id     uuid REFERENCES content_sources(id) ON DELETE RESTRICT,
  status                text NOT NULL DEFAULT 'discovered'
                          CHECK (status IN (
                            'discovered', 'signup_pending', 'confirmation_pending',
                            'active', 'unsubscribed', 'failed'
                          )),
  confirmation_status   text NOT NULL DEFAULT 'not_requested'
                          CHECK (confirmation_status IN (
                            'not_requested', 'pending', 'confirmed', 'manual_required', 'failed'
                          )),
  confirmation_sent_at  timestamptz,
  confirmed_at          timestamptz,
  last_message_at       timestamptz,
  last_error            text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_subscriptions_sender CHECK (
    sender_email IS NULL OR btrim(sender_email) <> ''
  ),
  CONSTRAINT newsletter_subscriptions_domain CHECK (
    sender_domain IS NULL OR (
      btrim(sender_domain) <> '' AND sender_domain !~ '[/@:]'
    )
  ),
  CONSTRAINT newsletter_subscriptions_active_ready CHECK (
    status <> 'active' OR content_source_id IS NOT NULL
  ),
  UNIQUE (publisher_name, website_url)
);

CREATE INDEX newsletter_subscriptions_status_idx
  ON newsletter_subscriptions (status, publisher_name);
CREATE UNIQUE INDEX newsletter_subscriptions_subscriber_email_idx
  ON newsletter_subscriptions (lower(subscriber_email));
CREATE INDEX newsletter_subscriptions_sender_email_idx
  ON newsletter_subscriptions (lower(sender_email)) WHERE sender_email IS NOT NULL;
CREATE INDEX newsletter_subscriptions_sender_domain_idx
  ON newsletter_subscriptions (lower(sender_domain)) WHERE sender_domain IS NOT NULL;
CREATE INDEX newsletter_subscriptions_source_idx
  ON newsletter_subscriptions (content_source_id) WHERE content_source_id IS NOT NULL;
CREATE TRIGGER newsletter_subscriptions_updated_at
  BEFORE UPDATE ON newsletter_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE newsletter_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id      uuid NOT NULL REFERENCES newsletter_subscriptions(id) ON DELETE RESTRICT,
  content_source_id    uuid REFERENCES content_sources(id) ON DELETE RESTRICT,
  resend_event_id      text NOT NULL CHECK (
                         btrim(resend_event_id) <> '' AND length(resend_event_id) <= 300
                       ),
  resend_email_id      text NOT NULL CHECK (
                         btrim(resend_email_id) <> '' AND length(resend_email_id) <= 300
                       ),
  payload_sha256       text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  sender_email         text NOT NULL CHECK (btrim(sender_email) <> ''),
  subject              text NOT NULL DEFAULT '',
  sent_at              timestamptz,
  message_type         text NOT NULL DEFAULT 'newsletter'
                         CHECK (message_type IN ('newsletter', 'confirmation')),
  status               text NOT NULL DEFAULT 'processing'
                         CHECK (status IN (
                           'processing', 'processed', 'ignored',
                           'confirmation_handled', 'manual_required', 'failed'
                         )),
  extracted_item_count integer NOT NULL DEFAULT 0 CHECK (extracted_item_count >= 0),
  ingestion_run_id     uuid REFERENCES content_ingestion_runs(id) ON DELETE SET NULL,
  last_error           text,
  received_at          timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz,
  UNIQUE (resend_event_id),
  UNIQUE (resend_email_id)
);

CREATE INDEX newsletter_messages_subscription_received_idx
  ON newsletter_messages (subscription_id, received_at DESC);
CREATE INDEX newsletter_messages_status_received_idx
  ON newsletter_messages (status, received_at DESC);

COMMENT ON COLUMN newsletter_subscriptions.allowed_link_domains IS
  'Additional first-party publisher domains permitted as supporting links; website_url is always permitted.';
COMMENT ON COLUMN newsletter_messages.payload_sha256 IS
  'Audit fingerprint only. Newsletter body text and HTML are intentionally not retained here.';
