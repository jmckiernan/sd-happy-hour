-- Owner photos again require manual approval when automated screening is
-- inconclusive, off-topic, or unavailable. Only a clear pass publishes
-- immediately; clearly unsafe uploads are still rejected before insert.
ALTER TABLE venue_photos
  ALTER COLUMN status SET DEFAULT 'in_review';
