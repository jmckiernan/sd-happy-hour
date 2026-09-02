# Venue featured-image pipeline

**Status: implemented 1 September 2026.** The first published-catalog run began
with 201 of 691 published venues on stock fallback. The official-website pass
attached 89 unique, high-confidence photographs, leaving 112 on the safe stock
fallback for later review or an owner-supplied image. Unlisted claim stubs are
not crawled until they are published.

## Order of operations

1. **Keep an existing owner/admin image.** `image` is never overwritten. An
   owner-supplied photo remains the preferred permanent source.
2. **Official venue website.** Read the exact listed URL first, then up to two
   same-site gallery/about/location pages. Rank JSON-LD images, `og:image`,
   `twitter:image`, `srcset` originals, hero elements, and photographic
   backgrounds. Location-specific media wins over a brand-wide social card.
3. **Visual quality and identity gate.** Download at most 12 MB; require a
   JPEG/PNG/WebP with readable dimensions, at least 1000×560, a usable hero
   aspect ratio, and no logo/placeholder signals. Re-encode to JPEG before
   storage to remove EXIF/GPS and other metadata. A visual model rejects logos,
   menus, flyers, stock art, text-heavy graphics, people-only shots, and wrong
   branches. Only high-confidence choices attach automatically. Reusing one
   asset for two locations is rejected into review.
4. **Official social account, owner-authorized/manual.** The website crawler
   records Instagram links, but the batch process does not scrape social media
   or publish a profile image. An owner-authorized photo may be reviewed and
   imported manually with its permission trail.
5. **Licensed web search, manual.** Google Images may be used to *discover* an
   independently licensed asset. The operator must verify the license on the
   original host and store that host/license as provenance. Google is not the
   source merely because it found the page.
6. **Owner upload.** Ask the venue for a photo when no defensible public asset
   exists. This is the best resolution for blocked sites and ambiguous chains.
7. **Stock fallback.** Keep the existing vibe image when every stronger source
   fails. A truthful fallback is better than an unrelated venue photo.

Google Places photos are deliberately excluded from new durable ingestion.
Google's current Places policy prohibits caching/storing most Places content
outside named exceptions and requires photo attribution plus direct access to
the source photo on Google Maps. The repository's existing 597 legacy Places
files are documented separately in `docs/google-photo-exposure.md`; adding more
would deepen that known exposure instead of building the chosen exit path.

## Commands

```sh
# Preview the published fallback set. No catalog/file writes.
npm run images:backfill

# Fetch, visually review, normalize, store, and attach high-confidence images.
npm run images:backfill -- --apply

# Re-run blocked/JS-only websites with Playwright.
npm run images:backfill -- --apply --browser --force

# Pilot a bounded set.
npm run images:backfill -- --apply --ids=4,8,13

# Build a local contact sheet for every unresolved/review candidate.
npm run images:review

# After reviewing the sheet, approve candidate 0 for venue 13.
npm run images:backfill -- --apply --approve=13:0
```

The resumable manifest is `.data/import/venue-images.json` (gitignored). Each
venue ends in one explicit state: `attached`, `review_needed`,
`review_needed_duplicate`, `website_unreadable`,
`no_usable_website_candidate`, or `review_error`. Candidate URLs, dimensions,
scores, social link, and reviewer reason are retained where available.

## Publication contract

- The catalog receives only a root-relative first-party file path under
  `/images/venues/`; candidate URLs are never hotlinked.
- `imageSource` records provider, source page, original asset URL, retrieval
  timestamp, review path, rights basis, and SHA-256 of the normalized bytes.
- The batch downloader rejects private-network targets and checks every
  redirect, caps bytes and dimensions, sniffs the actual media type, and
  re-encodes accepted content before writing.
- Clearing or replacing an image through the venue editor also clears stale
  automated provenance.
- Run `npm run validate:data`, `npm run test:venue-images`, and the full test
  suite before deployment.

## Current outcome and next pass

The initial plain-HTTP run plus browser-assisted retry produced 89 unique
official-site images (about 32 MB after normalization) and left 112 published
venues on fallback:

- 35 websites still unreadable after the browser pass;
- 35 websites with no hero-quality candidate;
- 34 candidates requiring human judgment;
- 1 transient visual-review error;
- 7 branch/shared-asset duplicates held back after uniqueness enforcement.

The next operational pass is manual review of the 34 candidates, then owner
outreach for unreadable/no-candidate venues. Do not silently fill the
remainder from Google Places.
