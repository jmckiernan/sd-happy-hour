-- Make collaborative lists the canonical saved-venue model. The legacy
-- saved_spots table is intentionally retained (but no longer written by the
-- application) for one-release rollback safety.

ALTER TABLE happy_hour_lists
  ADD COLUMN system_key text
    CHECK (system_key IN ('favorites', 'want_to_try', 'been_to')),
  ADD COLUMN ratings_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN comments_enabled boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX happy_hour_lists_owner_system_key_unique
  ON happy_hour_lists (owner_user_id, system_key)
  WHERE system_key IS NOT NULL;

ALTER TABLE happy_hour_lists
  ADD CONSTRAINT happy_hour_lists_system_settings CHECK (
    system_key IS NULL
    OR (system_key = 'favorites' AND title = 'Favorites' AND ratings_enabled)
    OR (system_key = 'want_to_try' AND title = 'Want to Try' AND NOT ratings_enabled)
    OR (system_key = 'been_to' AND title = 'Been To' AND ratings_enabled)
  );

-- Every account owns exactly one of each protected built-in list. Existing
-- custom lists are left untouched and count toward the new ten-owned-list cap.
INSERT INTO happy_hour_lists (
  owner_user_id, title, description, system_key,
  ratings_enabled, comments_enabled
)
SELECT users.id, builtins.title, '', builtins.system_key,
       builtins.ratings_enabled, true
FROM users
CROSS JOIN (VALUES
  ('favorites'::text, 'Favorites'::text, true),
  ('want_to_try'::text, 'Want to Try'::text, false),
  ('been_to'::text, 'Been To'::text, true)
) AS builtins(system_key, title, ratings_enabled)
ON CONFLICT (owner_user_id, system_key) WHERE system_key IS NOT NULL DO NOTHING;

ALTER TABLE users
  ADD COLUMN default_list_id uuid
    REFERENCES happy_hour_lists(id) ON DELETE SET NULL;

UPDATE users
SET default_list_id = lists.id
FROM happy_hour_lists lists
WHERE lists.owner_user_id = users.id
  AND lists.system_key = 'favorites'
  AND users.default_list_id IS NULL;

CREATE INDEX users_default_list_idx ON users (default_list_id)
  WHERE default_list_id IS NOT NULL;

-- A venue remains one canonical item in a list. Ratings/comments are
-- attributed contributions so collaborators never overwrite one another.
CREATE TABLE happy_hour_list_item_feedback (
  list_id    uuid NOT NULL,
  venue_id   integer NOT NULL CHECK (venue_id > 0),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     smallint CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  comment    text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, venue_id, user_id),
  FOREIGN KEY (list_id, venue_id)
    REFERENCES happy_hour_list_items(list_id, venue_id) ON DELETE CASCADE,
  CONSTRAINT happy_hour_list_item_feedback_has_content CHECK (
    rating IS NOT NULL OR btrim(comment) <> ''
  )
);

CREATE INDEX happy_hour_list_item_feedback_user_idx
  ON happy_hour_list_item_feedback (user_id, updated_at DESC);
CREATE TRIGGER happy_hour_list_item_feedback_updated_at
  BEFORE UPDATE ON happy_hour_list_item_feedback
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Copy every legacy saved venue to the matching protected list.
INSERT INTO happy_hour_list_items (
  list_id, venue_id, added_by_user_id, created_at
)
SELECT lists.id, spots.venue_id, spots.user_id, spots.created_at
FROM saved_spots spots
JOIN happy_hour_lists lists
  ON lists.owner_user_id = spots.user_id
 AND lists.system_key = CASE spots.status
   WHEN 'favorite' THEN 'favorites'
   WHEN 'want-to-try' THEN 'want_to_try'
   WHEN 'been-to' THEN 'been_to'
 END
ON CONFLICT (list_id, venue_id) DO NOTHING;

INSERT INTO happy_hour_list_item_feedback (
  list_id, venue_id, user_id, rating, comment, created_at, updated_at
)
SELECT lists.id, spots.venue_id, spots.user_id,
       CASE WHEN spots.status = 'want-to-try' THEN NULL ELSE spots.rating END,
       spots.note,
       spots.created_at, spots.updated_at
FROM saved_spots spots
JOIN happy_hour_lists lists
  ON lists.owner_user_id = spots.user_id
 AND lists.system_key = CASE spots.status
   WHEN 'favorite' THEN 'favorites'
   WHEN 'want-to-try' THEN 'want_to_try'
   WHEN 'been-to' THEN 'been_to'
 END
WHERE (spots.status <> 'want-to-try' AND spots.rating IS NOT NULL)
   OR btrim(spots.note) <> ''
ON CONFLICT (list_id, venue_id, user_id) DO UPDATE SET
  rating = EXCLUDED.rating,
  comment = EXCLUDED.comment,
  updated_at = EXCLUDED.updated_at;

-- Alert preferences belong to the subscriber, never to the shared list.
-- Absence of a row means alerts are off for that user/list pair.
CREATE TABLE happy_hour_list_subscriptions (
  list_id                    uuid NOT NULL REFERENCES happy_hour_lists(id) ON DELETE CASCADE,
  user_id                    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  happy_hour_alerts_enabled  boolean NOT NULL DEFAULT true,
  live_deal_alerts_enabled   boolean NOT NULL DEFAULT false,
  channel_email              boolean NOT NULL DEFAULT true,
  channel_text               boolean NOT NULL DEFAULT false,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, user_id),
  CONSTRAINT happy_hour_list_subscriptions_kind CHECK (
    happy_hour_alerts_enabled OR live_deal_alerts_enabled
  ),
  CONSTRAINT happy_hour_list_subscriptions_channel CHECK (
    channel_email OR channel_text
  )
);

CREATE INDEX happy_hour_list_subscriptions_dispatch_idx
  ON happy_hour_list_subscriptions (user_id, list_id);
CREATE TRIGGER happy_hour_list_subscriptions_updated_at
  BEFORE UPDATE ON happy_hour_list_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Record the additional list actions in the existing lightweight activity
-- stream used for analytics and audit history.
ALTER TABLE happy_hour_list_activity
  DROP CONSTRAINT happy_hour_list_activity_event_type_check,
  ADD CONSTRAINT happy_hour_list_activity_event_type_check CHECK (event_type IN (
    'list_created',
    'list_renamed',
    'venue_added_to_list',
    'venue_removed_from_list',
    'list_shared',
    'share_link_copied',
    'invite_accepted',
    'shared_list_viewed',
    'list_settings_updated',
    'venue_feedback_updated',
    'default_list_changed',
    'list_alerts_updated'
  ));

-- Promotion alerts are event-based, unlike the three-hour happy-hour
-- cooldown. These fields let the dispatcher deduplicate each live-deal event
-- without conflating it with a happy-hour notification for the same venue.
ALTER TABLE notification_log
  ADD COLUMN notification_kind text NOT NULL DEFAULT 'happy_hour'
    CHECK (notification_kind IN ('happy_hour', 'promotion')),
  ADD COLUMN event_key text;

CREATE INDEX notification_log_event_dedup_idx
  ON notification_log (user_id, notification_kind, event_key, channel)
  WHERE event_key IS NOT NULL;
