-- Collapse list-scoped ratings/comments into one global row per user×venue.
-- List "enable comments" stays a visibility/collection toggle; star ratings are
-- always global. Optional list notes stay list-scoped so trip text does not sync.

CREATE TABLE user_venue_feedback (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_id   integer NOT NULL CHECK (venue_id > 0),
  rating     smallint CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  comment    text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, venue_id),
  CONSTRAINT user_venue_feedback_has_content CHECK (
    rating IS NOT NULL OR btrim(comment) <> ''
  )
);

CREATE INDEX user_venue_feedback_venue_idx
  ON user_venue_feedback (venue_id, updated_at DESC);
CREATE TRIGGER user_venue_feedback_updated_at
  BEFORE UPDATE ON user_venue_feedback
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per collaborator, independently: latest rating wins; prefer a non-empty comment.
INSERT INTO user_venue_feedback (
  user_id, venue_id, rating, comment, created_at, updated_at
)
SELECT
  feedback.user_id,
  feedback.venue_id,
  (array_agg(feedback.rating ORDER BY feedback.updated_at DESC))[1] AS rating,
  COALESCE(
    (array_agg(feedback.comment ORDER BY feedback.updated_at DESC)
      FILTER (WHERE btrim(feedback.comment) <> ''))[1],
    ''
  ) AS comment,
  min(feedback.created_at) AS created_at,
  max(feedback.updated_at) AS updated_at
FROM happy_hour_list_item_feedback feedback
GROUP BY feedback.user_id, feedback.venue_id
HAVING
  (array_agg(feedback.rating ORDER BY feedback.updated_at DESC))[1] IS NOT NULL
  OR COALESCE(
    (array_agg(feedback.comment ORDER BY feedback.updated_at DESC)
      FILTER (WHERE btrim(feedback.comment) <> ''))[1],
    ''
  ) <> '';

-- Trip/planning text that must not sync across lists. Removing a venue from a
-- list deletes these notes (FK cascade) but never touches user_venue_feedback.
CREATE TABLE happy_hour_list_item_notes (
  list_id    uuid NOT NULL,
  venue_id   integer NOT NULL CHECK (venue_id > 0),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note       text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, venue_id, user_id),
  FOREIGN KEY (list_id, venue_id)
    REFERENCES happy_hour_list_items(list_id, venue_id) ON DELETE CASCADE,
  CONSTRAINT happy_hour_list_item_notes_has_content CHECK (btrim(note) <> '')
);

CREATE INDEX happy_hour_list_item_notes_user_idx
  ON happy_hour_list_item_notes (user_id, updated_at DESC);
CREATE TRIGGER happy_hour_list_item_notes_updated_at
  BEFORE UPDATE ON happy_hour_list_item_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Legacy list-scoped feedback rows are retained unread for one-release rollback.
-- Application code reads and writes user_venue_feedback + happy_hour_list_item_notes.
