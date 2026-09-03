-- When a claim became verified — distinct from updated_at, which also moves on
-- plan changes, reporting grants, and other admin touch-ups.

ALTER TABLE venue_claims
  ADD COLUMN verified_at timestamptz;

UPDATE venue_claims
SET verified_at = updated_at
WHERE status = 'verified' AND verified_at IS NULL;

CREATE INDEX venue_claims_verified_at_idx
  ON venue_claims (verified_at DESC)
  WHERE status = 'verified';
