# Porting to a new city

What it would take to run this pipeline somewhere other than San Diego, what carries over for free,
what has to be rebuilt by hand, and what would break silently if nobody looked.

This is a living document. San Diego is the only city we have actually built, so most of what
follows is reasoning from the code rather than experience. Section 8 is the place to record what a
second city actually teaches us — append there rather than rewriting the claims above it.

For what each gate does and why, see `docs/venue-pipeline-reference.md`. This page does not repeat
those rules; it only says which of them are about restaurants and which are about San Diego.
For Google Places pricing, field tiers, the caching terms and the derivation of the cost estimates,
see `docs/places-api-cost-analysis.md` — quoted here only where it changes a porting decision.
Constants and counts here were read out of the code.

---

## 1. The short version

- **Most of the pipeline is not about San Diego.** The extraction cascade and the roughly twenty
  guards around it encode how American restaurants write web pages. They should port unchanged.
- **The per-city work is bounded and mostly geographic**: a bounds rectangle, a county name, a
  neighborhood classifier, editorial copy, and a handful of regional chain names. The neighborhood
  classifier is the bulk of it — expect about a week per metro.
- **Three things are not engineering problems and should be settled before any of the above.** Happy
  hour is restricted or banned in some states, the data model assumes exactly one city, and Google's
  terms do not let us buy the Places data outright.
- **Discovery is the dominant cost and it scales with density**, so a larger metro costs more than
  San Diego did, not the same.
- **A city is a recurring obligation, not a purchase.** Google's terms permit keeping place IDs
  indefinitely and almost nothing else, so every city added is another dataset with a shelf life.
  What we genuinely own is the scraped happy hours, the owner claims, and the editorial copy —
  which is the same reason the extraction pipeline, not the Google integration, is the asset.

---

## 2. What ports as-is

None of this is San Diego-specific and none of it should be touched for a new city. It is also the
most expensive part of the system to have built, because almost every line of it exists because
something went wrong.

It is additionally the part we own. Google's terms let us keep place IDs and rent everything else
(§3.3), so the durable asset in any city is what the extraction cascade produces from the venue's
own website — the windows, the deal text, the menu boards — plus owner claims and our editorial
copy. The Google integration is a seed. Porting the cascade is porting the thing with value in it.

### 2.1 The extraction cascade

`docs/venue-pipeline-reference.md` §4 is the specification. Every source in it is national:

- **Google `regularSecondaryOpeningHours`** — a Google Business Profile field, identical everywhere.
- **The website path probe and deep inventory crawl** — `/happy-hour`, `/specials`, `/menu` are
  conventions of American restaurant websites, not of a region.
- **Locator widgets** — Storepoint, Stockist and StoreRocket are national SaaS products. A brand in
  Dallas that publishes its offer only through a Storepoint payload is read by exactly the same code
  that read Board & Brew's `$2 off all pints`. The generic `collectLocationRecordsFromJson` path
  matters more than the named adapters, and it is platform-agnostic.
- **The AI fallback and its `siteMentionsHappyHour` gate** — the gate is what makes the fallback
  affordable (a run costs $0.26 instead of ~$40), and it is a plain text search. It ports directly.

### 2.2 The incident-driven guards

These are the ones worth naming, because each was paid for once and does not have to be paid for
again:

- **The 30-minute-to-8-hour plausible window.** Three Cheesecake Factories published 11:00–22:00 and
  a casino published 13:00–08:00. Chains publish operating hours near the words "happy hour"
  everywhere, not just here.
- **The `½` character in `OFFER_SIGNAL`.** Without it, "½ off appetizers Mon–Fri 3–6pm" reads as
  priceless and the next rule deletes it as an opening-hours row. Restaurants typeset fractions the
  same way in every state.
- **Wrong-branch chain rejection** (`lib/location-page.mjs`). A Cinépolis in La Costa was given the
  Vista theater's hours. On a chain site every branch page says "Happy Hour", so the failure mode is
  a plausible answer from the wrong restaurant. This is *structurally* national — but see §5 for the
  part of it that quietly assumes California.
- **`NOT_AN_OFFER` and `BOILERPLATE`.** Phone numbers, `Skip to main content`, `Must be 21+`,
  `You have no products in your Frontpage collection`. This is web chrome, not local dialect.
- **The corporate fast-food blocklist.** A Starbucks was published with a 09:00 "happy hour". The
  two-part test — will never run a happy hour, will never claim a listing — is portable; only the
  brand list needs regional additions (§4.5).

### 2.3 The structural machinery

- **Adaptive subdivision** is pure geometry over a truncation signal (a response of exactly 20
  results). It has no knowledge of where it is.
- **The quality bar** (4.0★ / 10 reviews), **dedupe** (place ID, or same normalized name within
  120 m), the **staleness guard** on merge, **`validate-data.js`**, and the **stub / claim model**
  are all city-agnostic.

---

## 3. What has to be decided before any code is written

All three are cheap to settle at one city and expensive at three.

### 3.1 Happy hour is not legal everywhere

This is market selection, not engineering, and getting it wrong wastes an entire city build rather
than costing a bug fix. **Treat every item below as something to verify with current state law
before committing spend, not as settled fact.** The law here has moved recently and in both
directions.

- **Massachusetts** has banned discounted-drink happy hours since 1984 and, as far as we know, still
  does.
- **Alaska, Utah, North Carolina and Rhode Island** have historically prohibited or materially
  restricted them. The details differ by state and several are narrower than a flat ban.
- **Illinois lifted its ban in 2015** and **Indiana in 2024**, which is the reason not to trust a
  list like this one: two of the states that would have been on it a decade ago are now viable
  markets.
- A partial restriction can also change the product rather than block it — a state that permits
  discounted food but not discounted drinks is still a directory, just a different one.

The practical rule: legal verification is step one of the checklist (§7), it is done against the
state's current alcoholic beverage control regulations, and it is written down in §8 with a date.

### 3.2 The data model is single-city

Nothing in the system has a city dimension:

- One catalog file, `public/data/happy-hours.json`, 3,208 rows today.
- **One global integer id sequence.** `build-staging.mjs` allocates from
  `max(existing id) + 1` over that one file. Two cities staged independently collide.
- **One timezone constant.** `SD_TIME_ZONE = 'America/Los_Angeles'` in `src/lib/sanDiegoTime.ts`,
  imported by 17 source modules and 2 test files.
- **A flat `/venues/{slug}/` namespace.** `src/lib/venueSlug.ts` resolves a name collision by
  appending the neighborhood, then the street, then the id. "The Pub — Downtown" exists in thirty
  cities, so at national scale the neighborhood suffix stops disambiguating anything.

Two ways forward, and they should be chosen deliberately:

- **One deployment per city.** Simplest by a wide margin: every assumption above stays true, the
  timezone constant stays correct, ids never collide because the catalogs never meet. The cost is
  duplicated operations — a fix to a shared library has to be rolled out N times, and cross-city
  features (one account, one claim dashboard) become integration work.
- **One app with a city dimension.** Needs id namespacing (or a switch to opaque ids), a per-venue
  timezone field replacing the constant, and `/{city}/venues/{slug}` routing. More work up front and
  it invalidates the "all schedules are Pacific" assumption that 17 modules currently rely on.
  - Cheaper than it looks in one respect: Place Details exposes `timeZone` and `utcOffsetMinutes` as
    Pro fields, free at the Enterprise tier we already pay. Populating a per-venue timezone is a
    mask change, not a data-sourcing problem. The work is the 17 call sites, not the field.

We have not chosen. The honest position is that one-deployment-per-city is right for city two and
probably wrong for city five, and the migration is much cheaper while there is one city in
production.

### 3.3 The Google data is rented, and every city rents it separately

`docs/places-api-cost-analysis.md` §2.6 is the detail. The short form, because it changes how a new
city should be planned rather than merely how it should be budgeted:

- **Place IDs may be stored indefinitely.** They are the documented exemption.
- **Latitude and longitude may be cached for 30 consecutive calendar days.** Everything else —
  names, addresses, ratings, hours, phone numbers, websites, amenity booleans, photos — must not be
  pre-fetched or cached beyond a roughly 30-day performance allowance.
- **There is no one-time-purchase option at any price.** The API has no mode that sells a permanent
  copy. We are renting, and the rent comes due when the cache ages out.

The consequences for porting:

- **A city is a recurring obligation, not a one-time spend.** Ten cities is ten datasets each
  needing refresh, not ten purchases banked. This is the strongest single argument for building the
  second city slowly and the fifth only once the refresh cadence is a solved, automated thing rather
  than a person remembering to re-run discovery.
- **It sharpens what "owning a market" means.** The defensible assets in a new city are the
  happy-hour windows and deal text scraped from venues' own sites, the owner claims, and the
  editorial neighborhood copy. Those are ours, they compound, and none of them expire. The Google
  layer underneath is a rented index of where the restaurants are.
- **The recommended posture is Google as discovery and seed, not as a database.** Place IDs are the
  permanent key; the response caches under `.data/import/` are working files with a lifetime;
  anything published prefers data we own; displayed Google content carries attribution and gets
  refreshed rather than frozen.
- **We are not currently clean on this.** `public/data/happy-hours.json` is committed to git and
  holds Google-origin names, addresses and coordinates. That is a known exposure in San Diego rather
  than something a port would introduce — but a port replicates it into a second jurisdiction with
  a second set of records, which is the moment to decide how strictly to read the terms rather than
  inherit the decision by default.

This is a judgement call for the owner, not an arithmetic one, and it should be made before the
first discovery run of a new city rather than after.

---

## 4. The bounded per-city work

Everything here is a known quantity: real effort, no research required.

### 4.1 Search bounds and county — `lib/constants.mjs`, `lib/county.mjs`

- `COUNTY_BOUNDS` is a rectangle around the target metro. As in San Diego, it will not be the
  county; that is fine and expected, because county is decided later from Google's own
  `administrative_area_level_2`.
- `SAN_DIEGO_COUNTY = 'San Diego County'` becomes the target county string. A metro spanning
  several counties (Dallas–Fort Worth, most of the Northeast) needs this to be a set, not a string —
  a small change, but a change.
- `OUT_OF_COUNTY_CITIES` is a regex of the ~20 neighboring cities that fall inside the rectangle but
  outside the county. It exists only for the ~14% of places where Google omits the county component,
  and it is rebuilt from a map in an hour.
- The **border line** (`BORDER_WEST` / `BORDER_EAST`, `isNorthOfBorder`) is San Diego-specific
  infrastructure. Most cities delete it. El Paso, Detroit, Buffalo and the Rio Grande Valley need
  their own version of the same idea.

### 4.2 Neighborhood assignment — `lib/neighborhood-assign.mjs`

**This is the single largest per-city cost.** All of it is hand-built and none of it can be
generated reliably:

- **44 bounding boxes**, ordered most-specific-first.
- **37 address regexes**, including local aliases — `PB` → Pacific Beach, `Convoy` → Kearny Mesa,
  `Liberty Station` → Point Loma. Aliases are exactly the kind of thing that has to come from
  someone who knows the city.
- **A 26-entry ZIP table** for San Diego city ZIPs, used when no box and no address rule matches.

The failure mode is not an error, it is **silent mislabeling**. Boxes are checked *before* address
rules, so a box that is too wide overrides every rule beneath it. Cardiff is the worked case: it sat
inside the old Solana Beach box, so its venues were labelled Solana Beach or Encinitas and the
`/cardiff/` address rule could never fire for a venue that had coordinates. Nothing failed; the data
was just wrong, and it stayed wrong until someone browsed the neighborhood page.

Budget roughly a week per metro, and **plan to find a Cardiff.** The reference doc notes the
Carlsbad/Encinitas boxes still overlap today, which is the same bug not yet triggered.

Worth considering rather than porting the approach unchanged: for a metro where boxes and address
rules are both weak, a real polygon source (census place boundaries, or a curated GeoJSON of
neighborhoods) would replace all three layers. We have not tried it, and the box list has the
advantage of being trivially editable by hand.

### 4.3 Market areas — `src/lib/marketAreas.ts`

A hardcoded lat/lng cascade producing eight reporting areas plus `outside_market`, and it duplicates
the `COUNTY_BOUNDS` numbers rather than importing them. Rewriting it for a new metro is a day. The
duplication is a trap: change the bounds and this file silently disagrees.

### 4.4 Neighborhood editorial copy — `src/lib/neighborhoods.ts`

311 lines of per-neighborhood prose: short description, overview paragraphs, a planning tip, and a
`nearby` list. Genuinely local knowledge ("park once near University Avenue and 30th Street"), but
it is the one per-city artifact an LLM can draft usefully from a good brief, with a local editor
passing over it. Note the coupling recorded in the Cardiff commit: the neighborhood filter is an
exact match against this profile list, so relabelling venues into a neighborhood with no profile
makes them *harder* to find, not easier.

### 4.5 Regional chain additions — `lib/chain-blocklist.mjs`

41 brand patterns today, national in coverage. Regional brands to consider adding, with the caveat
that each must pass both tests (never runs a happy hour, never claims a listing):

- **Culver's** (Midwest), **Bojangles** (Southeast), **Wawa** and **Sheetz** (Mid-Atlantic).
- **Whataburger is already on the list**, despite being a Texas brand — worth checking the list
  before assuming a gap.

The generic-name mechanism (`GENERIC_NAME_BRANDS`, currently `subway` and `sonic`) is the one to
watch: a regional brand whose name is an ordinary word needs to go there, not in `BRANDS`, or it
will take out unrelated local businesses.

---

## 5. Silent-failure hazards

These are the dangerous ones. None of them throws, logs, or fails a test in another state. Each was
verified against the code.

- **`lib/location-page.mjs` `zipsIn()` matches `/\b9[0-2]\d{3}\b/`** — 90000–92999, which is
  California and a slice of the Southwest. Outside that range it returns an empty array, so the
  chain branch-conflict guard loses its strongest signal (`+10` for a ZIP match, and the ZIP
  mismatch rejection entirely) and degrades to place-name matching. No error. Just the Cinépolis bug
  coming back quietly. **Highest-priority fix in a port** — it should take the state's ZIP prefixes
  as configuration, or match a bare five-digit ZIP with a plausibility check.
- **`lib/location-page.mjs` `NEIGHBORING_PLACES`** is a list of Orange County and Los Angeles
  cities, and `PLACE_NAMES` is derived from the neighborhood boxes. Both need rebuilding with §4.2;
  the vocabulary is what the conflict check matches against.
- **`lib/neighborhood-assign.mjs`** parses `/,\s*([^,]+),\s*CA\s+\d{5}/` and `/CA\s+(\d{5})/`. In
  another state both return null, so the city and ZIP fallbacks are dead and everything lands on the
  final `'San Diego'` default.
- **`lib/venue-quality.mjs`** strips `(?:usa|ca|california)\s*\d{5}(?:-\d{4})?` when normalizing
  addresses for comparison. Elsewhere the trailing state and ZIP survive normalization, so two
  records for the same storefront can compare as different.
- **`src/lib/website-ownership.mjs`** — two problems, not one. `pageMatchesVenueListing` has a
  `sanDiegoHit` clause requiring the literal `sandiego` in the page text plus a San Diego city name
  in the venue's address; and `locationSignals` extracts a ZIP with `/\b9\d{4}\b/`, which is the same
  California assumption as `zipsIn`. That ZIP feeds `urlMatchesVenueLocation` and the ownership check,
  so in another state a legitimate site is more likely to be judged `wrong_website`.
- **`lib/county.mjs`'s border logic** silently accepts everything when ported unchanged — it is only
  a filter south of a specific line. Harmless in Denver, wrong in El Paso.

Two things that look like hazards and are not:

- **`cityFromAddress` in `lib/location-page.mjs` is portable.** It matches any two-letter state token
  (`/^[A-Z]{2}\b|^(california|ca)\b/i`), so it reads "Scottsdale, AZ 85251" correctly. Note there is
  a *different* function with the same name in `neighborhood-assign.mjs` that is CA-hardcoded — do
  not conclude one is fine from having read the other.
- **The timezone is centralized.** `SD_TIME_ZONE` is a single export and no module hardcodes
  `America/Los_Angeles` independently. It is a constant rather than a per-venue field, which is
  correct for one deployment per city and wrong for a single multi-city deployment (§3.2). All the
  hard parts — DST ambiguity, overnight windows, spring-forward rejection — are already
  timezone-general, and Google will hand us a per-venue `timeZone` for free if we ever want it.
  - One caveat for a metro that straddles a timezone line — Phoenix and its DST exemption,
    Chattanooga, the Florida panhandle. There the constant is wrong even for a single-city
    deployment, and the per-venue field stops being optional.

### 5.1 Cosmetic but visible

Not silent, but they ship. `src/lib/seo.ts` (site name, `San Diego County, California` as the served
area, `addressLocality`), `src/lib/contentEngine/cluster.ts` (generated headlines like "Things to Do
in San Diego on…"), and `astro.config.mjs` (`site: 'https://happyhoursd.com'`). A grep for
`san diego` across `src/` and `scripts/` finds roughly fifty files; most are copy.

---

## 6. Cost

San Diego is the reference data point for extrapolating to another metro. It is mid-density, and
the numbers below are modelled rather than invoiced — `docs/places-api-cost-analysis.md` §3 has the
derivation, the assumptions, and what breaks them.

- **Budget $350 for a full county run, with a plausible range of $190 to $600.** The ~$600 figure
  quoted in earlier planning is the pessimistic end of that range, not the expected case. It assumes
  coverage was really 30%, that urban squares subdivide to the floor across all five place types,
  and that the newly found tail clears the quality bar at a higher rate than expected.
- **The expected case is roughly 7,500 discovery calls and 5,700 Place Details calls**, at
  $35/1k Nearby Search Enterprise and $20/1k Place Details Enterprise, less about $55 of monthly free
  allowance. Discovery is about 70% of the bill.
- Meanwhile discovery still sits at roughly **30–45% coverage** — two exhaustively probed cells
  found 6.0× and 3.8× more venues than the original fixed grid saw. That is the estimate the $350
  is meant to close, not a description of what $350 has already bought.

**How this scales to a denser metro.** Adaptive subdivision splits a square whenever a response
returns a full page of 20, so LA, NYC and Chicago subdivide more often and deeper, and the growth is
almost entirely in the `restaurant` queue — `night_club` and `brewery` barely subdivide anywhere.
What keeps it bounded is the **120 m radius floor**: covering radius halves each level, so a
0.045° root square bottoms out at **depth 4** and can spawn at most 341 calls. A denser metro
therefore costs meaningfully more than San Diego but not unboundedly more, and the honest way to
extrapolate is to scale the discovery call count rather than to scale the dollar total. Note the
corollary: squares that hit the 120 m floor while still returning full pages are places even a
complete run will not fully cover, so a denser metro also buys a lower ceiling on coverage.

Everything downstream is small and predictable by comparison:

- **Enrichment scales with candidate count** at $20/1k, gated by the 4.0★ / 10-review prefilter.
  Expect newly discovered venues to pass that bar at a *lower* rate than the current set, since they
  are the tail the popularity ranking hid.
- **Extraction is cheap**: $0.012–0.023 per venue on Haiku, so roughly $7–14 for a full 611-listing
  pass. The AI fallback during import is ~$0.26 a run thanks to the `siteMentionsHappyHour` gate.
- **Stubs cost nothing** beyond the enrichment already paid for — and less than that now, since
  capturing `formattedAddress` in the discovery mask is free at the Enterprise tier and removes the
  $5/1k Essentials Details call a stub used to need.

**None of this is a one-time spend.** §3.3 is the reason: what the money buys is a fresh snapshot
with a shelf life. Plan a new city's budget as an ongoing line item covering discovery, enrichment
and periodic refresh, and note that this term is what compounds across cities — the per-city
engineering work is paid once, the per-city data rent is not.

Two mistakes that are easy to make in a new city and are called out in the cost analysis: re-running
discovery repeats every root call (2,835 root calls is $99 a time in San Diego, and partial runs
against the default 2,000-call budget are the easiest way to overspend), and a bounds rectangle that
overhangs a neighboring county means paying Place Details for venues the county filter later
discards — 5–8% of the spend in San Diego, and free to avoid by drawing a tighter box in step 3.

---

## 7. New-city checklist

In order. Do not skip ahead — steps 1 to 3 can invalidate everything after them, and the first two
are both "check before you spend".

1. **Verify the law.** Check the target state's current alcoholic beverage control regulations for
   restrictions on discounted drinks, and whether any restriction is partial (food but not drinks,
   or no multi-drink discounts). Record the finding and the date in §8. Stop here if it is a ban.
2. **Settle the Google terms question** (§3.3), if it has not already been settled for the business
   as a whole. Confirm how strictly the caching terms are being read, that the new city's catalog
   handles Google-origin fields the same agreed way, and that the recurring refresh obligation is
   budgeted rather than assumed away. Re-check the terms themselves — the cost analysis was accurate
   on 31 August 2026 and Google's pricing and terms have both changed recently.
3. **Decide the deployment model** (§3.2): separate deployment, or a city dimension in the data
   model. If it is the latter, do the id namespacing, per-venue timezone and routing work *before*
   importing anything.
4. **Draw `COUNTY_BOUNDS`** around the metro and set the county name (or set of names) in
   `lib/county.mjs`. Build the out-of-county neighbor city regex from a map. Draw the box tightly —
   overhang into a neighboring county is Place Details spend on venues that get discarded.
5. **Fix the ZIP assumptions** — `zipsIn` in `lib/location-page.mjs`, the CA regexes in
   `lib/neighborhood-assign.mjs`, the strip in `lib/venue-quality.mjs`, and `locationSignals` in
   `src/lib/website-ownership.mjs`. This is a small diff and skipping it degrades chain handling
   invisibly (§5).
6. **Add regional chains** to `lib/chain-blocklist.mjs`, checking the existing 41 first.
7. **Build the neighborhood classifier** — boxes, address rules with local aliases, ZIP table.
   Budget a week. Order boxes most-specific-first and check every pair for containment before
   trusting them.
8. **Set a ceiling on the Cloud billing account**, then run a **smoke discovery**
   (`discover --smoke`, or `--limit` a handful of cells) and eyeball the candidates for out-of-area
   places and obvious junk before committing to a full run. The failure mode of an accidental
   re-run is silent and it repeats every root call.
9. **Run discovery for real**, adaptive, with an explicit `--max-calls` budget you have decided you
   are willing to spend. Expect several runs at the 2,000 default; plan them rather than drifting
   into them, because each restart re-pays for the root calls.
10. **Enrich**, then read the qualification counts. A surprising out-of-county rate means the bounds
    or the county string is wrong; fix it and `--requalify` rather than re-fetching.
11. **Extract on a sample first** — a few hundred venues — and read the scrape outcomes. A high
    `wrong_website` or `other_location` rate is the signature of step 5 having been skipped.
12. **Stage, and audit the neighborhood distribution before merging.** Every venue landing on the
    default neighborhood, or one neighborhood swallowing a coast, is the Cardiff bug. This is the
    last cheap moment to catch it.
13. **Merge**, let `validate-data.js` run, and spot-check twenty venue pages by hand against their
    own websites.
14. **Write the editorial neighborhood copy** (`src/lib/neighborhoods.ts`) for every neighborhood the
    data actually produced — a neighborhood with venues and no profile has no page and no filter
    entry.
15. **Update `src/lib/marketAreas.ts`, `src/lib/seo.ts` and the site config**, then run
    `npm run audit:venues` and the test suite.
16. **Schedule the refresh** before calling the city done. The Google-origin data has a shelf life
    (§3.3) and a city that is never refreshed is a city whose data quietly rots and whose terms
    position quietly worsens.
17. **Append what you learned to §8**, including the actual spend against the $350 San Diego
    reference and the legal finding with its date.

---

## 8. What we learned in San Diego

The append-only section. As a second city gets built, move claims between these subsections rather
than editing §2–§6 — the value here is the record of what turned out to be true.

### 8.1 Translates well

Seeded from San Diego; nothing here has yet been tested in a second city.

- **The cheapest-first source cascade.** Most venues never reach the model call, and the ones that do
  were pre-screened by a text search. The economics of that gate (~$40 → $0.26) come from the fact
  that only about 2% of sites mention a happy hour the cheap paths could not parse, which is a fact
  about restaurant websites rather than about San Diego.
- **Reading a page's JSON rather than its DOM.** Popmenu menus and Storepoint locators both hid their
  data from a DOM crawler and both gave it up in an API response. This has been the single most
  reusable lesson in the project.
- **Outcome taxonomy over a single "no data" bucket.** `not_published` is a real read;
  `blocked`, `no_candidates` and `extract_failed` are not. Rolling them together hid 327 venues worth
  of fixable problems.
- **Filters must run where their output is consumed.** The staleness guard on merge exists because
  filters freeze into `staging.json` — 99 venues went live with "Happy hour" as their only deal
  *after* the filter rejecting it had been written.
- **A dedupe that never matches looks exactly like a clean import.** Worth an explicit assertion in
  any new city's first staging run.

### 8.2 Needed adjustment

- **A rectangle is not a county.** 54 out-of-area venues (23 San Clemente, 31 Temecula) published
  before county classification existed. Every metro will have its own version of this, and the fix
  is the same: trust Google's `administrative_area_level_2`, not the geometry.
- **Boxes before addresses silently override the addresses.** Cardiff. Then a second time when
  relabelling Cardiff venues removed them from the Encinitas page without giving them one of their
  own, because the neighborhood filter is an exact match against the profile list. Both halves of
  that are portable lessons.
- **The grid only finds what Google ranks.** Discovery is nearby-search, so a dense cell hides
  everything past the twentieth result. Adaptive subdivision was the fix; seeding from brand locators
  (`seed:locators`) was the other half — we had 1 of 16 Board & Brews.
- **The quality bar moved.** 4.0★ / 10 reviews after lowering it, which added 37 venues. A new city
  should expect to tune this rather than inherit it, and should remember that `--requalify` exists so
  tuning does not mean re-paying.
- **We planned around buying the data and we are renting it.** The Places terms permit keeping place
  IDs and essentially nothing else, which was found late enough that the committed catalog already
  holds Google-origin names and addresses. A second city should start from the "discovery source,
  not database" posture rather than arriving at it (§3.3).
- **The cost figure everyone was quoting was the pessimistic tail.** ~$600 was carried around as the
  San Diego number until it was modelled properly and came out at $350 expected, $190–$600 range. If
  a second city produces a headline cost, write down whether it is expected or worst case.

### 8.3 Open questions

- **Is "browse by neighborhood" the right primary IA everywhere?** San Diego has unusually strong
  neighborhood identity — PB, OB, North Park are how people actually talk. In sprawl metros the
  equivalent axis is municipality: Scottsdale and Tempe rather than "Phoenix neighborhoods". The
  portable `cityFromAddress` fallback handles that adequately at the data layer, but the product
  question — whether the homepage should sort by neighborhood, municipality, or corridor — is
  unanswered and is probably per-metro.
- **How much of the neighborhood classifier could be a polygon dataset?** We built San Diego's by
  hand and it cost a week plus a Cardiff. Nobody has tried census places or a curated GeoJSON.
- **What does a partial-restriction state do to the product?** A market where food discounts are
  legal and drink discounts are not is still a directory, but the deal chips, the filters and the
  name all assume drinks.
- **Does the 30–45% coverage ceiling hold elsewhere?** It is a San Diego measurement from two
  exhaustively probed cells. A less dense metro might do considerably better with the same budget,
  which would change which city to build second.
- **At what point does one-deployment-per-city stop being cheaper?** Guessing three to five cities,
  with no evidence.
- **What is the steady-state refresh cost of a city, as distinct from the cost of building it?**
  §6 budgets a build. Nobody has measured what keeping a city current costs per year, and under
  §3.3 that recurring number, not the build, is what decides how many cities are sustainable.
- **How strictly should the caching terms be read, and does the answer change per city?** It is a
  judgement call today. A larger footprint across more states makes it a louder one.

### 8.4 Log

Append dated entries as cities are evaluated or built. Legal findings especially — they expire.

| Date | City / state | Finding |
|---|---|---|
| — | — | (no second city evaluated yet) |

---

## 9. Per-city file inventory

Effort is rough and assumes someone who knows this codebase.

| File | What changes | Effort |
|---|---|---|
| `scripts/import-google-venues/lib/neighborhood-assign.mjs` | 44 boxes, 37 address regexes, 26-entry ZIP table, the CA address parsers | **~1 week** |
| `src/lib/neighborhoods.ts` | Editorial copy per neighborhood, LLM-draftable, needs a local editor | 2–3 days |
| `src/lib/marketAreas.ts` | Full rewrite of the lat/lng cascade and the area labels | 1 day |
| `scripts/import-google-venues/lib/county.mjs` | County name(s), out-of-county city regex, delete or replace the border line | Half a day |
| `scripts/import-google-venues/lib/location-page.mjs` | `zipsIn` ZIP prefixes, `NEIGHBORING_PLACES` vocabulary | Half a day |
| `src/lib/seo.ts` | Site name, served area, `addressLocality`, default description | 2 hours |
| `scripts/import-google-venues/lib/constants.mjs` | `COUNTY_BOUNDS` rectangle | 1 hour |
| `scripts/import-google-venues/lib/chain-blocklist.mjs` | Regional brands; check the existing 41 first | 1 hour |
| `src/lib/website-ownership.mjs` | `sanDiegoHit` clause and the `\b9\d{4}\b` ZIP in `locationSignals` | 1 hour |
| `scripts/import-google-venues/lib/venue-quality.mjs` | The `usa\|ca\|california` strip in address normalization | 1 hour |
| `src/lib/sanDiegoTime.ts` | Rename plus one constant for a separate deployment; a per-venue field and 17 call sites for a shared one | 1 hour, or a week |
| `src/lib/contentEngine/cluster.ts` | Generated headline and summary strings | 1 hour |
| `astro.config.mjs` | `site` URL | Minutes |
| `src/lib/venueSlug.ts` | Only if the deployment is multi-city — slug namespacing | Part of §3.2 |
| Copy across `src/pages/**` | "San Diego" in page titles and body text | 1 day, scattered |

Everything not listed — the whole of `lib/happy-hour.mjs`, `website-crawl.mjs`, `locator-widgets.mjs`,
`ai-extract.mjs`, `deals.mjs`, `normalize.mjs`, `dedupe.mjs`, discovery, staging, merge, validation —
should need no change at all. That ratio is the argument for doing this.
