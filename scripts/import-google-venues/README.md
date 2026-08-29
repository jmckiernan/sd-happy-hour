# Google Places venue import

The English playbook for this pipeline — sources, outcomes, apply gates, deal chips, and display rules — is **[docs/venue-data-pipeline.md](../../docs/venue-data-pipeline.md)**. Update that file when the behavior changes.

Bulk-import San Diego County restaurants and bars that **have a happy hour**, ranked by Google review volume and filtered to **≥ 4.2 stars** and **≥ 50 reviews**.

Bulk-import San Diego County restaurants and bars that **have a happy hour**, ranked by Google review volume and filtered to **≥ 4.2 stars** and **≥ 50 reviews**.

Happy hour data is resolved in this order:

1. **Google Business Profile** — `regularSecondaryOpeningHours` with type `HAPPY_HOUR` (times, including multiple windows)
2. **Website inventory (once per domain)** — robots/sitemap, then the top 3 candidate URLs (HTML, PDF, or image menus). Playwright only on a challenge.
3. **One Haiku call** — all candidate text (plus vision for PDF/image) for that location. Recurring specials count, not just pages that say "happy hour".
4. **Record an outcome** — `found`, `not_published`, `no_candidates`, `blocked`, `media_unreadable`, `extract_failed`, `other_location`, with source URL, quotes, and location applicability.

A model confidence label is never enough to overwrite times. Apply requires supporting quotes. Chain sites are fetched once, then mapped onto each location.

## Setup

1. Enable **Places API (New)** in [Google Cloud Console](https://console.cloud.google.com/)
2. Create an API key and add it to `.env`:

```bash
GOOGLE_PLACES_API_KEY=your-key-here
```

3. Set a billing budget cap before running discovery (discovery can cost ~$10–60 depending on volume).

## Commands

```bash
# Full pipeline (discover → enrich → extract → stage → merge)
npm run import:venues

# Or step by step:
npm run import:venues:discover
npm run import:venues:enrich
npm run import:venues:extract
npm run import:venues:stage
npm run import:venues:merge -- --dry-run   # preview
npm run import:venues:merge                # write to happy-hours.json

# Post-import cleanup (run after merge or when fixing listing quality)
npm run import:venues:cleanup              # dedupe deals, strip HTML junk, replace placeholders with "Happy hour"
npm run import:venues:photos               # download Google Places photos → public/images/venues/
npm run import:venues:refresh-deals        # re-scrape websites for venues still on the "Happy hour" fallback
npm run import:venues:refresh-happy-hour   # re-scrape times, days, and deals for flagged venues (--apply to write)
npm run import:venues:classify-neighborhoods  # re-assign neighborhoods from lat/lng + address

# Data quality audit (no network by default)
npm run audit:venues                       # static quality flags for all venues
npm run audit:venues -- --verify --limit=25  # re-scrape + AI read page vs stored data
npm run audit:venues -- --verify --browser   # Playwright for Cloudflare-protected sites
npm run import:venues:refresh-happy-hour -- --browser --limit=25 --apply

# AI extraction uses ANTHROPIC_API_KEY from .env.local (falls back to regex with --no-ai)
```

## Smoke test (cheap)

```bash
npm run import:venues -- --discover-limit=2 --enrich-limit=5 --extract-limit=5 --dry-run
```

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `GOOGLE_PLACES_API_KEY` | — | Required |
| `ANTHROPIC_API_KEY` | — | AI happy hour extraction (same key as blog) |
| `VENUE_AI_MODEL` | `claude-haiku-4-5` | Light model for venue page extraction only |
| `IMPORT_MIN_RATING` | `4.2` | Minimum Google rating |
| `IMPORT_MIN_REVIEWS` | `50` | Minimum review count |
| `IMPORT_MAX` | `1000` | Max venues to stage |

## Output files

All intermediate files live in `.data/import/` (gitignored):

| File | Contents |
|------|----------|
| `google/candidates.json` | Raw place IDs from grid search |
| `google/enriched.json` | Place Details + quality filter |
| `google/with-happy-hour.json` | Only venues with HH data |
| `staging.json` | Normalized rows ready to merge |

Imported venues are written with `seoHidden: true` unless Google provided high-confidence happy hour hours. Review staging before merging, then run `npm run validate:data`.

## After merge

1. Spot-check `.data/import/staging.json`
2. Deploy so static venue pages rebuild
3. Owners can claim listings and fill in deal details via the merchant dashboard
