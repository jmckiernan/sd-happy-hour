-- Distinguish brand-new venue submissions from corrections to existing venues.
-- Set at insert time; approval paths also set it explicitly for clarity.

ALTER TABLE submissions
  ADD COLUMN submission_kind text
    CHECK (submission_kind IN ('new', 'update'));

-- Pending/denied rows still carry the submit-time target venue id when present.
UPDATE submissions
SET submission_kind = CASE
  WHEN approved_listing_id IS NOT NULL THEN 'update'
  ELSE 'new'
END
WHERE status IN ('pending', 'denied');

-- Approved rows: earliest approval per venue is treated as the original listing;
-- later approvals for the same venue are updates.
WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY approved_listing_id
      ORDER BY updated_at ASC, created_at ASC
    ) AS rn
  FROM submissions
  WHERE status = 'approved'
    AND approved_listing_id IS NOT NULL
)
UPDATE submissions s
SET submission_kind = CASE WHEN r.rn = 1 THEN 'new' ELSE 'update' END
FROM ranked r
WHERE s.id = r.id;

UPDATE submissions SET submission_kind = 'new' WHERE submission_kind IS NULL;

ALTER TABLE submissions
  ALTER COLUMN submission_kind SET NOT NULL;
