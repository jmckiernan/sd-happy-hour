# Reducing the Google Dependency

Four questions the owner asked about Places API pricing, and a plan for needing Google as little as
possible without losing coverage or accuracy.

This builds on `docs/places-api-cost-analysis.md`, which works out the tiers, the field masks and
the budget for a full county run. That document is the baseline; this one does not repeat its
arithmetic. Where a number here comes from it, it is cited rather than restated.

Pricing was re-checked against Google's own pages on **31 August 2026** and is unchanged from the
cost analysis. Every count attributed to the catalog or the caches was read out of
`public/data/happy-hours.json` and `.data/import/google/enriched.json` on the same date. Third-party
figures (OpenStreetMap, San Diego County permits) were queried live, and the queries are recorded so
they can be re-run.

---

## 1. Is Atmosphere a monthly fee?

No. There is no subscription anywhere in Google Maps Platform pricing, and nothing about Atmosphere
is billed monthly. The model has three parts and no fourth:

1. **You pay per request.** Every Places call is one billable event. There is no seat licence, no
   plan, no minimum commitment, and no way to buy a tier for a month.
2. **The price of a request is set by the highest-tier field in the mask.** The `X-Goog-FieldMask`
   header decides which SKU the call lands on. "Enterprise + Atmosphere" is not a plan you are on;
   it is the name of the SKU a *single call* gets billed at when its mask contains at least one
   Atmosphere field. The next call, with a narrower mask, is billed at Enterprise again.
3. **Each SKU carries its own free monthly allowance**, which resets on the first of the month and
   does not roll over. Essentials SKUs get 10,000 free calls a month, Pro 5,000, Enterprise 1,000 —
   per SKU, not pooled. So Place Details Enterprise and Place Details Enterprise + Atmosphere have
   *separate* 1,000-call allowances, and using one does not consume the other.

Two consequences worth having straight, because they are the ones that mislead people:

- **Turning Atmosphere "on" costs nothing.** Adding the fields to a mask that never runs costs $0.
  The `IMPORT_CAPTURE_ALL` flag in `lib/google-places.mjs` is safe to leave in the codebase
  indefinitely; only invoking it spends money.
- **Mixing masks is not only allowed, it is the whole technique.** A run that buys Atmosphere for
  3,000 venues and plain Enterprise for 20,000 pays $25/1k on the first and $20/1k on the second.
  The tiers are per call, so the correct question is never "should we be on Atmosphere" but "which
  calls deserve it".

The $200-a-month blanket credit that people remember was retired on **1 March 2025** and replaced by
the per-SKU allowances above. That is the change that makes the field mask the dominant lever on the
bill. List prices themselves have not moved since; Google's own FAQ on the change says so
explicitly, and the rates in the cost analysis §1.1 still match the pricing page today.

## 2. Is Atmosphere above Enterprise, and what is in it?

Atmosphere is not a fifth tier. It is a **suffix on the Enterprise SKU** — the full name is "Place
Details Enterprise + Atmosphere". There are three named categories in Google Maps Platform
(Essentials, Pro, Enterprise), and Atmosphere is a surcharged variant of the Enterprise SKU for
requests that ask for venue-attribute content. So the ladder is four price points across three
categories.

### 2.1 The ladder, per 1,000 calls

Place Details, US/Canada list price, 0–100,000 monthly band:

| SKU | Category | Per 1,000 | Free/month |
|---|---|---|---|
| Place Details Essentials (IDs Only) | Essentials | $0.00 | unlimited |
| Place Details Essentials | Essentials | $5.00 | 10,000 |
| Place Details Pro | Pro | $17.00 | 5,000 |
| Place Details Enterprise | Enterprise | $20.00 | 1,000 |
| Place Details Enterprise + Atmosphere | Enterprise | $25.00 | 1,000 |

Nearby Search has no Essentials rung at all: Pro $32, Enterprise $35, Enterprise + Atmosphere $40.
Text Search matches Nearby Search. Place Details Photos, the separate SKU for fetching photo *bytes*,
is $7/1k with 1,000 free.

So the Atmosphere step on Place Details is **+$5/1k, a flat 25% on the call**. On the expected 5,722
Details calls of a full county run that is +$29 (cost analysis §2.5).

### 2.2 What is in each category

The field lists below are the ones the cost analysis §2.2 walks through with a keep-or-drop verdict
for each. Summarised by category rather than repeated:

- **Essentials, IDs only (free):** `id`, `name`, `photos` (metadata only), `attributions`,
  `consumerAlert`, `movedPlace`, `movedPlaceId`.
- **Essentials ($5/1k):** the address and geometry block — `addressComponents`,
  `formattedAddress`, `shortFormattedAddress`, `postalAddress`, `adrFormatAddress`,
  `addressDescriptor`, `location`, `viewport`, `plusCode`, `types`.
- **Pro ($17/1k):** identity and presentation — `displayName`, `businessStatus`, `primaryType`,
  `primaryTypeDisplayName`, `googleMapsTypeLabel`, `googleMapsUri`, `googleMapsLinks`,
  `iconMaskBaseUri`, `iconBackgroundColor`, `accessibilityOptions`, `timeZone`,
  `utcOffsetMinutes`, `subDestinations`, `containingPlaces`, `openingDate`,
  `pureServiceAreaBusiness`.
- **Enterprise ($20/1k):** the commercially valuable core — `websiteUri`,
  `nationalPhoneNumber`, `internationalPhoneNumber`, `rating`, `userRatingCount`, `priceLevel`,
  `priceRange`, `regularOpeningHours`, `currentOpeningHours`, **`regularSecondaryOpeningHours`**,
  `currentSecondaryOpeningHours`, `transitStation`.

Two Enterprise fields are why this pipeline exists at Enterprise and cannot drop below it:
`websiteUri` (the domain every scrape starts from) and `regularSecondaryOpeningHours` (Google's own
`HAPPY_HOUR` block, present on 1,260 of our 5,361 enriched places). Cost analysis §1.3 spells out
that an Essentials-only mask leaves the pipeline with no input at any of its four extraction
sources.

### 2.3 The Atmosphere field list, in full

This is the one open purchasing decision, so here is the complete set rather than a summary. Grouped
by what it is, with what it would mean for us.

**Alcohol and menu service** — booleans, all of them:
`servesBeer`, `servesWine`, `servesCocktails`, `servesBreakfast`, `servesLunch`, `servesDinner`,
`servesBrunch`, `servesDessert`, `servesCoffee`, `servesVegetarianFood`.

**Space and atmosphere:**
`outdoorSeating`, `liveMusic`, `goodForGroups`, `goodForChildren`, `goodForWatchingSports`,
`allowsDogs`, `restroom`, `menuForChildren`.

**Transaction and logistics:**
`reservable`, `takeout`, `delivery`, `dineIn`, `curbsidePickup`, `parkingOptions`, `paymentOptions`.

**Google-authored text and reviews:**
`editorialSummary`, `reviews`, `reviewSummary`, `generativeSummary`, `neighborhoodSummary`.

**Inapplicable to us:**
`evChargeOptions`, `evChargeAmenitySummary`, `fuelOptions`, `containedInPlaceReviews` and the
routing summaries that only exist on the search endpoints.

Note the pricing implication of that last group being in the same bucket as the first: because
billing is by tier and not by field, `reviews` is *free* once any Atmosphere field is in the mask.
We still exclude it, on terms and cache-size grounds rather than cost — see cost analysis §2.6.

## 3. Where do `dealTypes` and `features` actually come from?

The owner's belief is that these come from the venue's own website. That is **partly true for
`dealTypes` and essentially false for `features`.** The code is in
`scripts/import-google-venues/lib/normalize.mjs`.

### 3.1 What the code does

`inferDealTypes(deals, types)` concatenates the scraped deal strings **and Google's place `types`
array** into one lowercased blob and runs six regexes over it. Then:

```
if (!found.size) found.add('food');
```

So a venue that matches nothing is labelled `food`. The website contributes, but Google's taxonomy
contributes to the same blob and cannot be told apart afterwards, and the fallback fires whenever
neither does.

`inferFeatures(types, vibe)` never sees the website at all. Its inputs are Google's `types` and the
`vibe` string, itself derived from `primaryType` and `types`. It seeds `'casual'` unconditionally,
tries five regexes, and filters the result to `FEATURES`. The regexes look for `rooftop`,
`waterfront|harbor|bay|beach`, `upscale|fine_dining`, `date|romantic`, `group|sports` — vocabulary
that Google's place-type taxonomy does not use. `patio` and `dog friendly` are in `FEATURES` and no
rule can ever produce them.

So the owner's reading is the one to correct: `features` is not website-derived, it is a constant
with two rare exceptions.

### 3.2 The distribution, measured

`features` across all 3,208 catalog venues:

| Value | Venues | Share |
|---|---|---|
| `casual` | 3,193 | 99.5% |
| `group friendly` | 215 | 6.7% |
| `upscale` | 43 | 1.3% |
| `date night` | 13 | 0.4% |
| `patio` | 5 | 0.2% |
| `dog friendly` | 2 | 0.06% |
| `waterfront` | 1 | 0.03% |
| `rooftop` | 1 | 0.03% |

And as whole combinations, which is more damning than the per-value counts:

| Feature set | Venues |
|---|---|
| `casual` alone | 2,942 |
| `casual` + `group friendly` | 206 |
| `casual` + `upscale` | 38 |
| everything else (21 distinct combinations) | 22 |

**Stated bluntly: `features` carries almost no information.** 91.7% of the catalog has the identical
value `casual`, and 99.5% has `casual` somewhere in it. A filter on `casual` is a filter that returns
everything. The 22 venues with interesting feature sets are hand-curated rows carrying vocabulary
outside `FEATURES` entirely (`speakeasy`, `tiki`, `gastropub`, `chef-driven`, `mexican`) — they were
typed by a person, not inferred, which is why they are the only ones that read like real editorial
data. The 5 `patio` and 2 `dog friendly` venues are in that hand-curated set. The importer has never
produced either.

Cross-checking against the cache confirms the mechanism exactly. Running the `inferFeatures` regexes
over the `types` arrays of all 5,361 enriched places yields `group friendly` on 249 and `upscale` on
47, and **zero** for `rooftop`, `waterfront` and `date night`. The published counts of 215 and 43
are those numbers surviving the county and quality filters. Nothing else in `features` came from
inference at all.

`dealTypes` across the 800 venues that have a schedule (the 2,408 claimable stubs carry `[]` by
design):

| Value | Venues | Share of 800 |
|---|---|---|
| `food` | 767 | 95.9% |
| `cocktails` | 146 | 18.3% |
| `wine` | 110 | 13.8% |
| `beer` | 91 | 11.4% |
| `entertainment` | 48 | 6.0% |
| `oysters` | 12 | 1.5% |

525 of the 800 have `dealTypes` exactly `['food']` and nothing else. The reason `food` is on 96% of
the catalog is not that 96% of happy hours discount food; it is that the regex
`/food|taco|appetizer|snack|bite|pizza|burger/` matches Google's `types` array on **4,876 of 5,361
places (91%)**, because Google tags essentially every eating establishment with the literal type
`food`. The word is in the taxonomy, so the regex hits, so every venue gets a `food` deal type
whether or not it discounts food.

### 3.3 A separate problem found while measuring this

Re-deriving `dealTypes` from each venue's *own published deal text*, ignoring Google types and the
fallback, disagrees with what is stored on **735 of 800** venues. Only 65 match exactly.

| Direction of disagreement | Venues |
|---|---|
| Deal text names something the stored `dealTypes` omits | 255 |
| Stored `dealTypes` has a value the deal text cannot explain | 622 |

The omissions are the interesting half. 210 venues have deal text containing "beer", "draft" or
"pint" and do **not** carry `beer`. 167 mention wine without carrying `wine`; 133 mention cocktails
without carrying `cocktails`; 15 mention oysters without carrying `oysters`. Meanwhile `food` appears
on 576 venues whose deal text gives no reason for it.

The stored values are stale — set at import time and never recomputed as deal text was cleaned,
compressed and refreshed by `clean-deal-text.mjs`, `compress-deals.mjs` and `refresh-deals.mjs`. So
the field is not merely coarse, it actively contradicts data we already own and publish on the same
page. That is a bug fixable with a local re-derivation and no API call, and it is worth more than
anything Google could sell us. See §6, step 1.

### 3.4 Answer, in one paragraph

`dealTypes` is a blend of scraped deal text and Google's place taxonomy with a `food` default that
fires on 91% of places through the taxonomy alone, and its stored values are additionally out of
date with respect to the deal text on 735 of 800 venues. `features` does not touch the website at
all; it is `casual` for 91.7% of the catalog, with `group friendly` and `upscale` from Google's
`types` and everything else hand-typed. Neither field is website-derived in the way the owner
believed, and `features` is presently closer to a constant than to data.

## 4. Would Atmosphere actually fix them?

Partly, and for less than the cost analysis assumed — because **we already own some of it.**

### 4.1 We have already paid for the alcohol booleans

An earlier run, before `servesBeer`/`servesWine`/`servesCocktails` were removed from the mask, wrote
them into `.data/import/google/enriched.json`. They are still there:

| Field | `true` | `false` | absent |
|---|---|---|---|
| `servesBeer` | 2,343 | 1,604 | 1,414 |
| `servesWine` | 1,885 | 1,751 | 1,725 |
| `servesCocktails` | 1,538 | 1,897 | 1,926 |

3,226 of the 3,804 qualified places (85%) carry at least one of the three. That is the single
highest-value Atmosphere subset already sitting on disk at a cost of $0. Wiring it into
`inferDealTypes` is a code change against a local file. (It is also Places content under the 30-day
caching term — cost analysis §2.6 — so the honest framing is that we hold it and it is ageing, not
that we own it.)

### 4.2 Field-by-field mapping

| Our value | Atmosphere field | Would it help? |
|---|---|---|
| `dealTypes: beer` | `servesBeer` | Yes. Currently the `types` regex fires on 56 of 5,361 places; the boolean is true on 2,343 |
| `dealTypes: wine` | `servesWine` | Yes. 184 from types, versus 1,885 true |
| `dealTypes: cocktails` | `servesCocktails` | Yes. 194 from types, versus 1,538 true |
| `dealTypes: food` | `servesLunch`, `servesDinner`, `dineIn` | No, and it makes it worse. These are true almost everywhere, exactly like the current `food` default |
| `dealTypes: entertainment` | `liveMusic` | Partly. A real signal, but narrower than "trivia night" |
| `dealTypes: oysters` | — | No field. Menu text only |
| `features: patio` | `outdoorSeating` | **Yes, and it is the strongest case on the page.** Currently unreachable by any rule; the field is a direct answer |
| `features: dog friendly` | `allowsDogs` | Yes, same argument, 2 venues today |
| `features: group friendly` | `goodForGroups` | Modest improvement on a `types` regex that already yields 249 |
| `features: rooftop` | — | No field. Nothing in Places models this |
| `features: waterfront` | — | No field. Derivable from our own coordinates against a coastline, which is better |
| `features: date night` | — | No field. `priceLevel` (already free at Enterprise) is a closer proxy |
| `features: upscale` | — | No field. `priceLevel` and `priceRange`, both free at the tier we pay |
| `features: casual` | — | No field, and the value should probably not exist |

### 4.3 Recommendation

**Yes to Atmosphere on the full-county capture run, at +$29 expected — but it is now the third
priority, not the first.** The reasoning has shifted since the cost analysis was written, for two
reasons that measurement turned up:

1. **The largest gain is free.** The alcohol booleans are already cached for 3,226 qualified places.
   Reading them costs nothing and moves `beer`, `wine` and `cocktails` from 56/184/194 inferred to
   2,343/1,885/1,538 known. That is the bulk of the `dealTypes` improvement, available today.
2. **The second-largest gain is also free.** Re-deriving `dealTypes` from our own deal text fixes
   735 venues. No Atmosphere field addresses staleness, and buying data to layer on top of a stale
   field would hide the bug rather than fix it.

What Atmosphere still buys that we cannot get otherwise is `outdoorSeating` and `allowsDogs`. Those
map to `patio` and `dog friendly`, which no rule can currently produce and which our scrapers do not
reliably find either — a venue's website rarely says "we have a patio" in machine-readable form. At
+$29 across a full run, roughly $0.005 per venue, for the only two fields that would give `features`
any variance at all, that is worth buying **once**, on the capture run, behind
`IMPORT_CAPTURE_ALL=1`.

Three qualifications on that yes:

- **Not on refresh runs**, ever. These are structural attributes; a patio does not appear monthly.
  Buy once, and the flag already defaults off.
- **Not on Nearby Search.** $35 → $40/1k for per-venue attributes on a call that truncates at 20
  results, buying nothing Details does not. Cost analysis §2.5 declines this and it stays declined.
- **Not as a backfill batch over the 5,361 already-enriched places.** $134 to re-purchase a $107
  base. Let the refresh cadence pick them up.

And the honest bound on the upside: even with Atmosphere, `features` would gain real data on maybe a
few hundred venues out of several thousand, because most restaurants have no patio and do not allow
dogs. A field that is `casual` on 99.5% of rows becomes a field with two useful booleans on perhaps
15% of rows. Better, but this is not the fix for `features`. The fix for `features` is to decide what
the field is for — see §6, step 2.

---

# The minimize-Google plan

The framing to hold onto: Google is not a database we are renting badly, it is a **directory we
need for one thing and are using for six.** The one thing is knowing that a business exists at a
location and is trading. Everything else on a venue page either already comes from somewhere we
control, or could.

That framing also carries the terms-of-service benefit, which is not a side note. Places content is
licensed for 30-day caching with place IDs exempt (cost analysis §2.6). Data we scrape from a
venue's own site, or that an owner types into a claim form, has **no such restriction** — we can
store it, publish it, and never re-fetch it. So every field we move off Google reduces the bill and
the legal exposure at the same time, and those two motives point the same direction, which is rare
and worth exploiting.

## 5. What Google is genuinely hard to replace

### 5.1 Discovery: that a venue exists at all

**Hard to replace at full coverage; partly replaceable at the margin.**

This is Google's real moat. No free source has both the completeness and the freshness of a
commercially maintained POI index for a specific metro. But "partly replaceable" is worth more than
it sounds, because our discovery bill is dominated by *searching squares that turn out to be empty
or already known*. A prior list of addresses to check turns discovery from a grid sweep into
targeted lookups, and §7 gets several such lists for free.

The honest limit: the county permit registry (§7.3) tells us a restaurant exists at an address, but
not its Google place ID, its website, its rating, or whether it has a happy hour. It replaces the
*enumeration*, not the enrichment.

### 5.2 Operational status: that it is still trading

**Not replaceable from a free source at acceptable latency, and the most durable reason to keep
paying.**

`businessStatus` is Google's single most valuable field for us and one of its cheapest — it is Pro,
free at the tier we already pay. Restaurants close constantly and quietly. A closed venue on a
happy-hour site is the failure mode that costs trust fastest, because someone drove there.

The plausible substitutes are all worse:

- **Permit lapse** (§7.3) is a real closure signal and genuinely free, but it lags by months; a
  permit stays "Issued" well past the last service.
- **The venue's own website going dark** is a good signal and we already crawl every site. Cheap to
  instrument, decent precision, poor recall — plenty of closed restaurants leave the site up.
- **User reports** on the venue page: near-zero cost, unbounded latency, needs moderation.

Realistic posture: keep a cheap Google status re-check as the backstop, and use the free signals to
*prioritise* which venues get one. That is §8.

### 5.3 Rating and review count as a quality bar

**Replaceable in function, not in kind — and the cheapest thing on the list to keep.**

Ratings and review counts cost $3/1k over the unavoidable $32 Nearby Search Pro floor, and having
them inside the search response is what lets enrich reject a quarter of candidates before spending
$20/1k on Details. They pay for themselves several times over. There is no argument for dropping
them.

Where they should stop being used is **display**. A frozen 4.2★ is a correctness problem as well as
a terms problem: it decays silently, and it is the field most likely to be wrong on a page nobody
has refreshed in a year. The rating's job is to gate our own spend, which happens once, in memory,
at enrich time. Publishing it is a separate decision that we get nothing for.

Note too that the quality bar itself is a business decision, not a fact. A venue with a verified
happy hour and 8 reviews is more useful to this site than a 4.6★ coffee shop with none. As our own
happy-hour signal improves, the rating gate matters less.

## 6. What we can and should source ourselves

| Field | Source today | Should be | Notes |
|---|---|---|---|
| Happy-hour window | Google `regularSecondaryOpeningHours` (1,260) and website scrape | Ours already, mostly | The scrape is the durable half; Google's block is a useful seed |
| Deal text | Venue website | Ours, no restriction | Already the case |
| `dealTypes` | Google `types` + deal text + `food` default | **Our deal text alone** | §3.3: fixes 735 venues, costs nothing |
| `features` | Google `types` + `casual` seed | Ours: menu text, coordinates, claims | §3.2: currently a constant |
| `vibe` | Google `primaryType` | Ours or curated | 1,085 of 3,208 are the fallback `Restaurant` |
| Menus and photos | Scraped and rendered | Ours | Already; `render-menu-boards.mjs` |
| Regular hours | Google Enterprise (free at tier) | Scrapable, low priority | Free where we already pay |
| Address, coordinates | Google | Google, or permits + geocoding | 30-day caching term applies |
| Phone | Google | Claims, then scrape | Trivially scrapable from a contact page |
| Rating | Google | Google, enrich-time only | §5.3: keep for gating, stop publishing |
| `businessStatus` | Google | Google, prioritised by free signals | §5.2 |
| Everything on a claimed venue | Mixed | The owner | The highest-quality source we have |

### The sequenced plan

**Now — no API calls, no new dependencies.**

1. **Re-derive `dealTypes` from deal text only.** Drop `types` from the blob and drop the `food`
   default; a venue with no derivable deal type should carry `[]`, the same way `dealsUnknown`
   already says "we know the window, not the offers". Fixes the 735 disagreements, removes a
   meaningless `food` from ~576 venues, and puts `beer`/`wine`/`cocktails` on the 210/167/133 that
   earned them. **Saves:** $0 directly, but it is the largest accuracy gain available at any price
   and it removes a Google input entirely.
2. **Decide what `features` is for, then rebuild it.** Options, roughly in order of value:
   `waterfront` from our own coordinates against a coastline polygon (we have lat/lng; this is pure
   computation); `upscale` from `priceLevel`, already free at the Enterprise tier we pay; `patio`,
   `dog friendly`, `rooftop`, `games` from menu and page text, which the scrapers already fetch; and
   the rest from claims. Drop `casual` — a value on 99.5% of rows is not a feature, it is noise, and
   it makes the field look populated when it is not. **Saves:** removes the last Google input to
   `features`.
3. **Read the alcohol booleans already in the cache** (§4.1) as an interim `dealTypes` signal for
   the 3,226 places that have them, clearly marked as Google-derived so it can be aged out.
   **Saves:** the whole `beer`/`wine`/`cocktails` improvement, for free, today.
4. **Stop publishing Google-sourced ratings**, or mark them with a fetch date and treat them as
   expiring. **Saves:** the most-exposed field in the catalog, at no cost.
5. **Tighten the northern county bound.** Free, and stops us buying Orange and Riverside venues we
   discard — 5–8% of Details spend (cost analysis §3.5).

**Next — one-time engineering, then permanent leverage.**

6. **Load the San Diego County food-facility permit registry** (§7.3) and diff it against the
   catalog by normalised address. This is the highest-value new source by a distance: it is free,
   public-domain, county-specific, and it produces a *list of addresses Google discovery has not
   found*. Then spend Details on those addresses specifically rather than sweeping empty grid
   squares. **Saves:** the largest slice of the $263 expected discovery cost, by replacing breadth-
   first search with a target list.
7. **Load Foursquare OS Places and OpenStreetMap as cross-checks** (§7.1, §7.2). Neither is
   complete, but the union with permits narrows what only Google can tell us.
8. **Instrument website-liveness as a closure pre-signal.** We crawl every venue site already;
   record when one starts failing, and use that to prioritise status re-checks rather than
   re-checking everything.
9. **Make claiming the primary path for everything else.** An owner-supplied patio flag, menu and
   window is better data than any API sells, carries no caching restriction, and costs nothing per
   venue. Every claim permanently removes a venue from the refresh budget.

**Later — only if the earlier steps prove out.**

10. **Full-county capture run with `IMPORT_CAPTURE_ALL=1`**, informed by the permit target list, so
    the Atmosphere premium is paid on a smaller and better-chosen set of venues than the current
    $350 budget assumes.
11. **Reduce Google to an identity-and-status service.** Long-run target: place ID as the permanent
    key (licensed indefinitely), a periodic `businessStatus` check, and nothing else in the mask
    that we publish.

## 7. Alternative sources, assessed

### 7.1 OpenStreetMap / Overpass API

**Coverage, measured live on 31 August 2026.** An Overpass count over `COUNTY_BOUNDS` for
`amenity` in `restaurant|bar|pub|cafe|biergarten|nightclub` returns **4,654 features** (3,743 nodes,
911 ways). Of those, **1,670 carry a `website` tag** — 36%.

That 4,654 is against our 5,714 discovered Google candidates and an estimated true population of
12,700–19,000, so OSM is somewhere around a third of the county and is not a discovery replacement.
But 1,670 websites is a real asset: `website` is the field we pay Enterprise for, and OSM's copy is
free. `opening_hours` occasionally carries happy-hour syntax too, though rarely enough not to plan
around.

- **Freshness:** community-driven. Excellent in dense urban cores, poor in strip malls, and closures
  lag badly — a closed restaurant can sit in OSM for years.
- **Licensing:** ODbL. Free and permanent, but it is a *share-alike* licence. Publishing a derived
  database may oblige us to license our derived data under ODbL too. Using OSM as a private
  cross-check is unambiguously fine; using OSM-sourced fields as published content needs a decision
  the same way the Google terms do, and it is a stickier one because it touches our own data.
- **Cost:** $0. Overpass is free with rate limits; the county extract is a small download.
- **Effort:** low. One Overpass query, address normalisation, a fuzzy match. A day.
- **Verdict:** worth doing as a cross-check and a free source of `websiteUri`. Not a discovery
  replacement. Keep the ODbL question separate from the Google one.

### 7.2 Foursquare / FSQ OS Places

Foursquare open-sourced its global POI dataset in November 2024 under **Apache 2.0** — a permissive
licence with attribution and no share-alike, which makes it legally the cleanest option on this
page. 100M+ POIs, 1,000+ categories, 20+ core attributes.

- **Access changed in October 2025.** The public S3 bucket is deprecated. Current access is a free
  Places Portal account, an access token, and an Iceberg catalog queried via DuckDB, Spark,
  PyIceberg or ClickHouse; also available on Snowflake, Databricks Marketplace and Hugging Face.
- **Coverage:** unmeasured here, because it needs an account and a query engine. Global datasets are
  usually thinner than Google on small independent venues, which is exactly our population, so
  temper expectations. Worth measuring rather than assuming — it is free to find out.
- **Freshness:** monthly releases with deltas. Fine for discovery, too slow for closures.
- **Cost:** $0.
- **Effort:** medium. An Iceberg client and a county-bounded extract is more setup than an Overpass
  query, but it is a one-time pipeline and the monthly delta feed is genuinely useful afterwards.
- **Verdict:** the best-licensed alternative and the one most worth evaluating properly. Measure
  county coverage before building anything on it.

### 7.3 San Diego County food-facility permits

**This is the find.** The county's open-data portal publishes every permitted food facility at
`data.sandiegocounty.gov/resource/c5ez-ufrd.json` (Socrata). Queried live on 31 August 2026:

| | |
|---|---|
| Total records | 15,906 |
| `Restaurant Food Facility`, active permit | **8,493** |
| Plus deli markets, low-risk, retail processing, miscellaneous | 11,634 |
| Last updated | 10 August 2026 |
| Licence | public domain |
| Cost | $0 |

Columns: `record_id`, `record_name`, `permit_status`, `active_permit`, `business_type`, `address`,
`city`, `zip`, `permit_owner_full`, `record_issue_date`, `last_updated`, `latitude`, `longitude`.

Two things make this the highest-value item on the page. First, **8,493 active restaurant permits is
an independent measurement of a population we have only ever estimated.** The cost analysis §3.1
estimated 12,700–19,000 places in the search rectangle from a coverage guess; the permit registry
says 8,493 restaurants and 11,634 food businesses of all kinds, which lands near the low end and
suggests the $581 HIGH case is too pessimistic. Second, it is a **name-and-address list of every
restaurant in the county**, which is precisely what discovery is buying at $35/1k.

Honest limits, and they are real:

- **`latitude` and `longitude` exist as columns and are empty on every row.** Geocoding is required.
  Free options (Census Bureau batch geocoder, Nominatim) work adequately on US street addresses.
- **No website, no phone, no rating, no place ID.** It replaces enumeration, not enrichment.
- **`record_name` is the permit holder's trade name**, which is often but not always the public
  name, and franchise records can be idiosyncratic. Matching to the catalog needs address
  normalisation, not name matching.
- **A permit is not a bar.** It covers restaurants, and it will miss a bar with no food permit.
  Pair it with ABC licences (§7.4) for that gap.
- **Freshness cuts one way.** New permits appear promptly, which is a genuinely good new-venue
  signal. Lapses are slow, so it is weak evidence of closure.
- **Effort:** low to medium. One Socrata query, address normalisation, a free geocoder, a diff. A
  few days, and it pays back on every discovery run afterwards.
- **Verdict: do this next.** Best coverage-per-hour of anything on this page.

### 7.4 California ABC liquor licences

The state Department of Alcoholic Beverage Control publishes daily, weekly and monthly exports of
all pending and active licences as CSV, free. SANDAG/SanGIS additionally publishes a **geocoded**
San Diego County extract monthly, in Shapefile, CSV, GeoJSON and JSON, which solves the geocoding
problem the permit registry has. (The ABC export URLs move; go via
`abc.ca.gov/licensing/licensing-reports/` rather than hardcoding a path.)

The relevant licence types are the on-sale ones: 41 (beer and wine, eating place), 47 (general,
eating place), 48 (general, public premises — bars and nightclubs), 42, 40, 61.

- **Why it matters more here than it would elsewhere:** this is a *happy hour* site. A venue with an
  on-sale licence can discount drinks; one without cannot have the kind of happy hour we index.
  That makes ABC data both a discovery source and a **qualification filter** — arguably a better one
  than a star rating, and it is free. It also directly covers the bar-shaped gap in §7.3.
- **Freshness:** daily. The best of any free source here, and licence transfers are a leading
  indicator of ownership change.
- **Licensing:** public record, no restriction.
- **Cost:** $0.
- **Effort:** medium. The raw file is fixed-width ASCII or CSV statewide and needs filtering,
  parsing and matching; the SanGIS extract is pre-filtered and pre-geocoded and is the sane starting
  point. SanGIS notes ~5% of records fail to geocode.
- **Verdict:** worth building, second to permits. Strongest as a *filter* on candidates rather than
  as a discovery source on its own.

### 7.5 Yelp Fusion

**Do not build on this.** Not because of coverage — Yelp's restaurant coverage is genuinely
comparable to Google's — but because the terms and the pricing are both worse for our shape of use.

- **Pricing is a subscription**, which is the thing the owner asked whether Google had and Google
  does not: $229/month Base, $299 Enhanced, $643 Premium, each 30,000 calls with a 5,000/day cap and
  per-1,000 overages ($5.91–$14.13). A 30-day trial gives 5,000 calls. Our entire full-county Google
  run is budgeted at $350 *once*; the Yelp Base plan is $229 *every month*, forever.
- **Caching is capped at 24 hours**, versus Google's 30 days. Strictly worse for a static site
  generator, and it makes a committed JSON catalog untenable rather than merely arguable. Business
  IDs may be stored, for back-end matching only.
- **Display requirements are onerous:** prominent Yelp logo, official Yelp-branded stars, no
  blending ratings with other sources, mandatory "Read Reviews" links back to Yelp, no removing
  tracking parameters.
- **Explicit prohibitions that bite us:** no using Yelp content to train or fine-tune generative
  models without written approval (the extraction cascade has an AI fallback), no semantic analysis
  or rating-trend incorporation without approval, and no building competing Yelp alternatives.
- **Verdict:** more expensive, more restrictive, and a licence that arguably forbids what we do.
  Skip it.

### 7.6 Chain store locators

Already exploited by `seed-from-locators.mjs`, and worth noting as the pattern that works: a
locator page is the venue's own data, freely scrapable, carrying addresses and often hours. The Text
Search calls it makes are Pro-tier and fit inside the free 5,000/month, so it costs $0 today.

The limit is structural: locators exist for chains, and chains are the venues we deliberately
exclude via the fast-food blocklist. The independents that make up the interesting catalog have one
location and no locator. Keep it, extend it opportunistically to local mini-chains, expect little.

### 7.7 Others considered

| Source | Assessment |
|---|---|
| **Overture Maps Foundation** | Open POI data from Meta, Microsoft, Amazon, TomTom under a permissive licence, partly derived from the same upstreams as Foursquare OS Places. Evaluate alongside §7.2 rather than instead of it; the marginal gain over FSQ may be small |
| **City of San Diego business-tax certificates** | Every business licensed in the city, free. Enormous and mostly irrelevant — no category field usable for filtering to food service, and it is city-only, not county. Weak next to §7.3 |
| **Google Business Profile / Place Actions** | Owner-verified data direct from the venue, but requires each owner to grant access. This is our claims flow with more steps |
| **Apple Maps / MapKit JS** | Free tier exists, but the terms forbid storage and it has no bulk search; also a directory we would then depend on |
| **Bing / Azure Maps Local Search** | Priced comparably to Google with worse US local coverage. No reason to switch |
| **OpenTable / Resy / Toast** | Restaurant-side platforms with real hours and menu data and no public bulk API. Scrapable per-venue where a venue uses one; not a discovery source |
| **Instagram / Facebook pages** | Where a lot of real happy-hour announcements actually live, and the hardest to obtain legitimately. Meta's terms and rate limits make systematic use impractical |

## 8. Refresh strategy and steady-state cost

The point of refreshing is not to keep a copy of Google current. It is to answer two questions —
**has something closed, and has something opened** — and to satisfy the 30-day caching term on the
Google-sourced fields we still publish.

### What needs Google, and how often

| What | Source | Cadence | Why |
|---|---|---|---|
| Closures on published venues | Google `businessStatus` | Quarterly, prioritised | The failure mode that costs trust. Prioritise by website-liveness failures, permit lapses and claim age; a venue whose site is healthy and whose owner logged in last month does not need a call |
| Closures on claimable stubs | permits + website liveness | Annually, free | 2,518 unlisted stubs are not on browse surfaces. A wrong stub costs little |
| New venues | permits (§7.3) + ABC (§7.4) | Monthly, free | Both publish new records promptly. Google discovery becomes the follow-up on a target list, not the sweep |
| Place ID validity | Google | On demand | IDs are storable indefinitely and rarely change |
| Happy-hour windows and deals | our scrapers | Existing `refresh-deals` cadence | Ours, no restriction, no cost |
| Ratings | Google, enrich-time | Never, if we stop publishing | §5.3 |
| Atmosphere attributes | Google, capture run | Once | Structural. A patio does not move |
| Menus, photos, hours | scrape and claims | Existing | Ours |
| Claimed venues | the owner | Owner-driven | Best data we have, and it removes the venue from the refresh budget entirely |

### Steady-state monthly estimate

Assume the plan is in place: ~800 published venues plus a growing claimed set, permits and ABC
carrying new-venue discovery, Google reduced to prioritised status checks and targeted Details on
genuinely new addresses.

| Line | Calls/month | SKU | Cost |
|---|---|---|---|
| Status re-check, 800 published on a quarterly rotation | ~270 | Place Details Pro ($17/1k, 5,000 free) | $0 |
| Details on new venues found via permits, say 40/month | ~40 | Place Details Enterprise ($20/1k, 1,000 free) | $0 |
| Targeted Nearby/Text Search to resolve permit addresses to place IDs | ~100 | Text Search Pro ($32/1k, 5,000 free) | $0 |
| Photo bytes for new venues | ~40 | Place Details Photos ($7/1k, 1,000 free) | $0 |

**Steady state is $0/month**, comfortably inside the free per-SKU allowances, and that is the point
of the whole exercise. The status check is the line that makes it work: `businessStatus` is a Pro
field, so a mask of `id` + `businessStatus` + `displayName` bills at Place Details Pro with 5,000
free calls a month — enough to re-check every published venue *monthly* and still pay nothing. The
current pipeline has been buying that information at the Enterprise rate as a side effect of a
wide mask, which is the right thing to do on a capture run and the wrong thing on a refresh.

What still costs money is the one-time capture run: $350 as budgeted, and less than that if the
permit target list lands first and replaces part of the grid sweep.

The residual risks, stated plainly. The permit and ABC feeds have to be maintained; a county portal
schema change is a silent breakage, so those loaders need the same "assert what you expected"
treatment the rest of the pipeline has. And $0/month is only true while the venue count is in the
low thousands — at 20,000 published venues the quarterly status rotation alone exceeds the free Pro
allowance, and the answer then is a longer rotation on unclaimed venues, not a bigger bill.

---

## Sources

All checked 31 August 2026.

- [Google Maps Platform pricing list](https://developers.google.com/maps/billing-and-pricing/pricing)
  — per-SKU rates and volume bands.
- [Pricing categories](https://developers.google.com/maps/billing-and-pricing/pricing-categories)
  — Essentials/Pro/Enterprise definitions, and the 10,000 / 5,000 / 1,000 free monthly caps per SKU.
- [Places API usage and billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing)
  — the SKU table, and billing at the highest applicable SKU.
- [Place Details (New)](https://developers.google.com/maps/documentation/places/web-service/place-details)
  — the authoritative field lists per category, including the Atmosphere list in §2.3.
- [Google Maps Platform: up to 10,000 monthly free calls per product](https://mapsplatform.google.com/resources/blog/start-building-today-with-up-to-10-000-monthly-free-calls-per-product/)
  — Google's own statement that list prices did not change on 1 March 2025, only the credit model.
- [Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
  — place-ID caching exemption and the 30-day latitude/longitude term.
- [Policies and attributions for Places API](https://developers.google.com/maps/documentation/places/web-service/policies)
  — the no-pre-fetch, no-cache, no-store rule.
- [Foursquare OS Places access documentation](https://docs.foursquare.com/data-products/docs/access-fsq-os-places)
  and [Evolving FSQ Open Source Places](https://foursquare.com/resources/blog/data/evolving-fsq-open-source-places/)
  — Apache 2.0 licence, and the October 2025 move from public S3 to the Places Portal Iceberg catalog.
- [Overpass API](https://overpass-api.de/api/interpreter) — the 4,654 and 1,670 counts in §7.1, from
  an `out count` query over `COUNTY_BOUNDS`. ODbL.
- [San Diego County Food Facility Permits](https://data.sandiegocounty.gov/Health/Food-Facility-Permits/c5ez-ufrd)
  — the counts in §7.3, from the Socrata endpoint `resource/c5ez-ufrd.json`.
- [California ABC licensing reports](https://www.abc.ca.gov/licensing/licensing-reports/) and the
  [SanGIS ABC_Licenses dataset](https://geo.sandag.org/server/rest/directories/downloads/ABC_Licenses.pdf)
  — daily statewide CSV exports, and the monthly geocoded San Diego extract.
- [Yelp API Terms of Use, 9 September 2025](https://terms.yelp.com/developers/api_terms/20250909_en_us/)
  and [Yelp data licensing pricing](https://business.yelp.com/data/resources/pricing/)
  — the 24-hour caching cap, the display requirements, and the monthly plan prices.
- `docs/places-api-cost-analysis.md` — tiers, masks, terms and the full-run budget this plan
  assumes.
