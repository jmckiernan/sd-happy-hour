-- Metadata for the images in Netlify Blobs (src/lib/imageStore.ts).
--
-- The bytes deliberately stay in Blobs rather than moving into a bytea
-- column here: serving them out of Postgres would mean a database round
-- trip and a woken compute endpoint per image request, with no CDN in
-- front, and would bloat row storage and every backup. Blobs is already
-- wired up, and /api/images/[key] already sets an immutable + durable
-- cache header. What was missing was any *record* of what exists.
--
-- Without this table nothing could enumerate the store, so an empty Blobs
-- store sitting next to seven referenced image keys was invisible until it
-- surfaced as mystery broken images weeks later (the process.env.NETLIFY
-- bug fixed in 56421e6). This makes orphans — a row whose blob is gone, or
-- a blob no post references — something you can actually query for.

CREATE TABLE images (
  -- The Blobs key, and the last path segment of /api/images/<key>. Natural
  -- primary key: makeImageKey() already guarantees uniqueness, and keeping
  -- it as the identifier means a URL found in blog frontmatter can be
  -- looked up directly with no join or lookup table.
  key           text PRIMARY KEY,
  content_type  text NOT NULL,
  byte_size     integer NOT NULL CHECK (byte_size > 0),
  -- Only populated for the formats readImageDimensions() can parse
  -- (JPEG/PNG/GIF); WebP/AVIF are left null rather than guessed.
  width         integer CHECK (width > 0),
  height        integer CHECK (height > 0),
  -- Which admin route created this. 'upload' = direct file upload,
  -- 'url' = fetched from a pasted remote URL, 'generated' = AI text-to-image,
  -- 'edited' = AI edit of an existing image.
  origin        text NOT NULL CHECK (origin IN ('upload', 'url', 'generated', 'edited')),
  -- For origin='url', where we fetched it from — the attribution trail that
  -- hotlinking used to carry implicitly in the URL itself.
  source_url    text,
  -- For origin IN ('generated','edited'), the prompt used. Worth keeping:
  -- it's the only record of how an image was made, and it makes a
  -- regenerate-this-one flow possible later.
  prompt        text,
  -- The slug hint passed to makeImageKey() — usually the post the image was
  -- created for. Not a foreign key: posts live in git (src/content/blog),
  -- not in this database, and an image can outlive the draft it was made for.
  slug_hint     text NOT NULL DEFAULT '',
  -- Admin email from getAdminUser(). Text rather than a users(id) reference
  -- so deleting a user never cascades away the provenance of a live image.
  created_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Supports the "what's in the store, newest first" listing this table exists
-- to make possible.
CREATE INDEX images_created_at_idx ON images (created_at DESC);
