# Google Places venue import

Bulk-import San Diego County restaurants and bars that **have a happy hour**, ranked by Google review volume and filtered to **≥ 4.2 stars** and **≥ 50 reviews**.

Happy hour data is resolved in this order:

1. **Google Business Profile** — `regularSecondaryOpeningHours` with type `HAPPY_HOUR`
2. **Venue website** — scans homepage and common paths (`/happy-hour`, `/menu`, etc.) for times and deal lines

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
```

## Smoke test (cheap)

```bash
npm run import:venues -- --discover-limit=2 --enrich-limit=5 --extract-limit=5 --dry-run
```

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `GOOGLE_PLACES_API_KEY` | — | Required |
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
