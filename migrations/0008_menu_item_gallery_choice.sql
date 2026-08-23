-- Let each menu item decide whether its photo also appears in the venue's
-- main photo gallery. Existing and newly created items default to visible so
-- deploying this change does not silently remove photos that are already on
-- public venue pages; restaurant managers can opt individual items out.

ALTER TABLE menu_items
  ADD COLUMN show_photo_in_gallery boolean NOT NULL DEFAULT true;

CREATE INDEX menu_items_gallery_photos_idx
  ON menu_items (photo_id)
  WHERE show_photo_in_gallery = true AND photo_id IS NOT NULL;
