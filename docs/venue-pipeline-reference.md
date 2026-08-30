# Venue Pipeline Reference

Every check, gate, and threshold that decides whether a venue reaches the site, and what it is
allowed to say when it gets there. One page, in pipeline order.

This is the *what and why*. For the narrative playbook — how to run a job, what a scrape outcome
means, how to read the cost report — see `docs/venue-data-pipeline.md`.

Counts and constants here were read out of the code, not remembered. When you change a threshold,
change it here too.

---

## 0. Stage map

```
discover ──▶ enrich ──▶ extract ──▶ stage ──▶ merge ──▶ public/data/happy-hours.json
   │           │           │          │         │
   │           │           │          │         └─ staleness guard, stub upgrades
   │           │           │          └─ dedupe, county, fast food, MAX_IMPORT cap
   │           │           └─ Google → website → locator → AI, in that order
   │           └─ quality bar, county, fast food (the gate that protects spend)
   └─ grid search, no filtering

import:stubs ──▶ same catalog, for venues with no happy hour
```

Each stage writes a cache under `.data/import/` (gitignored) and reads the previous one. The
catalog itself, `public/data/happy-hours.json`, is tracked in git — that is the audit trail.

| Stage | Command | Reads | Writes |
|---|---|---|---|
| Discover | `import:venues:discover` / `discover:adaptive` | — | `candidates.json` |
| Enrich | `import:venues:enrich` | `candidates.json` | `enriched.json` |
| Extract | `import:venues:extract` | `enriched.json` | `with-happy-hour.json` |
| Stage | `import:venues:stage` | `with-happy-hour.json` + catalog | `staging.json` |
| Merge | `import:venues:merge` | `staging.json` + catalog | catalog |
| Stubs | `import:stubs` | `enriched.json` + catalog | catalog |

---

## 1. Discovery

Find place IDs inside San Diego County. **No quality filtering happens here** — it is cheap to
receive a Starbucks in a search response, and the first gate that matters is the one guarding the
Place Details spend.

### 1.1 Search area

- `COUNTY_BOUNDS` is a rectangle: lat `32.50`–`33.55`, lng `-117.65`–`-116.60`.
  - It is not the county. The northwest corner reaches San Clemente (Orange County) and the north
    edge reaches Temecula (Riverside County); the south edge reaches into Tijuana.
  - A tighter rectangle cannot fix this — Temecula at 33.494°N is Riverside while Fallbrook at
    33.376°N is San Diego, so no single `maxLat` separates them. County is decided later, from
    Google's own data.
- Five place types are searched per cell: `restaurant`, `bar`, `cafe`, `night_club`, `brewery`.
  - One API call per (cell, type) pair, so a 529-cell grid is ~2,645 calls.

### 1.2 Fixed grid (`discover.mjs`)

- Cells are `0.045°` squares (~5 km), centred at `step/2` offsets, with a `2800 m` search radius.
- `--limit=N` takes the first N cells; `--smoke` uses two hardcoded downtown centres.
- Checkpoints to disk every 20 requests. A failed call warns and continues — no retry, no abort.
- **No border skip.** Tijuana cells are searched and the results discarded later, after payment.

### 1.3 Adaptive subdivision (`discover-adaptive.mjs`)

Google caps a Nearby Search at 20 results ranked by popularity, so a dense cell silently hides
everything past the twentieth venue. This is the fix.

- **Truncation signal:** a response of exactly `PAGE_SIZE` (20) is treated as evidence of
  truncation; anything shorter is treated as exhaustive.
  - On truncation the square splits into four quadrants, each re-queued for the *same* type.
  - Per-type queues, because a square capping on `restaurant` says nothing about `brewery`.
- **Floor:** a child is only queued if its radius (`radius / 2`) is still ≥ `--min-radius`
  (default `120 m`). Below that the cell is counted as `floored` and abandoned.
- **Budget:** `--max-calls` (default `2000`). Breadth-first, so depth grows uniformly and the
  budget is spread rather than sunk into one dense block. Failed calls do not consume budget.
- **Border skip:** an initial square is dropped if its entire top edge is south of the US–Mexico
  border line. This is a discovery-time saving — 517 candidates were Mexican and Details had
  already been bought for 459 of them before this existed.
- Radius covers the square's diagonal so circles never leave gaps, floored at 50 m per request.

### 1.4 Discovery field mask

Requested: `id`, `displayName`, `location`, `rating`, `userRatingCount`, `businessStatus`,
`primaryType`.

- `rating` and `userRatingCount` put this at the **Pro** tier. They are worth it: having them for
  free in the search response is what lets enrich prefilter before buying Details.
- Billing is by the highest tier any single requested field belongs to. One stray field re-prices
  the entire call.

---

## 2. Enrichment

Buy Place Details for candidates worth having, and decide who qualifies.

### 2.1 Prefilter — before any money is spent

Applied to the candidate list in this order:

- `businessStatus` must be `OPERATIONAL`.
- Name must not match the fast-food blocklist (§9).
- **Escape hatch:** if both `rating` and `userRatingCount` are absent, the place passes through.
  Unknown quality is not a rejection at this stage.
- Otherwise `rating >= MIN_RATING` **and** `userRatingCount >= MIN_REVIEWS`.

Survivors are sorted by review count descending, so if the budget runs out it runs out on the
least-reviewed venues.

### 2.2 Details field mask

Requested: `id`, `displayName`, `formattedAddress`, `addressComponents`, `location`, `rating`,
`userRatingCount`, `websiteUri`, `googleMapsUri`, `nationalPhoneNumber`, `primaryType`, `types`,
`businessStatus`, `regularSecondaryOpeningHours`.

- `websiteUri` and `regularSecondaryOpeningHours` are **Enterprise**, so ~$20/1k is the floor for
  this mask. Both are load-bearing: one is Google's own happy-hour block, the other is the site we
  scrape.
- `servesBeer` / `servesWine` / `servesCocktails` were removed. Nothing read them, and being
  Atmosphere fields they silently re-priced every call to ~$25/1k.
- A separate **Essentials** mask (`placeDetailsEssentials`) fetches address only, at ~$5/1k with
  the first 10,000 per month free. Use it for claimable stubs, which need no website or hours.

### 2.3 Qualification, after details

`qualified = OPERATIONAL && rating >= MIN_RATING && reviews >= MIN_REVIEWS && county.inCounty`

- Stricter than the prefilter: missing rating or review count coerce to `0` here, so the "both
  absent passes" escape hatch does not survive.
- `--requalify` recomputes this over the cache with no network calls. Lowering a threshold
  otherwise leaves thousands of cached places stamped with the old verdict.
- `--resume` (on by default) skips anything with a `detailsFetchedAt`. That field is also written
  on failure, so a place whose lookup errored is not retried unless you pass `--no-resume`.

---

## 3. County classification

Four checks, in order, first match wins. Google's own data is the authority; the rectangle is only
a search hint.

- **Country component ≠ US** → out. Tijuana and Tecate have no county component, so without this
  they read as "no county data, probably fine" and three Mexican breweries reached the live site.
- **South of the border line** → out. A straight line from the Pacific (32.5343°N, 117.1244°W) to
  the Colorado River (32.7187°N, 114.7196°W); latitude climbs as you go east.
- **`administrative_area_level_2` present** → in only if it equals `San Diego County`.
- **City-name regex fallback**, used only when Google omitted the county (~14% of places).
  - Matches San Clemente, Dana Point, the Lagunas, Capistrano Beach, San Juan Capistrano, Ladera
    Ranch, Rancho Santa Margarita, Mission Viejo, Aliso Viejo, Irvine, Temecula, Murrieta,
    Wildomar, Lake Elsinore, Menifee, Hemet, Anza, Idyllwild, Palm Springs, Corona.
- **Default: in county.** Missing data is not disqualifying — 679 cached places have no county
  component and almost all are genuinely San Diego.

---

## 4. Happy-hour extraction

Four sources, tried cheapest-first, each short-circuiting on success. A venue only reaches the
model call if the three free paths found nothing.

### 4.1 Source order

1. **Google** — `regularSecondaryOpeningHours` with type `HAPPY_HOUR`. Already paid for, so it is
   always tried first and returns immediately.
2. **Website path probe** — a fixed list of likely URLs on the venue's own domain.
3. **Locator widgets** — the store-locator API behind a multi-location brand's site.
4. **AI fallback** — a model call, gated hard (§4.5).

### 4.2 Google source

- Periods are collapsed into distinct windows keyed by start–end, with the days each covers.
- **Lossy on multi-window venues:** only the window covering the most days survives. A venue with
  a separate late-night window loses it here.
- Confidence `high` when periods parse; `medium` when only the human-readable
  `weekdayDescriptions` could be read.

### 4.3 Website crawl

Two crawlers exist. The cheap one runs in the main path; the deep inventory crawl only runs inside
the AI fallback.

- **Path probe** tries `/happy-hour`, `/happyhour`, `/specials`, `/promotions`, `/offers`,
  `/drinks`, `/bar`, `/menu`, `/menus` and the listed URL, stopping early on a high-confidence hit.
  - HTML is capped at 500,000 characters; Cloudflare challenge pages are skipped.
  - Times are only accepted within 350 characters of the words "happy hour", and a bare hour ≤ 6
    is read as PM.
- **Deep inventory** budgets 6 pages / 8 fetches, scoring candidates from three sources:
  - Sitemap URLs, scored 60 (specials-happy-hour) down to 20 (menu), with 0 for privacy, careers,
    blog, cart and similar.
  - In-page links, base 10 plus bonuses — +50 specials-and-happy-hour, +40 happy hour, +30
    `/specials` in the href, +18 menu, +15 promotions.
  - Guessed conventional paths, but **only** when nothing else scored ≥ 20.
- Page content is scored on top of URL signal: headings mentioning happy hour, dollar signs,
  percentage-off phrasing, and a time appearing within 200 characters of "happy hour". Brunch and
  lunch phrasing scores negative.

### 4.4 Locator widgets

Multi-location brands publish per-branch offers through a widget API, not on the page. Board & Brew
is the reference case — its `$2 off all pints` exists only in a Storepoint payload.

- **Platforms detected:** Storepoint, Stockist, StoreRocket, each by its script-tag signature.
- **Matching a record to this venue** — brand name alone never matches:
  - Coordinates within **400 m**, nearest wins; else
  - Exact street-number match plus overlapping street name.
- Offer text must contain "happy hour" and yield a valid time range.
  - Days default to **all seven** here, unlike the page parser which defaults Monday–Friday.
  - Always confidence `medium`.

### 4.5 AI fallback

Every gate must pass, in order:

- `IMPORT_AI_FALLBACK` is not `'0'`.
- `siteMentionsHappyHour` finds the literal phrase on the homepage, `/happy-hour`, `/specials` or
  `/menu`. No signal, no call — this is what stops us paying to read a site that never mentions it.
- The result has a usable schedule: both times valid `HH:MM` and a non-empty day list.
- The source page does not conflict with this venue (§4.6).

Model is `claude-haiku-4-5` by default, with prompt budgets of 20,000 characters per page and
80,000 total. Shopping-mall hosts and sites that never mention the venue are rejected before any
call.

### 4.6 Chain and per-location handling

On a chain site every branch page says "Happy Hour", so the likely failure is a plausible answer
from the wrong restaurant — not a blank one.

- **Picking the right branch page**, scored: +10 the venue's ZIP appears in the URL, +6 its street
  number, +4 per matching place name, +1 a `/locations/`-style path.
- **Rejecting the wrong branch** — only on positive evidence of a different place:
  - The URL names ZIPs and none of them are this venue's.
  - The URL names a place and none of them contain, or are contained by, this venue's place names
    (so "la costa" and "la costa town square" agree).

### 4.7 Confidence

| Level | Source |
|---|---|
| `high` | Google periods; or a website page whose URL is explicitly happy-hour/specials |
| `medium` | Google weekday text; any other parsed website page; **all** locator results |
| `low` | A page whose only "deal" is the literal string `Happy hour`; empty results |

Confidence matters downstream: anything below `high` is imported with `seoHidden: true`.

---

## 5. Normalization

Turns an extraction result into a catalog row, or rejects it. This is the last line of defence
against bad data reaching the site.

### 5.1 Rejection conditions, in order

- Coordinates outside the `COUNTY_BOUNDS` rectangle.
- Empty name.
- No happy hour, or missing start time, end time, or days.
- Times not matching `HH:MM` in 24-hour form.
- **Implausible window** (§5.2).
- No `sourceUrl`, or one that is not `http(s)`.

### 5.2 Plausible window

Between **30 minutes and 8 hours**. Windows crossing midnight are allowed (21:00–00:00 is real).

- Three Cheesecake Factories came through as 11:00–22:00 and a casino as 13:00–08:00. Nobody
  discounts for eleven hours — those are business hours that happened to sit near the words
  "happy hour".

### 5.3 Deal text filtering

A line has to earn its place. Checks run in order; the first match decides.

- Shorter than 3 characters → drop.
- Matches `NOT_AN_OFFER` → drop. Ten patterns covering:
  - The bare label: `Happy hour`, `Happy Hour Menu`, `Daily Happy Hour`, `Weekend Specials`.
  - Extraction debris: a phone number, `Call us…`, `Order`, `Parties`, a dangling `Mon-Thu &`,
    a location fragment like `at The Deck`.
  - Unfinished storefronts: `You have no products…`, `[empty page content]`.
- Matches `BOILERPLATE` → drop. Navigation and footer text — `Reserve`, `Gift Cards`,
  `Skip to main content`, `Must be 21+`, `Follow us`, `indicates required fields`.
- Ends in a colon without a price → drop. It introduces the offers; it is not one.
- **Matches `OFFER_SIGNAL` → keep immediately.** A dollar sign, `N off`, `N for`, a percentage,
  `½`/`¼`/`⅓`, `half off`, `1/2 price`, `free`, `BOGO`, `two for`, `discount`.
  - The fraction characters are load-bearing. Without `½`, "½ off appetizers Mon–Fri 3–6pm" reads
    as priceless and the next rule deletes it.
- Names two or more days with no price → drop. That is an opening-hours row.
- Echoes the venue's own name (twice, or once in a long line) → drop. That is a page heading.
- Otherwise keep if 60 characters or shorter.

### 5.4 `dealsUnknown`

If nothing survives the filter, the venue keeps its window and is marked `dealsUnknown: true` with
an empty deal list.

- This is not "no happy hour". We know when it runs; we do not know what is discounted, and the
  card says so rather than inventing filler.
- Necessary because `finalizeDeals` falls back to `['Happy hour']` when its own cleaning empties
  the list, which is exactly the string we are trying to keep off cards.

### 5.5 Fields set on import

- `listingStatus: 'published'`, always, and explicitly. Leaving it undefined would make visibility
  depend on how each consumer reads a missing key.
- `seoHidden: confidence !== 'high'`.
- `verified: false`, `lastVerifiedAt: null`.
- `neighborhood` from coordinates (§6), `vibe` / `dealTypes` / `features` inferred from Google
  place types.

### 5.6 Stub normalization

For a venue with no happy hour. Differs from the above:

- **Requires an address** (the main listing path does not).
- **Emits no `days`, `startTime`, `endTime`, `deals` or `dealTypes`.** Their absence is the point —
  the venue page renders any window it finds as a real happy hour, so a placeholder would publish
  a time we invented.
- `listingStatus: 'unlisted'`, `seoHidden: true`, `hasHappyHourData: false`.
- Website may legitimately be empty; plenty of small restaurants only have a Google listing, and we
  still want their owner to find the page.

---

## 6. Neighborhood assignment

Order matters — the first method to produce an answer wins.

- Mexican addresses short-circuit to `Tijuana`.
- **44 bounding boxes**, checked in array order, most specific first.
- Address regex list (34 entries), including aliases like `PB` → Pacific Beach, `Convoy` →
  Kearny Mesa, `Liberty Station` → Point Loma.
- City parsed from the address, then a ZIP lookup table, then `San Diego`.

Because boxes are checked before addresses, **a box that is too wide silently overrides every
address rule beneath it**. Cardiff is the worked example: it sat inside the old Solana Beach box,
so its venues were labelled Solana Beach or Encinitas and the `/cardiff/` address rule could never
fire for a venue with coordinates. The fix was an explicit Cardiff box placed before Encinitas.

---

## 7. Dedupe and staging

### 7.1 Matching an existing venue

- Same Google place ID → match.
- Otherwise, identical normalized name (lowercased, punctuation collapsed) **within 120 m**.
  - If either side is missing coordinates, the name match alone is accepted.

### 7.2 Duplicate vs upgrade

A match is an **upgrade**, not a duplicate, when the existing row is a stub
(`hasHappyHourData === false` and no `startTime`).

- Without this distinction, finding a happy hour for a venue we had already stubbed reads as
  "already have it" and is thrown away. It silently dropped all 112 findings the first time it ran.
- An upgrade keeps the venue's **id**, so its URL and any pending claim survive.
- Only happy-hour fields move across — window, deals, status, source. Address, coordinates,
  neighborhood, phone and verification state stay as they are.

### 7.3 Staging gates, in order

- Must have `hasHappyHour` and a `happyHour` object.
- Must pass the county check again. The enriched cache predates that filter and still marks Orange
  and Riverside places as qualified, so staging would re-add venues `audit:county` just unlisted.
- Must not be corporate fast food. A "happy hour" on one of those is always a misread.
- Sorted by review count descending, then capped at `MAX_IMPORT` (default 1,000).
  - The cap applies to new venues only. **Upgrades are never capped.**

---

## 8. Merge

### 8.1 Staleness guard

Merge refuses to run if any file that shaped the staging output has changed since it was built:
`normalize.mjs`, `deals.mjs`, `dedupe.mjs`, `chain-blocklist.mjs`, `county.mjs`, `build-staging.mjs`.

- The filters run at **staging** time and freeze their output into `staging.json`. Merge only
  copies rows across. So fixing a filter does nothing for a staging file built before the fix.
- That is exactly how 99 venues went live with "Happy hour" as their only deal *after* the filter
  rejecting it had already been written.
- `--force` overrides. Re-staging is almost always the right answer instead.

### 8.2 Applying

- Upgrades are applied in place by id; new venues are appended with `_import` stripped.
- Validation runs after the write, not before — a failure leaves the bad file on disk for you to
  inspect, and the command exits non-zero.

---

## 9. Corporate fast food

Removed from the catalog and blocked at import. A brand qualifies only if **both** are true:

- It does not and will not run a happy hour, so anything extracted for it is a false positive. A
  Starbucks was published with a 09:00 "happy hour" before this existed.
- It will never claim a listing, because franchise marketing runs through corporate software rather
  than a local owner filling in a form.

**Sit-down chains are deliberately kept** — BJ's, Chili's, Applebee's, Yard House, Outback. They are
corporate too, but they run real happy hours and are exactly what someone searching this site wants.

### 9.1 Matching

41 brand patterns, matched two ways:

- **Word-boundary match** anywhere in the name, using custom boundaries rather than `\b` so
  hyphenated spellings like `in-n-out` cannot collapse to a bare `in`.
- **Whole-name match** for `subway` and `sonic`, which are ordinary English words. These only match
  when the brand is essentially the entire listing name, give or take a store number.

### 9.2 Where it is enforced

- **Enrich** — before paying for Place Details. This is the one that saves money.
- **Staging** — so a false-positive extraction can never publish.
- **Stub import** — a franchise stub is dead weight.
- **Purge** — retroactive removal from the live catalog.

Purge **deletes** rather than unlists, because an unlisted venue still occupies the claim search,
which is the surface these were hurting most.

---

## 10. Claimable stubs

Every qualifying venue gets a page its owner can claim, whether or not we found a happy hour.
Without this, an owner searching the claim dashboard for their own restaurant finds nothing.

- Costs nothing to run — every place involved was already enriched.
- Skip conditions, in order: below 4.0★ / 10 reviews, out of county, corporate fast food, already
  in the catalog, or unusable (no address, no coordinates, no valid source URL).
- Already-in-catalog is checked by place ID **and** by name + street line, since two enriched
  records can share a storefront.

---

## 11. Data contract

Enforced by `scripts/validate-data.js` on every write. Merge, stub import and purge all run it.

### 11.1 Required of every listing

`id` (unique integer), `name`, `neighborhood`, `address`, `lat`/`lng` (in range), `vibe`,
`verified` (boolean), a `lastVerifiedAt` key even when null, an `http(s)` `sourceUrl`, and a
non-empty `features` array.

### 11.2 Required of a listing with a happy hour

- Non-empty `days`, all valid day names.
- `startTime` and `endTime` in `HH:MM`.
- Non-empty `deals`, **unless** `dealsUnknown` is true.
- Non-empty `dealTypes`.
- A valid `website` URL.

### 11.3 Required of a stub

A stub is `hasHappyHourData === false` with no `startTime` or `endTime`. The validator does not
merely exempt stubs — it **forbids** the fields they should not have:

- Must **not** carry `days`, `deals`, or `dealTypes`.
- Must be `listingStatus: 'unlisted'`.
- `website` is optional, but must be a URL if present.

### 11.4 Other invariants

- `listingStatus` ∈ `published` | `unlisted`.
- `publishedByClaim` cannot be set on an unlisted venue.
- Every `windows` entry needs valid days plus either `allDay` or a valid time pair.
- `weeklySpecials` need an id, label, summary, a known kind, and either days or an occasion.

---

## 12. Visibility — what shows up where

Three independent flags, frequently confused.

| | Controlled by | Effect |
|---|---|---|
| Browse, homepage, neighborhoods | `listingStatus` **and** a schedule | Must be published *and* have a window |
| Sitemap | `listingStatus` only | Unlisted excluded, at build time |
| Search-engine indexing | `seoHidden` | `noindex` on the page; also drops it from the homepage index and neighborhood pages |
| Claim search | nothing | **Every** venue is searchable and claimable |

- A venue is publicly listed when `listingStatus !== 'unlisted'`. Rows predating the field count as
  published, so it could roll out without backfilling.
- A claim can publish a venue at runtime, immediately, without waiting for a deploy.
- `getPublicVenues()` returns `ListedVenue` — a type where the window is guaranteed. Browse
  surfaces therefore *cannot* receive a stub, even if a claim publishes one before its owner has
  supplied a happy hour.
- Venue pages exist for **all** venues, including stubs. The route dispatches on whether a schedule
  is present: a full listing page, or a small "no happy hour on file — claim this listing" page
  that is `noindex`.

---

## 13. Thresholds

| Constant | Value | Gates |
|---|---|---|
| `MIN_RATING` | `4.0` (`IMPORT_MIN_RATING`) | Enrich prefilter and qualification |
| `MIN_REVIEWS` | `10` (`IMPORT_MIN_REVIEWS`) | Enrich prefilter and qualification |
| `MAX_IMPORT` | `1000` (`IMPORT_MAX`) | New venues per staging run; upgrades exempt |
| `COUNTY_BOUNDS` | 32.50–33.55 N, -117.65–-116.60 W | Search grid extent, and the normalize box check |
| Grid step / radius | `0.045°` / `2800 m` | Fixed-grid cell size |
| `PAGE_SIZE` | `20` | Truncation signal for adaptive subdivision |
| `--min-radius` | `120 m` | Subdivision floor |
| `--max-calls` | `2000` | Adaptive discovery budget |
| Locator match radius | `400 m` | Locator record → venue |
| Dedupe radius | `120 m` | Same-name venue → same venue |
| Window bounds | `30 min`–`8 h` | Plausible happy hour |
| Deal line length | `60` chars (filter), `42` (chip rewrite) | Deal text |
| `MAX_DEAL_CHIPS` | `6` | Deals stored per venue |
| Crawl budget | 6 pages / 8 fetches | Deep inventory |
| `EVIDENCE_SCORE` | `20` | Below this, fall back to guessed paths |
| API delay | `250 ms` | Between all Places calls |

---

## 14. Known gaps

Honest list. None are currently breaking anything, but all are traps.

- **Google multi-window is lossy.** Only the window covering the most days survives, so a venue
  with a separate late-night happy hour loses it. `lib/google-happy-hour.mjs` implements the full
  multi-window logic but nothing in this path calls it.
- **`upgrade-stubs.mjs` duplicates the merge upgrade path.** Two ways to do the same thing; the
  merge one should win, because it runs as part of the pipeline rather than as a step someone has
  to remember.
- **The stub import hardcodes 4.0 / 10** instead of reading `MIN_RATING` / `MIN_REVIEWS`, so
  changing the env vars moves the happy-hour bar but not the stub bar.
- **Normalize checks the rectangle, not the county.** It calls the bounds box, while staging calls
  the real classifier. Staging currently catches what normalize lets through.
- **`audit-county.mjs` does not run validation** after `--apply`.
- **Neighborhood boxes still overlap** around Carlsbad and Encinitas, the same class of bug that
  mislabelled Cardiff.
- **Discovery coverage is roughly 30–45%.** Two exhaustively probed cells found 6.0× and 3.8× more
  venues than the original fixed grid saw. This is the single largest gap in the dataset.
