-- Optional, promotion-specific artwork. These images are shown by Live Deals
-- only and never replace a venue's featured listing image.

CREATE TABLE promotion_images (
  image_key             text PRIMARY KEY REFERENCES images(key) ON DELETE RESTRICT,
  venue_id              integer NOT NULL CHECK (venue_id > 0),
  uploaded_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX promotion_images_venue_created_idx
  ON promotion_images (venue_id, created_at DESC);

ALTER TABLE promotion_campaigns
  ADD COLUMN image_key text REFERENCES promotion_images(image_key) ON DELETE RESTRICT;
