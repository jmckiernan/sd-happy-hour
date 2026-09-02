-- Drop accidental placeholder strings saved as real comment/note body copy
-- during early list-feedback UI testing ("comment here", "note here").

UPDATE user_venue_feedback
SET comment = ''
WHERE lower(btrim(comment)) IN ('comment here', 'note here');

DELETE FROM user_venue_feedback
WHERE rating IS NULL AND btrim(comment) = '';

DELETE FROM happy_hour_list_item_notes
WHERE lower(btrim(note)) IN ('comment here', 'note here');
