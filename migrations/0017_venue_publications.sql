-- Approval to put a venue on the public site.
--
-- Deliberately separate from venue_claims. A claim answers "does this person
-- run this venue?"; this answers "should this venue appear on the site?".
-- They're usually decided together but not always, and only venues the data
-- pipeline couldn't substantiate (listingStatus 'unlisted' in happy-hours.json)
-- need a row here at all — the rest are visible on their own evidence.
--
-- `source` records which route cleared it, because they carry different
-- weight:
--
--   domain — the claimant signed in with an email on the venue's own domain
--   phone  — the claimant entered a code texted to the venue's listed number
--   admin  — someone here reviewed a manually submitted claim
--
-- The first two are proof of ownership strong enough to publish without
-- waiting for a human; the third is the review queue at /admin/restaurants/.

CREATE TABLE venue_publications (
  venue_id            integer PRIMARY KEY CHECK (venue_id > 0),
  source              text NOT NULL CHECK (source IN ('domain', 'phone', 'admin')),
  -- The claimant for self-verified routes, the reviewing admin for 'admin'.
  approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  note                text NOT NULL DEFAULT '',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER venue_publications_updated_at
  BEFORE UPDATE ON venue_publications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
