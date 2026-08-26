# Always-current San Diego content engine

The content engine discovers public San Diego County events and deals, keeps every source observation, merges duplicates, builds editorial story bundles, and generates linked blog and newsletter drafts for review.

## Architecture

The stages are intentionally separate:

1. `fetch` — configurable RSS, Atom, Google Alerts, Reddit RSS, semantic JSON-LD event pages, and authenticated webhooks.
2. `normalize` — one county-wide event/deal shape, confidence score, quality flags, and source observation.
3. `dedupe` — title/venue/date/location matching with cross-source provenance merging.
4. `cluster` — date, weekend, neighborhood, event-type, and strong single-source editorial candidates. Anthropic can rerank and improve proposed angles without adding facts.
5. `draft` — a full source-constrained blog post and a separately written newsletter from the same cluster.
6. `image` — permitted first-party/attributed imagery first; Gemini generation when no reusable image exists; safe fallback when no key is configured.
7. `review` — Neon-backed queue at `/admin/content-engine/`, including editing, regeneration, rejection, approval, scheduling, source inspection, and settings.
8. `publish` — approved posts become Markdown in `src/content/blog/` through the existing GitHub API workflow. Newsletter drafts remain internal.
9. `measure` — durable ingestion/generation/publication/image/click metrics plus the existing PostHog blog analytics.

Pipeline records live in Neon through `migrations/0016_content_engine.sql`. Published posts remain Git-backed so the existing Astro content collection, deploy, sitemap, RSS, and admin post editor continue to work.

## Initial sources

The migration seeds the publisher-provided [San Diego Reader event RSS feed](https://www.sandiegoreader.com/rss/), the official City of San Diego calendar, San Diego Theatres, and conservative searches of r/SanDiegan, r/sandiego, and r/FoodSanDiego. Reddit is low-trust, never supplies reusable imagery, and remains review-only unless corroborated.

Add Google Alert RSS URLs or venue/organizer feeds from **Admin → Content Engine → Sources**. A source can cover any bar, restaurant, comedy club, theater, music venue, festival, market, or other going-out destination in San Diego County; it does not need a matching venue in `happy-hours.json`.

## Setup

1. Run `npm run migrate` to apply `0016_content_engine.sql`.
2. Keep the existing `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GITHUB_*`, and `DATABASE_URL` variables configured.
3. Optionally set:

   - `CONTENT_ENGINE_WEBHOOK_SECRET` for authenticated event-trigger ingestion.
   - `CONTENT_ENGINE_MAX_DRAFT_BUNDLES` (default `3`, range `1–10`) to cap new AI bundle pairs per run.

4. Deploy to Netlify. `run-content-engine` runs at `05 15,23 * * *` UTC. The admin schedule setting can reduce that to daily or manual-only without a deploy.

Manual runs use the same pipeline through **Run pipeline now**. Failed individual sources do not discard successful ingestion from other sources.

## Publishing safety

`auto_publish_enabled` defaults to `false`. Enabling it is not sufficient on its own. A blog draft must also meet the configured quality threshold, have complete date/location data, contain deterministic linked dates, have no quality flags, clear the cluster confidence floor, and—by default—have at least two independent sources. Newsletter drafts never auto-publish to an external sender.

Generated posts preserve:

- source URLs and an on-page verification appendix;
- date, location, brand/venue, event-type, and topic tags;
- SEO title/description, Open Graph fields, and hashtag suggestions;
- image origin, attribution, prompt, and model metadata when applicable;
- a `contentEngineId` linking public analytics back to the reviewed draft.

Event articles are never removed merely because their date passed. `/blog/date/YYYY-MM-DD/` and `/blog/tag/<tag>/` remain durable archives.

## Webhook shape

Create an enabled `webhook` source with a trust score of at least `0.8`, then send:

```json
{
  "sourceId": "source-uuid",
  "items": [
    {
      "url": "https://venue.example/events/show",
      "title": "Event title",
      "description": "First-party details",
      "venueName": "Venue name",
      "startAt": "2026-08-29T20:00:00-07:00",
      "endAt": "2026-08-29T22:00:00-07:00",
      "area": "North Park",
      "address": "Street address, San Diego, CA",
      "imageUrls": ["https://venue.example/press/event.jpg"]
    }
  ]
}
```

POST it to `/api/content-engine/webhook` with `Authorization: Bearer <CONTENT_ENGINE_WEBHOOK_SECRET>`. Strong single opportunities can create a review draft immediately; weaker items wait for corroboration or a useful roundup.

## Verification

Run:

```sh
npm run test:content-engine
npm run build
```

The focused suite covers RSS/JSON-LD ingestion, county filtering, dedupe, clustering, full AI/SEO/newsletter generation, image fallback, date links, archive visibility, auto-publish gates, provenance publishing, and the migration contract.
