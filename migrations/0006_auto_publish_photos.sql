-- Owner photos no longer require manual approval. Clearly unsafe uploads are
-- rejected before a row is created; sanitized uploads publish immediately.
-- Release any photos held by the previous fail-closed moderation workflow.
UPDATE venue_photos
SET status = 'published', updated_at = now()
WHERE status = 'in_review';

ALTER TABLE venue_photos
  ALTER COLUMN status SET DEFAULT 'published';
