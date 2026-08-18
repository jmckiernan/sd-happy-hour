-- Owner-managed venue content: listing overrides, a photo album, and a menu.
--
-- Why the database rather than public/data/happy-hours.json (the way admin
-- venue edits work): that file is committed through the GitHub API and only
-- reaches visitors on the next deploy. That's tolerable for an admin
-- approving a venue a few times a day; it isn't for a restaurant owner
-- fixing their own hours, and it would put owner-supplied text and binary
-- photos into repo commits. So everything a *verified claimant* controls
-- lives here and renders dynamically, while happy-hours.json stays the
-- admin-curated base record.
--
-- Photo/menu-item bytes stay in Netlify Blobs (src/lib/imageStore.ts) with a
-- row in `images`, same as blog and featured images; these tables only
-- reference the blob key.

-- ---------------------------------------------------------------------------
-- Listing overrides
-- ---------------------------------------------------------------------------
-- One row per venue, holding only the fields an owner is allowed to change
-- (src/lib/venueContent.ts OWNER_EDITABLE_FIELDS). Stored as a single JSONB
-- patch rather than a column per field because the shape has to follow
-- Listing, which changes; a partial patch also distinguishes "owner set this
-- to empty" from "owner never touched it", which per-column NULLs could not.
CREATE TABLE venue_overrides (
  -- Not a foreign key: venues live in happy-hours.json, not in this
  -- database. Same reasoning as promotions/live_overrides.
  venue_id    integer PRIMARY KEY,
  patch       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The account that last saved it — the owner's user id, or an admin's.
  updated_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Photo album
-- ---------------------------------------------------------------------------
CREATE TABLE venue_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      integer NOT NULL,
  -- The Blobs key, served at /api/images/<key>. References images(key) so a
  -- photo row can't point at bytes we have no record of; ON DELETE RESTRICT
  -- because deleting the image record while an album still shows it would
  -- leave a hole on a public page.
  image_key     text NOT NULL REFERENCES images (key) ON DELETE RESTRICT,
  caption       text NOT NULL DEFAULT '',
  -- 'published'   — visible on the public venue page.
  -- 'in_review'   — held back pending admin review, either because automated
  --                 screening flagged it or because screening could not run
  --                 (no API key, API error). Fail closed: an unscreened
  --                 photo is never public.
  -- 'rejected'    — an admin (or screening, on a clear fail) said no. Kept
  --                 rather than deleted so a re-upload of the same photo can
  --                 be recognized and the owner can see why.
  status        text NOT NULL DEFAULT 'in_review'
                CHECK (status IN ('published', 'in_review', 'rejected')),
  -- What the automated screen said, verbatim, plus which model said it.
  -- Null when screening never ran.
  moderation    jsonb,
  -- Admin's note when they reject or restore a photo by hand.
  review_note   text NOT NULL DEFAULT '',
  reviewed_by   text NOT NULL DEFAULT '',
  reviewed_at   timestamptz,
  sort_order    integer NOT NULL DEFAULT 0,
  -- User id of the uploader (owner or admin).
  uploaded_by   text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The public album query: published photos for one venue, in the owner's
-- chosen order.
CREATE INDEX venue_photos_public_idx
  ON venue_photos (venue_id, sort_order, created_at)
  WHERE status = 'published';

-- The admin review queue: everything waiting, oldest first.
CREATE INDEX venue_photos_review_idx
  ON venue_photos (created_at)
  WHERE status = 'in_review';

-- The same photo can't be added to the same venue's album twice — re-uploads
-- get a fresh blob key, but promoting/restoring shouldn't be able to
-- duplicate a row.
CREATE UNIQUE INDEX venue_photos_venue_image_unique ON venue_photos (venue_id, image_key);

-- ---------------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------------
CREATE TABLE menu_sections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    integer NOT NULL,
  title       text NOT NULL,
  -- Optional line under the heading ("served 3–6pm at the bar").
  note        text NOT NULL DEFAULT '',
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX menu_sections_venue_idx ON menu_sections (venue_id, sort_order, created_at);

CREATE TABLE menu_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Cascades: deleting a section deletes its items, which is what the owner
  -- means by "remove this section".
  section_id  uuid NOT NULL REFERENCES menu_sections (id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- Free text, not numeric: real menus say "$8", "6/9", "market price".
  price       text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  -- A photo of the dish. Goes through the same upload + screening path as
  -- album photos, so it's a venue_photos row rather than a raw image key —
  -- that way one moderation decision covers every place the photo appears.
  photo_id    uuid REFERENCES venue_photos (id) ON DELETE SET NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX menu_items_section_idx ON menu_items (section_id, sort_order, created_at);

-- ---------------------------------------------------------------------------
-- images.origin gains 'owner'
-- ---------------------------------------------------------------------------
-- Until now every image came from an admin screen. Owner uploads are worth
-- telling apart from admin ones in the provenance record, since they're the
-- only ones that were never seen by a human before being stored.
ALTER TABLE images DROP CONSTRAINT IF EXISTS images_origin_check;
ALTER TABLE images ADD CONSTRAINT images_origin_check
  CHECK (origin IN ('upload', 'url', 'generated', 'edited', 'owner'));
