-- Canonical, collaborative happy-hour lists. Existing saved_spots remain the
-- personal Favorites / Want to try / Been to experience; these tables add
-- multiple named lists without changing that compatibility surface.

CREATE TABLE happy_hour_lists (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description   text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  visibility    text NOT NULL DEFAULT 'private'
                  CHECK (visibility IN ('private', 'unlisted', 'public')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX happy_hour_lists_owner_idx
  ON happy_hour_lists (owner_user_id, updated_at DESC);
CREATE INDEX happy_hour_lists_visibility_idx
  ON happy_hour_lists (visibility, updated_at DESC)
  WHERE visibility <> 'private';
CREATE TRIGGER happy_hour_lists_updated_at BEFORE UPDATE ON happy_hour_lists
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE happy_hour_list_members (
  list_id          uuid NOT NULL REFERENCES happy_hour_lists(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, user_id)
);

CREATE INDEX happy_hour_list_members_user_idx
  ON happy_hour_list_members (user_id, updated_at DESC);
CREATE TRIGGER happy_hour_list_members_updated_at BEFORE UPDATE ON happy_hour_list_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE happy_hour_list_items (
  list_id          uuid NOT NULL REFERENCES happy_hour_lists(id) ON DELETE CASCADE,
  venue_id         integer NOT NULL CHECK (venue_id > 0),
  added_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, venue_id)
);

CREATE INDEX happy_hour_list_items_list_idx
  ON happy_hour_list_items (list_id, created_at DESC);

-- Tokens are stored only as SHA-256 hashes. email IS NULL represents a
-- reusable-by-recipient link invite; a non-null email binds acceptance to
-- that account while still allowing the recipient to preview the list.
CREATE TABLE happy_hour_list_invites (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id            uuid NOT NULL REFERENCES happy_hour_lists(id) ON DELETE CASCADE,
  email               text,
  role                text NOT NULL CHECK (role IN ('editor', 'viewer')),
  token_hash          text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  invited_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at          timestamptz NOT NULL,
  accepted_at         timestamptz,
  accepted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT happy_hour_list_invites_terminal_once CHECK (
    accepted_at IS NULL OR revoked_at IS NULL
  )
);

CREATE INDEX happy_hour_list_invites_email_idx
  ON happy_hour_list_invites (lower(email), expires_at DESC)
  WHERE email IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX happy_hour_list_invites_pending_email_unique
  ON happy_hour_list_invites (list_id, lower(email))
  WHERE email IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX happy_hour_list_invites_list_idx
  ON happy_hour_list_invites (list_id, created_at DESC);
CREATE TRIGGER happy_hour_list_invites_updated_at BEFORE UPDATE ON happy_hour_list_invites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- This doubles as a lightweight analytics stream and a useful future-facing
-- audit trail. Only the small set of product events below is recorded.
CREATE TABLE happy_hour_list_activity (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id       uuid NOT NULL REFERENCES happy_hour_lists(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type    text NOT NULL CHECK (event_type IN (
    'list_created',
    'list_renamed',
    'venue_added_to_list',
    'venue_removed_from_list',
    'list_shared',
    'share_link_copied',
    'invite_accepted',
    'shared_list_viewed'
  )),
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX happy_hour_list_activity_list_idx
  ON happy_hour_list_activity (list_id, created_at DESC);
CREATE INDEX happy_hour_list_activity_event_idx
  ON happy_hour_list_activity (event_type, created_at DESC);
