-- Add photo_type to venue_photos to distinguish between venue gallery photos
-- and menu item photos.
--
-- 'venue'      — Photos for the venue gallery modal (public page showcase)
-- 'menu_item'  — Photos of individual dishes/drinks for menu items
--
-- This allows owners to upload photos directly when creating menu items without
-- cluttering the main venue photo gallery.

ALTER TABLE venue_photos
  ADD COLUMN photo_type text NOT NULL DEFAULT 'venue'
  CHECK (photo_type IN ('venue', 'menu_item'));

-- Default existing photos to 'venue' type (already applied by DEFAULT above)
-- No data update needed since DEFAULT handles it

-- Update the public album index to only include venue gallery photos
DROP INDEX IF EXISTS venue_photos_public_idx;
CREATE INDEX venue_photos_public_idx
  ON venue_photos (venue_id, sort_order, created_at)
  WHERE status = 'published' AND photo_type = 'venue';

-- Index for menu item photo selection (published photos only)
CREATE INDEX venue_photos_menu_items_idx
  ON venue_photos (venue_id, created_at)
  WHERE status = 'published' AND photo_type = 'menu_item';
