# Data sourcing plan and playbook

Where every field on a venue comes from today, where it should come from, what each source costs,
and how often each one has to be re-checked.

**Status, 31 August 2026 — this is the current sourcing plan and it supersedes
`docs/reducing-google-dependency.md` §6, §7 and §8** (the sequenced minimize-Google plan, the
alternative-source assessment and the refresh strategy). Sections 1–5 of that document — the four
pricing questions, the Atmosphere field list and the two fields Atmosphere was bought for — remain
the authority on Google's tiers and are cited rather than restated, as is
`docs/places-api-cost-analysis.md` for the mask-by-mask arithmetic.

**Every count below was read out of `public/data/happy-hours.json` and the code on 31 August 2026,
not carried over from another document.** The catalog stood at **3,006 rows, 686 published, 800 with
a schedule**. Several existing documents quote 3,208 rows and ~690 published; those figures predate
the chain purge and the unlisting work and should not be trusted without re-measuring. How to tell
this page has rotted: re-run the field census in §2 (the `node -e` recipe is at the end of that
section), and check that `scripts/import-google-venues/lib/google-places.mjs` still holds the two
masks §3.1 describes. Prices were last checked against Google's own pages on 31 August 2026 by
`docs/places-api-cost-analysis.md` and have not been re-checked here.

**Nothing in this document is implemented by it.** §2 separates *today* from *should be* in every
row, and §5 and §7 are proposals. Conflating the two has already caused confusion in this repo, so
where a row says "should be" it means nobody has built it.

---

## 1. The rule the rest of the page follows

One sentence, because every specific decision below is an application of it: **a field is sourced
from the party that would know the answer, and where two sources disagree the one closer to the
venue wins.**

That gives a precedence order that holds for almost every field:

1. **The owner**, through a verified claim. Correct by construction, carries no licensing
   restriction, costs nothing per venue, and permanently removes the field from the refresh budget.
2. **An admin edit.** A person who read the page. Same licensing position as a claim, worse
   scalability, better than any automated source.
3. **The venue's own website**, including anything it publishes through a menu platform, a locator
   widget, a sitemap or a PDF. Ours to store and publish indefinitely.
4. **Google Places**, which is a directory of what exists rather than a database of what is on
   offer, and which we rent rather than own.
5. **A derivation of our own data** — coordinates into a neighborhood, deal text into deal types.
   Cheap and free of terms, but it asserts rather than observes, so it goes last and it has to be
   re-derived when its inputs change (`docs/lessons-and-invariants.md` §2.8).

Two consequences worth stating before the table, because they are what makes the ordering more than
a preference. Google Places content is licensed for roughly 30 days of caching with place IDs the
one documented exemption, so **a field we move off Google reduces the bill and the licensing
exposure at once**. And a source closer to the venue is usually also the fresher one: a restaurant
changes its happy hour on its own site months before Google's secondary hours block catches up, if
it ever does.

---

## 2. The field-by-field sourcing map

This is the core of the document. Every meaningful field on a catalog row, what actually populates
it today, what could, and which source is authoritative on a disagreement. Counts are out of 3,006
rows unless the row says otherwise.

Read the "today" column as a statement about the code, not about intent. Four fields in this table
are sourced differently from what an earlier document claimed, and they are called out underneath.

### 2.1 Identity and location

| Field | Present on | Source today | Could come from | Authoritative |
|---|---|---|---|---|
| `id` | 3,006 | Ours. `lib/venue-ids.mjs`, allocated inside San Diego's 1–99,999 band | — | Ours, always |
| `placeId` | 2,590 | Google, discovery | — | Google. The one field licensed to keep forever, and the key that makes any re-fetch targeted |
| `name` | 3,006 | Google `displayName` at import; admin and owner edits override | Website `<title>`, ABC licence trade name, permit `record_name` | **Owner claim, then admin, then Google.** Google's display name is the best automated answer we have |
| `address` | 3,006 | Google `formattedAddress`, captured in the *discovery* mask so most stubs need no Details call | County permit registry, ABC extract, the venue's own contact page | Owner, then Google. Google's postal form is consistent, which matters for dedupe |
| `lat` / `lng` | 3,006 | Google `location` | Geocoding a permit or ABC address (Census batch geocoder, free) | Google, but note this is the field with the explicit 30-day caching term |
| `neighborhood` | 3,006 | **Ours.** `lib/neighborhood-assign.mjs`: boxes, then city, then ZIP, then street regexes, over Google's coordinates and address | A polygon dataset (census places, curated GeoJSON) | Ours. Never Google — it has no field for this and the classifier encodes local knowledge |
| `website` | 3,006 | Google `websiteUri`, filtered by `isUsableVenueWebsite` | OpenStreetMap `website` tag (1,670 in-county, free), owner claim | **Owner, then Google.** 64 rows carry a `wrong_website` scrape outcome, so Google is wrong here often enough to matter |
| `phone` | 2,851 | Google `nationalPhoneNumber` | The venue's contact page — trivially scrapable and we already fetch it | Owner, then website, then Google |
| `vibe` | 1,034 | **Google's `primaryType` and the venue's own name**, through `deriveVenueKind()`. Absent on the other 1,972 rows, and on 519 of 686 published ones; 19 seed rows carry hand-typed kinds | Owner claim, admin edit | **Re-derived 31 Aug 2026** (`docs/vibe-field-audit.md`). The owner claim form is still the best source and is now optional rather than required |

### 2.2 The happy hour itself — the fields the site exists for

| Field | Present on | Source today | Could come from | Authoritative |
|---|---|---|---|---|
| `days`, `startTime`, `endTime` | 800 | Two sources, recorded in `hhSources.times`: **website happy-hour page on 375, Google `HAPPY_HOUR` secondary hours on 198**. 227 of the 800 record no provenance at all | Owner claim, locator payload, Instagram post | **Website, then owner, then Google.** Google's block is a seed: it carries the times and never the offers, and its multi-window handling is lossy (`docs/venue-pipeline-reference.md` §14) |
| `windows` | 384 | Same sources; the structured multi-window form | Same | Same as above |
| `deals` | 3,006 keys, but `dealsUnknown` on 740 | **Venue website only.** `hhSources.deals` names `website_hh_page` on all 391 rows that record it. Google publishes no offer text at any tier | Owner claim, locator widget offer text, menu PDF, Instagram | **Website, then owner.** There is no Google option here and there never will be |
| `dealsUnknown` | 740 | Ours. The honest "we know the window, not the offers" | — | Ours |
| `dealTypes` | 3,006 | **Ours, from deal text**, with Google's cached `servesBeer` / `servesWine` / `servesCocktails` allowed to fill a silence and never to override (`venue-pipeline-reference.md` §5.6) | Menu items, owner claim | **Our deal text.** The booleans say what a venue pours; the text says what it discounts |
| `hhMenu` | 313 | Ours. AI transcription of venue pages, menu platform JSON, PDFs and flyer images | Owner upload through the claim flow | **Owner upload, then our transcription.** An owner's own menu beats any transcription |
| `galleryImages` | 391 entries on 330 rows | **371 are menu boards we typeset ourselves; 20 are scraped from venues** | Owner upload | Ours and the owner's |
| `image` (featured photo) | 599 | **597 are Google Places photo bytes downloaded to `public/images/venues/`; 2 are uploads** | Owner upload, venue website hero image | **Should be the owner, then the website.** Storing Google photo bytes is the hardest thing in the catalog to defend under the terms — `places-api-cost-analysis.md` §2.6 flags it and nothing has changed |
| `hhSources` | 584 | Ours. Per-field source, URL and observation date | — | Ours. This is the provenance record the whole refresh policy in §7 depends on |
| `lastScrape` | 610 | Ours. Outcome, reason, evidence, date | — | Ours |

### 2.3 Amenities and commercial attributes

Every field in this block is Google Atmosphere, bought once by `backfill-atmosphere.mjs` over 2,787
distinct place IDs, and every one keeps true, false and absent distinct.

| Field | Present on | Source today | Could come from | Authoritative |
|---|---|---|---|---|
| `outdoorSeating` | 1,983 | Google Atmosphere | **Owner claim — two checkboxes, not built** | Owner, then Google |
| `allowsDogs` | 1,041 | Google Atmosphere | Owner claim | Owner, then Google |
| `reservable` | 1,975 | Google Atmosphere | The venue's own booking link | Owner, then Google |
| `liveMusic` | 2,069 | Google Atmosphere | Venue events page, Instagram | Owner, then website |
| `restroom` | 2,148 | Google Atmosphere | — | Google |
| `goodForGroups` | 1,592 | Google Atmosphere | Owner claim | Owner, then Google |
| `goodForWatchingSports` | 1,861 | Google Atmosphere | Menu and page text | Owner, then Google |
| `servesVegetarianFood` | 1,572 | Google Atmosphere | Menu text, which we already hold for 313 venues | Menu, then Google |
| `parkingOptions` | 2,483 | Google Atmosphere | Owner claim | Google |
| `paymentOptions` | 2,558 | Google Atmosphere | — | Google |
| `accessibilityOptions` | 2,561 | Google Atmosphere | Owner claim | Owner, then Google |
| `priceLevel` / `priceRange` | 2,125 / 2,090 | Google Enterprise, free at the tier we already pay | Our own menu prices | Google, at no marginal cost |

### 2.4 Editorial state and visibility

None of this is sourced externally, and none of it should ever be.

| Field | Present on | Source | Note |
|---|---|---|---|
| `listingStatus` | 3,006 | Ours | 686 published, 2,320 unlisted |
| `seoHidden` | 2,986 | Ours | Search indexing only, since the split in `docs/homepage-reachability.md` |
| `browseHold` | 55 | Ours | All 55 are `unverified_window` |
| `verified` | 3,006 keys | Ours | **`true` on zero rows.** The field exists and nothing sets it |
| `lastVerifiedAt` | 419 non-null | Ours | Set without `verified` ever being set, which is a contradiction worth resolving before the field is used for anything |
| `weeklySpecials` | 1 | Owner / admin | The claim surface, barely used yet |

### 2.5 The four fields that are not sourced the way the docs implied

Worth naming individually, because each was found by reading the code rather than the prose.

- **`image` is Google photo bytes on 597 of 599 rows.** `fetch-photos.mjs` downloads them. Several
  documents describe photos as "scraped and rendered, ours"; that is true of the *menu boards* in
  `galleryImages` and false of the featured photo.
- **`vibe` was entirely Google's type taxonomy**, and one third of the catalog sat on the fallback
  `Restaurant`. Audited and re-derived on 31 August 2026: the old derivation read Google's whole
  `types` array, which made `Cocktail bar` right on 17 of 506 rows. It now reads the committed
  `primaryType` and the venue's own name, and is absent on 1,972 of 3,006 rows rather than guessed.
  See `docs/vibe-field-audit.md`.
- **`address` comes from the discovery mask, not from Place Details**, for most stubs. That saving
  is real and already banked, and it means a stub costs nothing beyond the Nearby Search call.
- **Happy-hour provenance is missing on 227 of 800 scheduled rows.** The 198/375 split above is the
  recorded half only. Any refresh policy that keys off `hhSources` has a 28% blind spot on day one,
  and §7 treats those rows as maximally stale rather than as unknown.

Reproduce the census with:

```
node -e "const r=require('./public/data/happy-hours.json');const k={};for(const v of r)for(const f of Object.keys(v))k[f]=(k[f]||0)+1;console.log(r.length,k)"
```

---

## 3. Source inventory — what is actually in use

For each: what it reliably gives, what it does not, what it costs, how fresh it is, and what the
terms permit.

### 3.1 Google Places

Two masks in `lib/google-places.mjs`, plus two special-purpose ones. Tier arithmetic is
`places-api-cost-analysis.md` §1; only the sourcing consequences are here.

| Call | Tier and rate | Gives us | Does not give us |
|---|---|---|---|
| Nearby Search (discovery) | Enterprise, $35/1k, 1,000 free/month | Place IDs, name, coordinates, rating, review count, business status, **formatted address** | Website, happy hour, anything per-venue in depth. Truncates at 20 results |
| Place Details (default) | Enterprise, $20/1k, 1,000 free/month | `websiteUri`, `regularSecondaryOpeningHours`, phone, price level, regular hours, address components | Offer text, menus, anything about what a happy hour contains |
| Place Details + Atmosphere | Enterprise + Atmosphere, $25/1k | The amenity block in §2.3 | Patio quality, dog policy detail, anything a person would write |
| Place Details Photos | $7/1k, 1,000 free/month | Photo bytes | A licence to store them comfortably |
| Place Details Essentials | $5/1k, 10,000 free/month | Address only, for stubs. Largely obsolete now discovery captures the address | Everything else |

- **Freshness:** good on existence and closure, poor on happy hours. Google's `HAPPY_HOUR` block was
  present on 1,260 of 5,361 enriched places (24%) and its content is times only.
- **Terms:** place IDs storable indefinitely; latitude and longitude cacheable 30 consecutive days;
  everything else is a roughly 30-day performance cache, not an archive. Displayed Google content
  needs attribution. We are not currently clean on this — the committed catalog holds Google-origin
  names, addresses, coordinates and photo bytes — and that is a known, deliberate exposure recorded
  in `places-api-cost-analysis.md` §2.6, not something this plan discovers.
- **Verdict:** keep, narrowly. §5.

### 3.2 The venue's own website

The most valuable source in the system and the only one that is unambiguously ours.

- **Gives:** happy-hour windows (375 rows), all offer text without exception (391 rows), menus (313),
  menu flyers, and implicitly whether the business is still trading.
- **Does not give:** existence — you cannot crawl a site you have not been told about; consistent
  structure; or any guarantee the page is about *this* branch. 64 rows carry `wrong_website` and 48
  carry `other_location`, so roughly a fifth of scrape outcomes are an ownership problem rather than
  an extraction one.
- **How it is read**, cheapest first: fixed path probe (`/happy-hour`, `/specials`, `/menu`, …), then
  sitemap and in-page link discovery, then a Playwright render for JavaScript shells, then the model.
- **Cost:** HTTP fetches are free. The model call is §6.3. No proxy budget today, which is a latent
  cost if a scraping-defence vendor decides otherwise.
- **Terms:** facts about a business's own prices and hours, republished with attribution to the page
  they came from. No caching restriction. This is why the extraction cascade, not the Google
  integration, is the asset.
- **Freshness:** as fresh as the venue keeps it, which is the best available and still not perfect.
- **Verdict:** the default source for everything it can answer.

### 3.3 Store locator widgets

`lib/locator-widgets.mjs` detects **Storepoint, Stockist and StoreRocket** by script-tag signature,
plus a generic `collectLocationRecordsFromJson` walk that reads any locator-shaped JSON payload.

- **Yext and Bullseye are not implemented.** They were named in the brief; the code does not detect
  them. The generic JSON walk may happen to read a Bullseye payload if something else points us at
  the endpoint, but nothing detects either platform. Adding a signature each is a small change and
  §4.7 is where it sits in priority.
- **Gives:** per-branch offer text that exists nowhere on the rendered page. Board & Brew's
  `$2 off all pints` lives only in a Storepoint payload. Also addresses and sometimes hours.
- **Does not give:** anything for a single-location independent, which is most of the interesting
  catalog. Locators exist for chains, and the fast-food blocklist removes most chains.
- **Cost:** $0. The Text Search calls `seed-from-locators.mjs` makes use a Pro-tier mask and sit
  inside the 5,000 free monthly calls.
- **Terms:** the venue's own data, published by the venue's own vendor.
- **Verdict:** keep, extend opportunistically to local mini-chains, expect little volume.

### 3.4 Sitemaps

`lib/sitemap-discover.mjs` reads `robots.txt`, `/sitemap.xml` and `/sitemap_index.xml`, follows
sitemap indexes, and scores the URLs it finds (60 for a specials-and-happy-hour URL down to 20 for a
menu, 0 for privacy and careers).

- **Gives:** a target list of pages worth fetching, which is what keeps the crawl budget at 6 pages
  and 8 fetches per venue.
- **Does not give:** any field directly. It is a discovery mechanism inside a site, not a source.
- **Cost:** $0, one or two fetches.
- **Verdict:** keep. It is the reason guessed paths are consulted only when nothing discovered scores
  ≥ 20, which is the right precedence (`lessons-and-invariants.md` §2.4).

### 3.5 PDFs

`lib/pdf-raster.mjs` rasterises a PDF so the model can read it; `lib/menu-flyers.mjs` handles image
menus the same way.

- **Gives:** happy-hour menus on venues that publish a PDF and nothing else.
- **Does not give:** cheap reading. A rasterised page is an image block on a model call, so this is
  the most expensive path per venue in the cascade.
- **Terms:** the venue's own document.
- **Verdict:** keep, and keep it last in the cascade, which it is.

### 3.6 Structured markup on venue sites

Two different things, and only one of them is in use.

- **Menu-platform JSON is read and it is the highest-yield trick in the codebase.**
  `lib/json-menu-extract.mjs` walks the JSON that Popmenu, BentoBox, Toast and Square render menus
  from, shape-based rather than platform-based. The DOM shows one section; the JSON holds all of
  them. `porting-to-a-new-city.md` §8.1 calls reading a page's JSON rather than its DOM the single
  most reusable lesson in the project, and that is right.
- **Schema.org JSON-LD is not read at all.** Nothing in `scripts/` parses `application/ld+json`. We
  *emit* it for our own SEO and we have never consumed it from a venue. A `Restaurant` node commonly
  carries `telephone`, `address`, `openingHoursSpecification`, `servesCuisine`, `priceRange` and
  sometimes `hasMenu` — several fields we currently buy from Google. This is the cheapest unbuilt
  improvement on the page and it is in §4.8.

### 3.7 Owner claims

- **Gives:** in principle every field, correct by construction. In practice, almost nothing yet —
  one row carries `weeklySpecials`, two carry an uploaded featured photo.
- **Does not give:** coverage. It is owner-driven and slow.
- **Cost:** $0 per venue; the cost is building and marketing the flow.
- **Terms:** none. This is the only source with no expiry.
- **Verdict:** the strategic answer to almost everything in §2, and the least built. Every claim
  permanently removes a venue from the refresh budget.

### 3.8 Admin edits

- **Gives:** name, address, coordinates, window, deals, deal types, vibe, website, phone, featured
  photo and its framing, through `src/lib/listingForm.ts` and `venue_overrides`.
- **Does not give:** scale, and it has no provenance record. An admin edit does not write
  `hhSources`, so a hand-corrected window is indistinguishable from an unprovenanced import.
- **Verdict:** keep, and give it a provenance stamp. That is a small change and §7 depends on it.

---

## 4. Candidate sources not yet used

Assessed honestly. Four of these are worth building and the rest are not, and saying which is the
point of the section.

### 4.1 San Diego County food-facility permits — build this

The Socrata endpoint at `data.sandiegocounty.gov/resource/c5ez-ufrd.json` held 15,906 records when
queried on 31 August 2026, of which **8,493 are restaurants with an active permit** and 11,634 are
food businesses of all kinds. Public domain, $0, last updated 10 August 2026.

- **Could authoritatively supply:** the existence of a food business at an address, and the arrival
  of a new one. It is a name-and-address list of every restaurant in the county, which is precisely
  what discovery buys at $35/1k.
- **Cannot supply:** website, phone, rating, place ID, or coordinates — the latitude and longitude
  columns exist and are empty on every row, so free geocoding (Census batch, Nominatim) is required.
  A permit is also not a bar; a drinks-only venue with no food permit is missing.
- **Verdict: build.** Best coverage per hour of anything here, and it converts discovery from a grid
  sweep into targeted lookups.

### 4.2 California ABC liquor licences — build this second

Daily statewide CSV exports from the ABC, plus a monthly **geocoded** San Diego extract from
SanGIS/SANDAG, which solves the permit registry's geocoding problem. Free, public record.

- **Could authoritatively supply:** whether a venue can legally discount drinks at all. On-sale types
  41, 47, 48, 42, 40 and 61 are the relevant ones. That makes this both a discovery source and a
  **qualification filter**, and arguably a better one than a star rating. It also covers the
  bar-shaped gap in §4.1, and licence transfers are a leading indicator of ownership change.
- **Cannot supply:** anything about the happy hour.
- **Verdict: build**, starting from the SanGIS extract rather than the raw statewide file. SanGIS
  notes roughly 5% of records fail to geocode.

### 4.3 OpenStreetMap and Overpass — build the narrow version

An Overpass count over `COUNTY_BOUNDS` for `amenity` in `restaurant|bar|pub|cafe|biergarten|nightclub`
returned **4,654 features on 31 August 2026, of which 1,670 carry a `website` tag** (36%).

- **Could authoritatively supply:** `websiteUri` for free, which is the field we pay Enterprise for.
  Occasionally `opening_hours` in happy-hour syntax, too rarely to plan around.
- **Cannot supply:** discovery at our coverage. 4,654 against 5,714 discovered Google candidates and
  an 8,493-restaurant permit floor is roughly a third of the county, and closures linger for years.
- **The licence is the catch.** ODbL is share-alike, so publishing OSM-derived fields may oblige us
  to license our derived database under ODbL. Using OSM as a **private cross-check** is
  unambiguously fine; publishing an OSM-sourced website URL is a decision someone has to make, and it
  is stickier than the Google question because it touches data we own.
- **Verdict: build as a private cross-check and a closure pre-signal.** Do not publish OSM fields
  until the ODbL question is answered deliberately.

### 4.4 Foursquare OS Places — measure before building

Apache 2.0, which is the cleanest licence on this page. Access moved in October 2025 from a public S3
bucket to a Places Portal account and an Iceberg catalog.

- **Could authoritatively supply:** POI existence, category and some attributes, with no share-alike
  and no caching term. If coverage is good this is the only candidate that could genuinely replace
  part of Google discovery.
- **Unknown:** county coverage. Global datasets are usually thin on small independents, which is
  exactly our population. It is free to find out and nobody has.
- **Verdict: measure.** A county-bounded extract and a match against the catalog is a day's work and
  it settles a question the whole plan turns on. Do not build on it before measuring.

### 4.5 Instagram and Facebook business pages — worth it, but not systematically

This is where a real share of happy-hour announcements actually live, and one scrape reason in the
catalog says so explicitly: a venue whose homepage and Instagram handle "only confirm location and
social presence".

- **Could authoritatively supply:** current offers, one-off and seasonal changes, and event-driven
  happy hours that never reach a website.
- **Cost and terms are the blocker.** Meta's platform terms and rate limits make systematic
  collection impractical, and the Instagram Graph API only reaches accounts that have granted access
  — which is the claim flow with more steps.
- **Verdict: not as a pipeline.** Worth two narrower things: storing the venue's Instagram handle
  when we find one, so an admin or an owner can check it; and treating "the site says nothing but the
  Instagram bio mentions happy hour" as a signal to ask the owner rather than to publish.

### 4.6 Health department inspection registries — no

San Diego's inspection grades come from the same county health department as §4.1 and add a letter
grade to a record we would already hold.

- **Verdict: no.** A grade is not a happy hour, it is not a discovery signal beyond what the permit
  file already gives, and displaying restaurant hygiene grades on a bar directory invites a support
  burden we have no reason to take on.

### 4.7 Yext and Bullseye locator support — small, cheap, do it opportunistically

Named in the brief and genuinely not implemented (§3.3). Each is one signature and one payload
shape. The honest expectation is low yield, for the same structural reason as §3.3: these are
enterprise multi-location platforms, and the multi-location brands they serve are largely on the
blocklist.

- **Verdict: add a signature when a real venue is found using one**, not speculatively.

### 4.8 Schema.org JSON-LD on venue sites — the cheapest unbuilt item

Covered in §3.6. A `Restaurant` node routinely carries phone, address, price range and
`openingHoursSpecification`; some carry `hasMenu`. We fetch the HTML already, so the marginal cost of
parsing it is zero fetches and zero model calls.

- **Could authoritatively supply:** `phone` and regular hours off Google entirely, and a structured
  cross-check on address. It will not carry happy-hour windows — `openingHoursSpecification` models
  trading hours, not secondary hours — so it does not touch the fields that matter most.
- **Verdict: build.** Small, free, no terms question, and it removes a Google field.

### 4.9 Yelp Fusion — no, and the reasoning is unchanged

Coverage is genuinely comparable to Google's; everything else is worse. Pricing is a subscription
($229/month Base for 30,000 calls, a 5,000/day cap, per-1,000 overages), caching is capped at **24
hours** against Google's 30 days, display requirements are onerous, and the terms explicitly prohibit
using Yelp content to train or fine-tune generative models — which our extraction cascade's AI
fallback makes an awkward question. Our entire full-county Google run is budgeted at $350 once; Yelp
Base is $229 every month forever.

- **Verdict: no.** Restated here only because it is the alternative people reach for first.

### 4.10 Everything else considered

| Source | Assessment |
|---|---|
| **Overture Maps** | Permissive licence, partly the same upstreams as Foursquare OS Places. Evaluate alongside §4.4, not instead of it; the marginal gain over FSQ is probably small |
| **City of San Diego business-tax certificates** | Free and enormous, no usable category field for filtering to food service, and city-only rather than county. Weak next to §4.1 |
| **Google Business Profile / Place Actions** | Owner-verified data direct from the venue, but each owner has to grant access. This is our claim flow with an extra dependency |
| **Apple Maps / MapKit JS** | Free tier exists, terms forbid storage, no bulk search. Swapping one directory dependency for a more restrictive one |
| **Bing / Azure Maps** | Priced comparably to Google with worse US local coverage. No reason |
| **OpenTable, Resy, Toast, SevenRooms** | Real hours and menu data, no public bulk API. Scrapable per venue where a venue uses one, which the menu-platform JSON walk in §3.6 already partly does. Not a discovery source |
| **Eventbrite, Meetup, DoStuff and similar event platforms** | Event listings, not recurring windows. A trivia night is `entertainment` at best, and the matching problem (event venue name to catalog row) is the same fuzzy-address work as §4.1 for a much thinner payoff. No |
| **Untappd, BeerAdvocate** | Brewery-shaped and check-in-driven. No happy-hour field, restrictive terms. No |

---

## 5. The recommended configuration

**In one sentence: keep Google for four things — the place ID, the fact that a venue exists at a
coordinate, whether it is still trading, and the website URL to scrape — and source everything a
visitor actually reads from the venue, the owner, or our own derivation.**

The owner's framing is minimum Google, not zero Google, and that distinction decides three separate
questions.

### 5.1 What genuinely requires Google

- **Discovery at full coverage.** No free source has both the completeness and the freshness of a
  commercially maintained POI index for one metro. Permits (§4.1) plus ABC (§4.2) plus OSM (§4.3)
  narrow it considerably — permits alone give a target list of 8,493 restaurant addresses — but they
  enumerate rather than enrich, and none of them hands us a place ID or a website.
- **`businessStatus`.** A closed venue on a happy-hour site is the failure mode that costs trust
  fastest, because somebody drove there. Permit lapse lags by months; a website going dark has decent
  precision and poor recall. Crucially this is a **Pro** field, so a mask of `id` + `businessStatus` +
  `displayName` bills at Place Details Pro with 5,000 free calls a month. The status check is free at
  our scale, which is what makes the whole configuration work.
- **`websiteUri`.** Enterprise, and the input to every scrape. OSM covers 1,670 venues for free and
  cannot be published under ODbL without a decision, so it is a cross-check rather than a
  replacement. Schema.org markup (§4.8) does not help, because you need the site before you can read
  its markup.
- **`rating` and `userRatingCount` at enrich time only.** They cost $3/1k over a $32/1k Nearby Search
  floor and they let enrich reject roughly a quarter of candidates before spending $20/1k. They pay
  for themselves several times over as a *spend gate*. Publishing them is a separate decision that
  buys nothing and decays silently.

### 5.2 What could be replaced, and what it would cost in quality

| Google field | Replacement | Quality cost |
|---|---|---|
| `nationalPhoneNumber` | Schema.org markup or the contact page | Near zero. Some coverage loss on sites with no markup and no contact page |
| `vibe` input (`primaryType`) | Owner claim, admin | Small. The `types` half is already gone and the venue's own name already answers where it can; `primaryType` supplies the rest, and a venue nobody has claimed simply carries no kind |
| `regularOpeningHours` | Schema.org `openingHoursSpecification` | Small loss in coverage, and it is free at the tier we already pay, so there is no reason to hurry |
| `HAPPY_HOUR` secondary hours | Website scrape | Real loss. 198 catalog rows have their window from Google and nowhere else, and a chunk of those venues publish nothing online. Keep it — it rides free on a Details call we make anyway |
| Photo bytes | Owner uploads, then venue site hero images | Coverage collapses from 597 to ~2 overnight. This is the field where the terms argument and the quality argument point in opposite directions, and it needs an owner decision rather than a default |
| `rating` on the page | Nothing; remove it | None. Its job is gating our spend, which happens once, in memory, at enrich time |
| Amenity block | Owner claim checkboxes | Coverage falls to whatever owners fill in, which is currently nothing. Already bought once, so the sensible move is to let claims overwrite rather than to stop asking |

### 5.3 What the configuration looks like in practice

1. **Discovery:** permits and ABC produce a monthly target list of addresses. Google Text Search
   resolves the new ones to place IDs. The grid sweep runs once more to close the 30–45% coverage gap
   and then stops being the primary mechanism.
2. **Enrichment:** one Place Details Enterprise call per genuinely new venue, wide mask, because
   every Essentials and Pro field rides free once `websiteUri` sets the price. Atmosphere once per
   venue and never on refresh — a patio does not appear monthly.
3. **Extraction:** unchanged, and it is the asset. Google's `HAPPY_HOUR` block first because it is
   already paid for, then the site, then locators, then the model behind the
   `siteMentionsHappyHour` gate.
4. **Status:** a Pro-tier `businessStatus` mask on a rotation, prioritised by free signals — website
   liveness, permit lapse, claim age.
5. **Publication:** prefer owner and website data on every field a visitor reads. Stop publishing
   Google ratings. Decide the photo question explicitly.

---

## 6. Costs

Split the way the owner asked: paid APIs first, our own scraping and AI second, and the ongoing
maintenance number separately from first acquisition. **Where a figure is measured it says so and
names the artifact; where it is extrapolated it gives the method.**

### 6.1 One-time, per city — paid APIs

| Line | Cost | Basis |
|---|---|---|
| Full-county discovery and enrichment | **$350** (range $190–$600) | Modelled, not invoiced. `places-api-cost-analysis.md` §3: ~7,500 Nearby Search Enterprise calls at $35/1k plus ~5,700 Place Details Enterprise at $20/1k, less ~$55 of monthly free allowance |
| Atmosphere premium on that run | +$29 | Modelled. The +$5/1k step over 5,722 expected Details calls |
| Atmosphere backfill over the existing catalog | **$69.68, measured** | 2,787 distinct place IDs at $25/1k list, zero failures. $44.68 if the month's 1,000-call allowance was intact |
| One photo each for ~4,000 venues | ~$21 | Modelled. Place Details Photos at $7/1k with 1,000 free |
| Permits, ABC, OSM, Foursquare loaders | **$0** | All four sources are free. The cost is engineering, not licence |
| **Total, first city, paid APIs** | **~$400–$470** | The $350 run plus Atmosphere plus photos |

Money already spent on San Diego, for reference: roughly 2,722 Nearby Search and 5,361 Place Details
calls, plus the measured $69.68 backfill. The $350 is what the *remaining* 60–70% of the county
costs, not a re-purchase.

Two ways to reduce that number that cost nothing: draw a tighter northern bound (Orange and Riverside
venues are 5–8% of Details spend and get discarded), and phase the run across calendar months to
collect the per-SKU free allowance more than once (~$55 per extra month).

### 6.2 Recurring monthly — paid APIs

At the current scale this is **$0/month**, and that is a real answer rather than a rounding.

| Line | Calls/month | SKU | Cost |
|---|---|---|---|
| Status re-check, 686 published venues, quarterly rotation | ~230 | Place Details Pro — $17/1k, 5,000 free | $0 |
| Details on genuinely new venues from permits, ~40 | ~40 | Place Details Enterprise — $20/1k, 1,000 free | $0 |
| Text Search resolving permit addresses to place IDs | ~100 | Text Search Pro — $32/1k, 5,000 free | $0 |
| Photo bytes for new venues | ~40 | Place Details Photos — $7/1k, 1,000 free | $0 |
| Permits, ABC, OSM refresh | — | free feeds | $0 |
| **Total** | | | **$0** |

The line that makes it work is the status check being a **Pro** field. The current pipeline buys that
information at the Enterprise rate as a side effect of a wide mask, which is right on a capture run
and wrong on a refresh.

**When $0 stops being true.** The Pro allowance is 5,000 calls a month. A monthly status check on
every published venue exceeds it at roughly 5,000 published venues; a quarterly rotation exceeds it
at roughly 15,000. San Diego at full coverage will not get there. A fifth city might, and the answer
then is a longer rotation on unclaimed venues, not a bigger bill — at 20,000 venues on a quarterly
rotation the overage is about 1,700 calls a month, or $29.

### 6.3 Our own scraping and AI processing

Measured figures first.

| Measurement | Cost | Source |
|---|---|---|
| Capped-menu re-scrape, 268 model calls over 72 venues, three reads each | **$4.53** | `docs/capped-menu-rescrape.md`. Works out at **$0.0169 per call** |
| Re-reading all 611 listings the same way | **~$30** | Extrapolated in that document from the per-call rate: 611 venues × ~2.9 calls × $0.0169 ≈ $30 |
| Per-venue extraction on Haiku | $0.012–$0.023 | `porting-to-a-new-city.md` §6 |
| AI fallback during a full import run | ~$0.26 | The `siteMentionsHappyHour` gate is what makes this $0.26 rather than ~$40 |
| HTTP fetching, sitemap reads, locator payloads, Playwright renders | **$0** | Bandwidth and local CPU only. No proxy spend today |

Accounting is built in: `lib/ai-usage.mjs` records tokens and cost per purpose on every call, at
$1.00/$5.00 per million input/output tokens for `claude-haiku-4-5`, so any run can say where its money
went rather than being attributed by guesswork.

Extrapolated figures, with method stated:

| Line | Estimate | Method |
|---|---|---|
| Full first-pass extraction over a new city's ~800 scheduled venues | **$10–$18** | 800 × $0.012–$0.023, the measured per-venue Haiku range |
| Menu transcription over the venues that have a menu to read | **$5–$8** | 313 menus in San Diego at the measured $0.0169/call, single read; triple that for a consensus pass |
| Menu-board rendering | ~$0.02/board | 371 boards rendered; the board call runs at an 8,192-token output budget, so it sits at the top of the per-call range |
| PDF and flyer reads | $0.05–$0.10 each | Rasterised pages are image blocks. Small volume, and no separate measurement exists — this is the honest guess |

The load-bearing point about the AI half of the bill: **it is small and it is bounded by gates, not by
budget.** Three reads over the whole catalog is $30. The reason to be careful is not the money, it is
`lessons-and-invariants.md` §2.11 — an extractor quotes accurately and understands nothing, 12 of 22
proposed recoveries survived a hand check, so the constraint on AI processing is human acceptance
capacity, not dollars.

### 6.4 The maintenance number

This is the figure nobody has written down, and `porting-to-a-new-city.md` §8.3 lists its absence as
an open question. Here is a model. **It is extrapolated throughout; the only measured inputs are the
$0.0169 per model call and the free-tier arithmetic.**

Assume 686 published venues, 800 with a schedule, and the cadence in §7.

| Line | Frequency | Model calls/year | Cost/year |
|---|---|---|---|
| Deal and window re-read, venues with a schedule, quarterly, single read | 4× 800 | 3,200 | **$54** |
| Consensus three-read pass on menus, annually over 313 | 1× 313 × 2.9 | 908 | **$15** |
| New-venue extraction, ~40/month | 12× 40 | ~480 | **$8** |
| AI fallback on import runs, ~$0.26 a run, monthly | 12 | — | **$3** |
| Google status, discovery and Details | monthly | — | **$0** (§6.2) |
| Permits, ABC, OSM feeds | monthly | — | **$0** |
| **Steady-state total** | | | **~$80/year, or under $7/month** |

Three honest caveats on that number.

- **It excludes engineering time entirely**, which is the real recurring cost. A county portal schema
  change is a silent breakage, and the loaders in §4.1 and §4.2 need the same "assert what you
  expected" treatment as the rest of the pipeline.
- **It assumes the hand-review bottleneck is free.** It is not. At the measured 12-of-22 acceptance
  rate, a quarterly pass proposing a few hundred changes is several hours of somebody reading pages.
- **It scales with published venues, not with catalog size.** Ten cities at this shape is roughly
  $800/year of model spend and ten times the review burden, and the review burden is what breaks
  first.

---

## 7. Refresh and staleness policy

A sourcing plan usually fails here, so this section says three things per field: how often, what
triggers a refresh out of cadence, and how a reader can tell a stale record from a current one.

### 7.1 Cadence

| Field | Cadence | Why that cadence |
|---|---|---|
| Happy-hour window and deals, published venues | **Quarterly** | This is what changes. A venue moves happy hour from 3–6 to 4–7 for the summer and tells nobody but its own site |
| Happy-hour window, unlisted stubs | **Never on a schedule** | They publish no window. They are upgraded when a claim or a discovery pass finds one |
| Menus | **Annually**, and on any deal-text change | Prices move slower than windows, and a menu re-read is the most expensive call in the cascade |
| `businessStatus` | **Quarterly rotation, prioritised** | The trust-critical field, and free at Pro |
| New venues | **Monthly** | Permits and ABC both publish new records promptly |
| Website URL | **On scrape failure only** | A dead fetch is the trigger; there is no value in re-buying a URL that worked last week |
| Amenities (Atmosphere) | **Once, ever** | Structural. A patio does not appear monthly. Overwritten by a claim, never re-bought |
| `rating`, `priceLevel` | **Never** once we stop publishing them | Their job is gating spend at enrich time |
| Address, coordinates, phone | **On evidence of change** — a permit record, an ABC transfer, a failed geocode | Stable fields. Re-fetching them on a clock is the shape of spending that made Google feel expensive |
| Claimed venues | **Owner-driven** | A claim removes the venue from the refresh budget until the owner changes something |
| Neighborhood, `dealTypes`, and every other derivation | **Whenever an input changes** | Not a refresh, a re-derivation. `npm run rederive:deal-types`, `--dry-run` first |

### 7.2 Triggers that pull a refresh forward

None of these is on a clock. Each is a reason to re-check a venue now.

- **The venue's website stops resolving, or starts returning a challenge page.** We crawl every site
  already; recording when one starts failing is the cheapest closure pre-signal available and it is
  not instrumented today.
- **A permit lapses or an ABC licence transfers.** Lapse is slow evidence of closure; a licence
  transfer is fast evidence of new ownership, and new ownership changes the happy hour.
- **A new permit appears at an address we already hold.** Usually a rebrand.
- **A claim arrives.** Everything the owner touches is authoritative from that moment; everything
  they do not touch is still ours to keep current.
- **A user report on the venue page.** Near-zero cost, unbounded latency, needs moderation. Not built.
- **A scrape outcome changes category** — a venue that read `found` last quarter and reads
  `wrong_website` this quarter has changed something.

### 7.3 How to tell a stale record from a current one

This is where the catalog is weakest, and the honest statement is that **for a large minority of rows
staleness is currently undetectable.**

What exists:

- `hhSources.times.observedAt` and `hhSources.deals.observedAt` — per-field source, URL and date.
  Present on 584 rows; **all 557 dated `times` observations are from August 2026**, so the whole
  catalog is currently fresh and the field has not yet been tested against real ageing.
- `lastScrape.observedAt` and `lastScrape.outcome` — on 610 rows, all August 2026. Outcomes today:
  358 `found`, 111 `not_published`, 64 `wrong_website`, 48 `other_location`, 27 `no_candidates`, 2
  `extract_failed`.
- `hhMenu.sourceUrl` and `hhMenu.observedAt` — **on only 73 of 313 stored menus**, because
  `normalizeMenuBoard` used to rebuild a board from `note` and `sections` alone and dropped
  provenance on every re-render. That bug is fixed; the 240 rows it already damaged cannot be
  backfilled from nothing.

What is missing, in priority order:

1. **227 of 800 scheduled rows record no window provenance at all.** Treat them as maximally stale:
   they are the first cohort a re-read should touch, and no surface should describe them as
   confirmed.
2. **Admin edits write no provenance.** A hand-corrected window looks exactly like an unprovenanced
   import. One field on the edit path fixes this.
3. **`verified` is `true` on zero rows while `lastVerifiedAt` is set on 419.** Two fields disagreeing
   about the same question is worse than one field being empty. Resolve before either is used for
   display or for prioritising a refresh.
4. **Nothing computes an age.** With `observedAt` populated, "the offers on this page were read from
   the venue's site on 29 August 2026" is a one-line render and the single most honest thing a
   directory of afternoon prices can say. It also makes the staleness policy visible to the person
   best placed to fix it: the owner.

### 7.4 The rule to apply when two sources disagree

Precedence from §1 decides it, with one refinement that matters in practice: **a newer observation
from a lower-precedence source does not beat an older observation from a higher one, but it does
trigger a re-check of the higher one.** If Google's `HAPPY_HOUR` block says 4–7 and the venue's own
page said 3–6 in March, the answer stays 3–6 and the site goes to the front of the re-scrape queue.
Silently taking the newer value is how a cheap signal quietly wins, which is
`lessons-and-invariants.md` §2.4 in a different subsystem.

---

## 8. What this plan does not settle

Stated so nobody reads the sections above as more decided than they are.

- **The Google caching terms are still a judgement call**, and the featured photo is the sharpest
  instance of it: 597 rows hold downloaded Google photo bytes. §5.2 gives the trade; it does not make
  the choice.
- **The ODbL question on OpenStreetMap** is unanswered and needs answering before any OSM-sourced
  field is published rather than cross-checked.
- **Foursquare coverage is unmeasured**, and it is the one measurement that could change §5.
- **Nothing here is implemented.** The four build recommendations — permits, ABC, OSM cross-check,
  JSON-LD parsing — are proposals with no code behind them.
- **The maintenance number in §6.4 is a model, not an invoice.** The first real quarterly refresh
  cycle is what turns it into a measurement, and it should be written back into this section when it
  happens.

---

## Sources

Repository artifacts read on 31 August 2026: `public/data/happy-hours.json`,
`scripts/import-google-venues/lib/google-places.mjs`, `normalize.mjs`, `locator-widgets.mjs`,
`sitemap-discover.mjs`, `json-menu-extract.mjs`, `ai-usage.mjs`, `fetch-photos.mjs`, and
`src/lib/listingForm.ts`.

Companion documents, none of whose arithmetic is repeated here:

- `docs/places-api-cost-analysis.md` — field tiers, masks, the caching terms, the $350 budget
  derivation, and the measured Atmosphere fill rates.
- `docs/reducing-google-dependency.md` — the four Google pricing questions and the Atmosphere
  decision. §6, §7 and §8 of it are superseded by this page.
- `docs/venue-pipeline-reference.md` — the gate-by-gate specification these sourcing decisions sit
  inside.
- `docs/lessons-and-invariants.md` — why provenance, precedence and three-state absence are treated
  the way they are above.
- `docs/capped-menu-rescrape.md` — the $4.53 / 268-call measurement underneath §6.3.
- `docs/window-only-listings.md` — why 740 rows carry `dealsUnknown` and what a re-read recovers.
- `docs/porting-to-a-new-city.md` — the per-city work this plan's costs attach to.

External sources, all checked 31 August 2026 by the two documents above and not re-checked here:
Google Maps Platform pricing and service-specific terms, the San Diego County Food Facility Permits
Socrata endpoint, California ABC licensing reports and the SanGIS ABC extract, the Overpass API,
Foursquare OS Places access documentation, and the Yelp API terms of use.
