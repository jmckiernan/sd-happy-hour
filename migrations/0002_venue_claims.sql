-- Restaurant sign-in redesign (2026-08-12 design discussion). The old
-- `restaurants` table was a fully separate account (own email/password,
-- own login) that let anyone self-report a name/website/email, get
-- "verified" against their own say-so, and then claim ANY venue_id in
-- happy-hours.json with no check that they actually run that specific
-- venue. This migration fixes both problems:
--
--   1. Restaurants no longer have a separate login. They sign in as
--      regular users (Google), same as everyone else — see the removal of
--      `sessions.restaurant_id` below.
--   2. Verification is now scoped to the specific venue being claimed
--      (domain match is checked against *that venue's* website, not a
--      self-reported one), and venue_claims_verified_venue_unique makes
--      "verified" mean something: only one verified claimant per venue.

-- Sessions never use role='restaurant' anymore. Drop the now-orphaned
-- column and the constraint that referenced it; leave the role CHECK
-- itself alone rather than guess its auto-generated name — 'restaurant'
-- just becomes an unused value.
ALTER TABLE sessions DROP CONSTRAINT sessions_subject;
ALTER TABLE sessions DROP COLUMN restaurant_id;

DROP TABLE restaurants;

CREATE TABLE venue_claims (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_id              integer NOT NULL CHECK (venue_id > 0),
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('verified', 'pending', 'denied')),
  verification_method   text CHECK (verification_method IN ('domain', 'phone', 'manual')),
  -- Reserved for phone verification once venue listings carry a phone
  -- number to text a code to (happy-hours.json doesn't yet — see the
  -- 2026-08-12 discussion). Unused today; not a mistake to leave nullable.
  phone                 text NOT NULL DEFAULT '',
  phone_code            text,
  phone_code_expires_at timestamptz,
  phone_verified_at     timestamptz,
  claim_note            text NOT NULL DEFAULT '',
  denial_reason         text,
  plan                  text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'paid')),
  sms_funding_enabled   boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- One claim record per (user, venue) — resubmitting after a denial
  -- updates this row rather than creating a new one.
  UNIQUE (user_id, venue_id)
);

CREATE INDEX venue_claims_user_id_idx ON venue_claims (user_id);
CREATE INDEX venue_claims_venue_id_idx ON venue_claims (venue_id);

-- The actual fix for "claim any venue you want": at most one verified
-- claimant per venue at a time. Domain/phone/manual verification all funnel
-- through the same status column, so this holds regardless of method.
CREATE UNIQUE INDEX venue_claims_verified_venue_unique ON venue_claims (venue_id)
  WHERE status = 'verified';

CREATE TRIGGER venue_claims_updated_at BEFORE UPDATE ON venue_claims
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
