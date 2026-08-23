-- Delegated restaurant access. The single verified venue_claim remains the
-- owner; these rows grant narrower access without weakening claim ownership.

CREATE TABLE venue_managers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id                 integer NOT NULL CHECK (venue_id > 0),
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                     text NOT NULL CHECK (role IN ('full_admin', 'promotions')),
  added_by_owner_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, user_id)
);

CREATE INDEX venue_managers_user_idx ON venue_managers (user_id, venue_id);
CREATE TRIGGER venue_managers_updated_at BEFORE UPDATE ON venue_managers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE venue_manager_invites (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id                 integer NOT NULL CHECK (venue_id > 0),
  email                    text NOT NULL,
  role                     text NOT NULL CHECK (role IN ('full_admin', 'promotions')),
  token_hash               text NOT NULL UNIQUE,
  invited_by_owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at               timestamptz NOT NULL,
  accepted_at              timestamptz,
  revoked_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venue_manager_invites_terminal_once CHECK (
    accepted_at IS NULL OR revoked_at IS NULL
  )
);

CREATE UNIQUE INDEX venue_manager_invites_pending_unique
  ON venue_manager_invites (venue_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX venue_manager_invites_email_idx ON venue_manager_invites (lower(email), expires_at);
CREATE TRIGGER venue_manager_invites_updated_at BEFORE UPDATE ON venue_manager_invites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
