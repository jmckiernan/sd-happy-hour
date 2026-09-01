# Places API Cost Analysis

What a full Google Places discovery and enrichment run over San Diego County costs, why the paid
API is unavoidable, and which fields to capture while we are paying.

Pricing and terms below were checked against Google's own pages on **31 August 2026**. Sources are
linked at the bottom. Every count attributed to the caches was read out of `.data/import/google/`
on the same date, not remembered.

Headline: **budget $350, with a plausible range of $190 to $600.** The earlier ~$600 figure is not
wrong so much as it is the pessimistic end of the range. The insurance policy of capturing every
field we could ever want costs about **$25 extra** on top of that, which is inside the rounding
error of the estimate.

---

## 0. Where we are today

| Cache | Records | Notes |
|---|---|---|
| `candidates.json` | 5,714 places | 2,645 fixed-grid requests plus 77 adaptive calls |
| `enriched.json` | 5,361 places | all 5,361 carry `detailsFetchedAt`, so Details has been bought for every one |
| — of those, qualified | 3,804 | `OPERATIONAL` + 4.0★ + 10 reviews + in county |
| — with a `websiteUri` | 4,476 | the input to the website scrape |
| — with `regularSecondaryOpeningHours` | 1,260 | Google's own happy-hour block, on 24% of places |
| `with-happy-hour.json` | 4,033 processed | 796 with a happy hour found |
| `public/data/happy-hours.json` | 3,208 venues | 800 with a schedule; the rest are claimable stubs |

So the money already spent bought roughly 2,722 Nearby Search calls and 5,361 Place Details calls.
The remaining question is what the *other* 60–70% of the county costs.

---

## 1. Why the paid API is unavoidable

### 1.1 How the pricing actually works

Google retired the old $200-per-month blanket credit on **1 March 2025** and replaced it with
per-SKU pricing in three named tiers — Essentials, Pro, Enterprise — each with its own small
monthly free allowance. There is no longer a single pot of free credit to hide behind.

Two mechanics matter more than the numbers:

- **You are billed at the highest tier of any single field you request.** The `X-Goog-FieldMask`
  header decides the SKU. Ask for forty Essentials fields and one Enterprise field and you pay the
  Enterprise rate for the whole call. This cuts both ways, and §2 is mostly about the good half.
- **The free allowance is per SKU per month, and it is small.** 10,000 calls for Essentials SKUs,
  5,000 for Pro, 1,000 for Enterprise. A one-month run gets 1,000 free Nearby Search Enterprise
  calls and 1,000 free Place Details Enterprise calls — about $55 of relief on a $350 bill.

Rates for the SKUs this pipeline touches, at the 0–100,000 monthly volume band, US/Canada list
price:

| SKU | Tier | Free/month | Per 1,000 |
|---|---|---|---|
| Place Details Essentials (IDs Only) | Essentials | unlimited | $0.00 |
| Place Details Essentials | Essentials | 10,000 | $5.00 |
| Place Details Pro | Pro | 5,000 | $17.00 |
| Place Details Enterprise | Enterprise | 1,000 | $20.00 |
| Place Details Enterprise + Atmosphere | Enterprise | 1,000 | $25.00 |
| Place Details Photos (media fetch) | Enterprise | 1,000 | $7.00 |
| Nearby Search Pro | Pro | 5,000 | $32.00 |
| Nearby Search Enterprise | Enterprise | 1,000 | $35.00 |
| Nearby Search Enterprise + Atmosphere | Enterprise | 1,000 | $40.00 |
| Text Search Pro | Pro | 5,000 | $32.00 |
| Text Search Enterprise | Enterprise | 1,000 | $35.00 |

Volume discounts exist but start at 100,000 calls a month, which is an order of magnitude past
anything here. Assume list price throughout.

### 1.2 What we ask for, and what it costs

**`DISCOVERY_MASK` (Nearby Search).** Note the tier, because `docs/venue-pipeline-reference.md`
§1.4 currently records this as Pro and that is wrong.

| Field | Tier |
|---|---|
| `places.id`, `places.displayName`, `places.location`, `places.businessStatus`, `places.primaryType` | Pro |
| `places.rating`, `places.userRatingCount` | **Enterprise** |

`rating` and `userRatingCount` are Enterprise fields on Nearby Search, not Pro, so every discovery
call has been billing at **Nearby Search Enterprise, $35/1k**, not $32. The important detail is
that this is a $3/1k mistake, not a $3-to-$35 one: **Nearby Search has no Essentials tier at all.**
Pro at $32/1k is the floor even for a mask of nothing but `places.id`. Paying $3 more per thousand
to get rating and review count inside the search response is what lets enrich reject 24% of
candidates before spending $20/1k on them. It pays for itself many times over and should stay.

**`DETAILS_MASK` (Place Details).** As it stood before this analysis:

| Field | Tier |
|---|---|
| `id` | Essentials (IDs only), free |
| `addressComponents`, `formattedAddress`, `location`, `types` | Essentials |
| `displayName`, `businessStatus`, `googleMapsUri`, `primaryType` | Pro |
| `nationalPhoneNumber`, `rating`, `userRatingCount` | Enterprise |
| **`websiteUri`** | **Enterprise** |
| **`regularSecondaryOpeningHours`** | **Enterprise** |

Billed at **Place Details Enterprise, $20/1k**. Twelve of the fifteen fields are free riders; the
price is set entirely by the Enterprise three, and really by two of them.

### 1.3 What an Essentials-only mask would leave us with

Nothing. Not "less"; nothing.

The pipeline has exactly two inputs. `regularSecondaryOpeningHours` with type `HAPPY_HOUR` is
Google's own happy-hour block and the first and cheapest extraction source — it is the only reason
1,260 of our places needed no scraping at all. `websiteUri` is the domain that the path probe, the
locator detection, and the AI fallback all crawl. Both are Enterprise.

Drop to Essentials and a place record is a name, an address, and a coordinate pair. There is no
happy hour in it, no website to look for one on, and no rating or review count to decide whether
the venue is worth looking at. The pipeline would have no input at any of its four extraction
sources. This is not a degraded product; it is a directory of restaurant addresses.

### 1.4 Is there a cheaper legitimate path?

I looked for one. There is not much.

- **No lower tier holds these fields.** Website and secondary opening hours appear only in the
  Enterprise field list. There is no Pro variant, no partial form, no separate cheap endpoint.
- **Session tokens do not apply.** The Autocomplete session-token mechanism, where a session's
  Details call can be bundled, exists for interactive search boxes. There is no session to attach a
  batch import to, and terminating a session with an Enterprise-or-above field is explicitly billed
  at Enterprise + Atmosphere anyway — worse, not better.
- **The free allowance is real but small.** 1,000 free calls on each Enterprise SKU per month.
  Spreading a run across three calendar months would harvest three months of allowances and save
  roughly $110, at the cost of a three-month project. Worth doing only if the run is naturally
  phased for other reasons.
- **The Essentials stub mask is the one genuine saving, and we already use it.**
  `placeDetailsEssentials` buys an address for $5/1k with 10,000 free a month, for venues we only
  need a claimable page for. This analysis makes it cheaper still: see §2.4.
- **Nothing here is free-tier-shaped.** "Places is free" was true of the Maps JavaScript embed and
  is true of the IDs-only Details SKU. It has never been true of business content at volume.

---

## 2. Capture-everything: what to take while we are paying

The requirement, quoted: *"Once we do a full run, we need to make sure we capture everything so we
don't have to pay for it again, even if we may not be using those fields right now, unless there is
no way it would ever make sense to pull in."*

### 2.1 The nuance that decides this

Because billing is by the highest tier requested, the mask splits into two completely different
kinds of decision:

- **Everything at or below Enterprise is free.** We are already paying $20/1k for `websiteUri`.
  Adding `priceLevel`, `regularOpeningHours`, `viewport`, `accessibilityOptions`, `photos`,
  `timeZone` and two dozen others changes the bill by exactly zero dollars. Leaving them out is
  not thrift, it is throwing away data we have already paid for. **There is no argument for
  excluding any Essentials, Pro or Enterprise field we can imagine a use for.**
- **Atmosphere is a real, quantified decision.** Adding one Atmosphere field re-prices the call
  from $20/1k to $25/1k — a flat +25% on Place Details. §2.5 puts a dollar figure on it.

### 2.2 Every Place Details field, by tier, with a verdict

**Essentials, IDs only — unlimited and free**

| Field | Take? | Why |
|---|---|---|
| `id` | yes | the durable key, and the only thing we may legally keep forever |
| `photos` | yes | photo *metadata*, free here. Venue pages want images. Fetching the bytes is a separate $7/1k SKU |
| `attributions`, `name` | no | `name` duplicates `id`; attributions apply to third-party photo data we do not use |
| `consumerAlert`, `movedPlace`, `movedPlaceId` | no | closure/relocation signals; `businessStatus` already covers what we act on |

**Essentials — free at our tier**

| Field | Take? | Why |
|---|---|---|
| `addressComponents` | yes | the county classifier depends on it |
| `formattedAddress` | yes | displayed on every venue page |
| `location` | yes | maps, neighborhood boxes, dedupe radius |
| `types` | yes | drives inferred vibe, features and deal types |
| `shortFormattedAddress` | yes | better on a card than the full postal form |
| `viewport` | yes | correct default zoom for a venue map, instead of guessing |
| `plusCode` | yes | trivial, and a fallback identifier for places with vague addresses |
| `postalAddress` | yes | structured address; cheaper than re-parsing `formattedAddress` |
| `adrFormatAddress` | yes | microformat markup, directly useful for SEO structured data |
| `addressDescriptor` | no | experimental outside India |

**Pro — free at our tier**

| Field | Take? | Why |
|---|---|---|
| `displayName` | yes | the venue name |
| `businessStatus` | yes | the first prefilter gate |
| `primaryType`, `primaryTypeDisplayName` | yes | classification, and human-readable category text for a page |
| `googleMapsUri`, `googleMapsLinks` | yes | "open in Maps", directions, write-a-review deep links |
| `accessibilityOptions` | yes | wheelchair access is a genuine filter a user would want |
| `iconMaskBaseUri`, `iconBackgroundColor` | yes | map pin styling by category, free |
| `timeZone`, `utcOffsetMinutes` | yes | "happy hour on now" is a clock computation; hardcoding Pacific is a latent bug |
| `subDestinations`, `containingPlaces` | yes | the hotel-bar and food-hall-stall relationship, which we currently cannot express |
| `openingDate` | yes | "newly opened" is an obvious editorial angle |
| `pureServiceAreaBusiness` | yes | flags caterers with no storefront, which should not get a venue page |
| `googleMapsTypeLabel` | no | redundant with `primaryTypeDisplayName` |
| `transitStation` | — | Enterprise, listed below |

**Enterprise — the tier we are paying for**

| Field | Take? | Why |
|---|---|---|
| `websiteUri` | yes | load-bearing. Every scrape source starts here |
| `regularSecondaryOpeningHours` | yes | load-bearing. Google's own happy-hour block |
| `rating`, `userRatingCount` | yes | the quality bar, before and after Details |
| `regularOpeningHours` | yes | see note below |
| `nationalPhoneNumber`, `internationalPhoneNumber` | yes | shown on the page; also a claim-verification signal |
| `priceLevel`, `priceRange` | yes | an obvious future browse filter, and free |
| `currentOpeningHours`, `currentSecondaryOpeningHours` | no | holiday-adjusted snapshots that are stale the moment they are cached. The `regular` forms are the durable ones |
| `transitStation` | no | nearest transit is not a happy-hour decision, and it is per-place noise |

On `regularOpeningHours`: the pipeline has already been burned by opening hours *masquerading* as
happy hours — three Cheesecake Factories came through as 11:00–22:00. That is an argument for a
strict window check at normalize time, which exists, not an argument for refusing the field. Knowing
a venue's real hours is how you answer "is this place even open now", and it is free.

**Enterprise + Atmosphere — the $5/1k decision**

| Field | Take? | Why |
|---|---|---|
| `servesBeer`, `servesWine`, `servesCocktails` | yes | these *are* our `dealTypes` vocabulary, which we currently infer from place types |
| `outdoorSeating` | yes | the `patio` feature, currently guessed |
| `allowsDogs` | yes | the `dog friendly` feature, currently guessed |
| `liveMusic` | yes | the `entertainment` deal type, currently guessed |
| `goodForGroups` | yes | the `group friendly` feature, currently guessed |
| `reservable` | yes | a real user question on a bar page |
| `servesBreakfast/Lunch/Dinner/Brunch/Dessert/Coffee` | yes | brunch and late-night are adjacent products; a boolean each is free once the tier is paid |
| `servesVegetarianFood` | yes | a filter people ask for |
| `takeout`, `delivery`, `dineIn`, `curbsidePickup` | yes | cheap, and `dineIn` false is a strong "no happy hour here" signal |
| `parkingOptions`, `paymentOptions` | yes | practical venue-page detail; free at the tier |
| `restroom`, `goodForChildren`, `goodForWatchingSports`, `menuForChildren` | yes | sports bars during happy hour is a real category; the rest are cheap |
| `editorialSummary` | yes, with care | one clean sentence of venue description, better than anything we would generate. Google content, so it needs attribution if displayed |
| `reviews` | **no** | review *text* is the most heavily restricted content in the API, bulky in the cache, and we neither display nor plan to display it. Excluding it costs nothing since the tier is already set |
| `reviewSummary`, `generativeSummary`, `neighborhoodSummary` | **no** | Google-generated prose under the same restrictions. We write our own neighborhood copy |
| `evChargeOptions`, `evChargeAmenitySummary`, `fuelOptions` | **no** | these describe charging stations and gas pumps. This is the "no way it would ever make sense" category |
| `routingSummaries` | n/a | Text Search and Nearby Search only |

### 2.3 Revisiting the `servesBeer` removal

The removal was correct at the time and is wrong now, for a reason that has changed.

It was correct because those three fields were re-pricing *every* Details call by 25% while
nothing in the codebase read them. Paying a premium for data no consumer touches is waste
regardless of how small the premium is.

It is wrong now because the goal changed. Under capture-everything the question is no longer "does
something read this today" but "would we ever want it, and what does the option cost". And these
particular fields are not speculative: `dealTypes` and `features` are currently *inferred from
Google place types*, which is guesswork. `servesCocktails` is the ground truth for a guess we are
already making and publishing. Same for `outdoorSeating` → `patio` and `allowsDogs` →
`dog friendly`.

So: take Atmosphere on the full-county capture run, and do not take it on routine refresh runs.
That is a flag, not a rewrite, and it is what the code change below implements. The old trap was
that the expensive mask was the *only* mask; the fix is to keep the cheap one as the default.

### 2.4 A free saving found along the way

Nearby Search's Pro field list includes `places.formattedAddress`. We are already at the Enterprise
tier on discovery, so requesting it is free — and a street address was the *only* thing a claimable
stub needed that the search response did not already provide. Capturing it at discovery time
removes the $5/1k Essentials Details call per stub entirely. On a few thousand stubs that is real
money that was previously being spent on data we could have had for nothing.

The same logic adds `places.types`, `places.googleMapsUri`, `places.plusCode`,
`places.primaryTypeDisplayName`, `places.shortFormattedAddress` and `places.photos` to the
discovery mask at zero cost.

### 2.5 The Atmosphere bump, quantified

Only Place Details is affected. The tier bump on Nearby Search ($35 → $40/1k) is **not**
recommended: discovery exists to find place IDs, it truncates at 20 results regardless, and per-
venue attributes belong in the per-venue call. That bump would cost ~$38 on an expected run and
buy nothing we are not already buying at Details.

| Item | At Enterprise | At Enterprise + Atmosphere | Delta |
|---|---|---|---|
| Newly discovered qualifying venues (expected, 5,722 calls) | $114 | $143 | **+$29** |
| Backfilling the 5,361 already-enriched places | $107 | $134 | +$27 (but $107 of it is re-purchase) |
| Both, one pass over the whole county | $222 | $277 | +$55 |

**The capture-everything insurance policy on new venues costs about $29.** For that, the guesswork
comes out of `dealTypes`, `features` and `vibe`. It is worth it.

Backfilling the existing 5,361 is a different question, because the $107 base is money already
spent once. My recommendation is not to backfill as a batch: let the existing refresh cadence pick
these venues up with the fuller mask over time, and spend the $134 deliberately later if the
amenity data turns out to drive something.

### 2.6 The Terms of Service problem, which is bigger than the billing

**This is the part of the plan that does not work as stated, and it has nothing to do with money.**

Google Maps Platform's terms are explicit:

- **Place IDs may be stored indefinitely.** They are the one documented exemption from the caching
  restrictions.
- **Latitude and longitude may be cached for up to 30 consecutive calendar days**, after which they
  must be deleted. This is the Places-specific term, and it is narrow.
- **Everything else must not be pre-fetched, cached, or stored** beyond the general 30-day,
  performance-only caching allowance. Names, addresses, ratings, review counts, hours, phone
  numbers, websites, amenity booleans, photos: none of it is licensed for permanent storage.
- Displayed Google content carries attribution requirements.

So "capture once, keep forever" is not a strategy the terms support, at any price. The API has no
one-time-purchase mode. The honest framing is that we are renting, and the rent is due again
whenever the cache ages out.

What this means in practice, stated plainly rather than optimistically:

- The current design is already outside a strict reading. `public/data/happy-hours.json` is in git
  and holds names, addresses and coordinates that originated from Google. `enriched.json` is a
  19 MB cache of Places responses. Widening the mask to forty-odd fields makes the exposure larger
  and more obviously deliberate, which is precisely why it is worth deciding on purpose.
- The defensible posture, and the one I recommend, is to treat Google as a **discovery and seed**
  source rather than a database:
  - Keep **place IDs** as the permanent key. That is licensed, and it is what makes any future
    re-fetch cheap and targeted.
  - Treat the raw Places response caches as **working files with a lifetime**, not an archive.
  - For anything we publish, prefer data we own: happy-hour windows and deal text scraped from the
    venue's own website (not Google content), owner-supplied data from claims, and our own
    editorial copy. The catalog already works this way for the parts that matter most.
  - Where we do display Google content — `editorialSummary`, ratings, photos — show the required
    attribution, and refresh rather than freeze.
- Two specific flags. Storing photo *bytes* is harder to defend than storing a photo reference and
  serving through Google's URI; `fetch-photos.mjs` currently downloads bytes. And ratings and
  review counts change constantly, so a frozen 4.2★ is both a terms problem and a correctness one.

None of this changes the budget in §3. It changes what the money buys: a fresh snapshot with a
shelf life, not a permanent asset. **The owner should decide how strictly to read this before
committing to a forty-field mask**, because the widest mask is the one that most needs the
"discovery source, not database" framing to be true.

### 2.7 Recommended final masks

**Discovery (Nearby Search Enterprise, $35/1k).** Keep `rating` and `userRatingCount` — $3/1k over
an unavoidable $32 floor, and they gate all Details spend. Add every free Pro field, `formattedAddress`
above all, so stubs need no Details call. Never add an Atmosphere field here.

**Details, default (Place Details Enterprise, $20/1k).** Every Essentials, Pro and Enterprise field
with a plausible use, which is nearly all of them. `websiteUri` and `regularSecondaryOpeningHours`
set the price; the other thirty ride along free. Excludes `currentOpeningHours` and
`currentSecondaryOpeningHours` as inherently stale, and `transitStation` as noise.

**Details, full capture (Place Details Enterprise + Atmosphere, $25/1k).** The above plus the
amenity and service booleans and `editorialSummary`. Opt-in via `IMPORT_CAPTURE_ALL=1` so a routine
refresh cannot silently inherit the +25%. Excludes `reviews` and the generated summaries on terms
and cache-size grounds, and the EV/fuel fields as inapplicable.

Both masks are implemented in `scripts/import-google-venues/lib/google-places.mjs` with the tier
reasoning in comments beside them.

---

## 3. Budget for a full county run

### 3.1 How many venues are out there

Discovery coverage is estimated at 30–45%. Two exhaustively probed cells found 6.0× and 3.8× more
venues than the fixed grid saw, but those were dense cells and the county average must be lower —
most of the rectangle is backcountry where the grid was genuinely exhaustive.

Taking 5,714 discovered places as 30–45% of the true population inside `COUNTY_BOUNDS`:

| Assumed coverage | Implied population | Still to find |
|---|---|---|
| 45% | 12,700 | ~7,000 |
| 37.5% | 15,250 | ~9,500 |
| 30% | 19,000 | ~13,300 |

### 3.2 Modelling the adaptive call count

The mechanism: 567 starting squares of 0.045° (nine of the 576 are dropped by the border skip),
five place types each, so 2,835 root calls. A call returning exactly 20 results splits its square
into four children re-queued for the same type. A child is queued only if its covering radius is
still ≥ 120 m.

That floor caps the depth, which is what keeps this from exploding. Covering radius halves each
level: 3,540 m → 1,770 → 885 → 442 → 221 → 110. At 221 m the children would be 110 m, below the
floor, so **maximum depth is 4** and a root square can spawn at most 1+4+16+64+256 = 341 calls.
The theoretical worst case is 567 × 5 × 341 ≈ 967,000 calls; the real number is nowhere near it
because only dense squares subdivide at all.

To get a real number I replayed the subdivision logic over the 5,714 known candidate coordinates,
bucketed to their search type, with a density multiplier standing in for the venues the grid never
saw. A square splits when its modelled venue count reaches 20.

| Density multiplier | Total calls | Squares that capped | Hit the 120 m floor |
|---|---|---|---|
| 1.0× | 3,683 | 219 | 7 |
| 1.5× | 4,223 | 362 | 15 |
| 2.0× | 5,047 | 588 | 35 |
| 2.7× | 5,811 | 804 | 60 |
| 4.0× | 8,079 | 1,517 | 206 |

Almost all the growth is the `restaurant` queue (567 root calls at 1×, 2,931 at 2.7×). `night_club`
and `brewery` barely subdivide at all — they stay near 600 calls, essentially one per root square.

The model has a known bias in the honest direction: it counts density from a candidate set that is
*itself* truncated, and truncation is worst exactly where subdivision would be deepest. So treat
these as a floor and add headroom. Note also that 60–206 squares hit the 120 m floor still returning
full pages, meaning even a complete adaptive run will not reach 100% coverage in the Gaslamp.

Practical consequence: `--max-calls` defaults to 2,000, which is roughly a quarter of a full run.
Plan on several runs, or raise the budget.

### 3.3 Place Details volume

Newly discovered venues are the tail the popularity ranking hid, so they skew toward fewer reviews
and will pass the 4.0★ / 10-review prefilter at a lower rate than the current set (4,106 of 5,524
operational candidates, 74%). I assume 50–68%.

### 3.4 The estimate

Discovery at $35/1k, Details at $20/1k, less one month of free allowance (1,000 Nearby Search
Enterprise + 1,000 Place Details Enterprise, about $55).

| | LOW | EXPECTED | HIGH |
|---|---|---|---|
| Discovery calls | 5,000 | 7,500 | 13,000 |
| Discovery cost | $175 | $263 | $455 |
| New places found | ~7,000 | ~9,500 | ~13,300 |
| Prefilter pass rate | 50% | 60% | 68% |
| Place Details calls | 3,493 | 5,722 | 9,034 |
| Details cost (Enterprise) | $70 | $114 | $181 |
| Text Search | $0 | $0 | $0 |
| Free allowance | −$55 | −$55 | −$55 |
| **Total, current mask** | **$190** | **$322** | **$581** |
| Details at Atmosphere | $87 | $143 | $226 |
| **Total, capture-everything** | **$202** | **$346** | **$621** |
| *Marginal cost of capture-everything* | *+$12* | *+$24* | *+$40* |

Text Search is $0 because `seed-from-locators.mjs` uses a mask of Pro-tier fields only, and its
volume is in the hundreds — comfortably inside the 5,000 free Text Search Pro calls per month. If
that changes, it is $32/1k.

Optional extras, not in the totals:

| Item | Cost |
|---|---|
| One photo each for ~4,000 qualifying venues (Place Details Photos, $7/1k, 1,000 free) | ~$21 |
| Backfilling Atmosphere over the 5,361 already-enriched places | $134 |
| Re-pricing discovery to Atmosphere (not recommended) | +$38 |

**Budget $350.** That carries the expected case plus the capture-everything mask with a little
slack.

### 3.5 What the assumptions rest on, and what breaks them

- **LOW** assumes coverage was really nearer 45%, the grid missed mostly quiet suburbs, and the
  newly found tail is thin enough that only half clears 4.0★ / 10 reviews.
- **EXPECTED** takes coverage at the midpoint, ~7,500 discovery calls (the 2.7× model plus headroom
  for its truncation bias), and a 60% pass rate.
- **HIGH** assumes coverage was 30%, urban squares subdivide to the 120 m floor across all five
  types, and the tail is healthier than expected so more of it earns a Details call.

What pushes it to the high end, roughly in order of likelihood:

1. **Coverage was worse than 30%.** Every percentage point of missing coverage adds venues to
   discover *and* Details to buy. This is the dominant term.
2. **Urban density beats the model.** The simulation is anchored to a truncated sample. If downtown,
   North Park, Pacific Beach, Hillcrest, La Jolla and Little Italy all subdivide to depth 4 on
   restaurants, bars and cafes, discovery alone runs past $450.
3. **Re-running discovery.** Failed calls do not consume budget but a re-run repeats every root
   call, and 2,835 root calls is $99 a time. Multiple partial runs are the easiest way to overspend.
4. **Lowering the quality bar mid-run.** Dropping `MIN_REVIEWS` moves the pass rate straight into
   Details spend at $20 or $25 per thousand.
5. **Paying for Mexico and Orange County again.** The border skip only drops squares entirely south
   of the line, and the northern edge still reaches San Clemente and Temecula. Roughly 5–8% of the
   Details spend buys venues that the county filter later discards. A tighter northern bound would
   recover a meaningful slice of that, and unlike everything else on this list it is free to do.

---

## 4. What the owner should decide before running

1. **How strictly to read the caching terms** (§2.6). This is the only genuine blocker and it is a
   judgement call, not an arithmetic one. The wider mask makes the question louder.
2. **Atmosphere on the capture run: yes or no.** My recommendation is yes, at +$29 expected.
3. **Whether to phase the run across calendar months** to collect the free allowance more than
   once. Saves roughly $55 per extra month, at the cost of elapsed time.
4. **Whether to tighten the northern bound first.** Free, and it stops us buying Orange and
   Riverside County venues we will discard.
5. **A ceiling on the Cloud billing account before starting.** The adaptive discovery budget is a
   `--max-calls` flag in a script, and the failure mode of an accidental re-run is silent.

---

## 5. What the capture run actually bought

**This data is bought. Do not re-fetch it to find out what is in it — read this section.**

On 31 August 2026 the Atmosphere mask was bought over the venues the catalog publishes, rather
than over the whole candidate cache. The scope decision matters and is worth not re-litigating:
`enrich.mjs` walks `candidates.json` and skips anything already carrying a `detailsFetchedAt`, so
the only way to widen its mask is `--no-resume`, which re-buys all 3,745 prefiltered candidates
whether or not the place ever reached the catalog. `backfill-atmosphere.mjs` takes the catalog as
its input instead: 2,792 rows carry a `placeId`, five of which are duplicate listings of the same
venue, so **2,787 distinct places at $25/1k = $69.68** at list price, or $44.68 if the month's
1,000-call Enterprise + Atmosphere allowance was still intact. Zero failures.

An earlier plan put this at $29. That figure is §2.5's *marginal* premium on 5,722 newly
discovered venues during a full-county discovery run that has not happened, not the cost of
backfilling places we already hold. The two are not interchangeable.

### 5.1 Fill rates, measured over the 2,787 venues bought

Regenerate with `node scripts/import-google-venues/audit-atmosphere-fill.mjs`.

| Field | Fill | Verdict |
|---|---|---|
| `accessibilityOptions` | 98.9% | published |
| `paymentOptions` | 98.6% | published |
| `parkingOptions` | 96.1% | published |
| `delivery` | 90.9% | captured, not published |
| `takeout` | 87.6% | captured, not published |
| `dineIn` | 86.0% | captured, not published |
| `restroom` | 82.8% | published |
| `servesBeer` | 80.8% | reaches the page as `dealTypes` |
| `priceLevel` / `priceRange` | 79.4% | published |
| `liveMusic` | 77.1% | published |
| `servesWine` | 74.4% | reaches the page as `dealTypes` |
| `outdoorSeating` | 74.2% | published |
| `goodForChildren` | 74.1% | captured, not published |
| `reservable` | 73.8% | published |
| `servesCocktails` | 72.0% | reaches the page as `dealTypes` |
| `servesDessert` | 70.0% | captured, not published |
| `goodForWatchingSports` | 69.6% | published |
| `servesCoffee` | 69.2% | captured, not published |
| `servesLunch` | 68.5% | captured, not published |
| `servesDinner` | 64.2% | captured, not published |
| `menuForChildren` | 60.5% | captured, not published |
| `servesBreakfast` | 60.4% | captured, not published |
| `goodForGroups` | 59.6% | published |
| `servesVegetarianFood` | 59.5% | published |
| `servesBrunch` | 51.0% | captured, not published |
| `editorialSummary` | 46.0% | captured, not published |
| `curbsidePickup` | 44.9% | captured, not published |
| `containingPlaces` | 40.4% | captured, not published |
| `allowsDogs` | 39.2% | published, but see below |
| `regularSecondaryOpeningHours` | 25.8% | already load-bearing |
| **`openingDate`** | **0.0%** | **do not model** |
| **`subDestinations`** | **0.0%** | **do not model** |

### 5.2 The two dead fields

`openingDate` and `subDestinations` were both argued for in §2.2 — "newly opened" as an editorial
angle, and the hotel-bar and food-hall-stall relationship the catalog cannot currently express.
Google returned neither for a single one of the 2,787 venues. They cost nothing extra to ask for
and they are worth nothing to model. Anything proposing to build on either should be pointed here.

### 5.3 Why fill rate decides display, not filtering

Nothing amenity-derived is a browse filter, and that is deliberate. A filter asserts something
about every venue it excludes, so a filter over a field with 39% coverage silently drops the 61%
Google stayed quiet about — the user sees a short list and has no way to know it is short because
of missing data rather than missing venues. A venue-page badge makes no claim about anyone else.

`allowsDogs` is the sharp case. It is published because a dog-friendly patio is a real reason to
pick a bar, and it is the weakest field on the page at 39%. Absent has to keep meaning unknown:
collapsing it to `false` would tell the visitors of 1,694 venues that dogs are banned when Google
merely never said. The published surface is therefore affirmative-only — a fact appears when it is
`true` and nothing appears when it is `false` or absent — while the stored data keeps all three
states so a later surface that needs the distinction still has it.

### 5.4 What is captured but not published

Everything in the mask is in `.data/import/google/atmosphere.json`, stored as whole responses.
The published set is a judgement about a happy-hour site, not about the data: `delivery`,
`takeout`, `dineIn` and `curbsidePickup` describe how food leaves the building; the `serves*` meal
variants are a restaurant-guide concern; `servesBeer`/`servesWine`/`servesCocktails` already reach
the page through `dealTypes` and would say it twice; `goodForChildren` and `menuForChildren` are
off-audience here; `editorialSummary` is Google-authored prose at 46% with attribution strings
attached. All of it is bought and sitting there if any of those judgements change.

### 5.5 Place-id gap closed (same day)

The first Atmosphere run only covered catalog rows that already carried a `placeId`. **416 rows
had none**, including **294 published-visible** pages that therefore never rendered Good to Know —
Surfside Fish House among them — even though many of those places already sat in
`.data/import/google/enriched.json` / `candidates.json`.

`link-place-ids.mjs` matched missing rows to the local caches on **exact normalized name + nearest
pin within 0.01°**. No Places calls; no fuzzy names.

| | Count |
|---|---|
| Missing `placeId` before | 416 |
| Linked | **406** (97.6%) |
| Leftovers (not stamped) | **10** — all published; name missing from cache or coord too far to trust |
| Distinct new Atmosphere calls | **401** at $25/1k |
| Spend this run | **$10.03** list (resume skipped the 2,787 already bought) |
| Atmosphere store after | 3,188 places |

Published-visible Good to Know after merge: **627 / 636**. The nine still missing are exactly the
unlinkable leftovers (Waterfront, Bracero, Juniper & Ivy, Neighborhood, Patio on Lamont, Luce,
PB AleHouse, Sushi Lounge Point Loma, Sushi Lounge Poway). Re-linking those needs a Text Google
lookup or a manual id, not another Atmosphere pass.

---

## Sources

All checked 31 August 2026.

- [Google Maps Platform core services pricing list](https://developers.google.com/maps/billing-and-pricing/pricing)
  — per-SKU rates, volume bands and free monthly call counts.
- [Google Maps Platform API usage details](https://developers.google.com/maps/billing-and-pricing/sku-details)
  — which fields belong to which SKU, and the Autocomplete-session billing note.
- [Places API usage and billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing)
  — "you are billed at the highest SKU applicable to your request".
- [Place Details (New)](https://developers.google.com/maps/documentation/places/web-service/place-details)
  — the authoritative Essentials / Pro / Enterprise / Enterprise + Atmosphere field lists used in §2.2.
- [Nearby Search (New)](https://developers.google.com/maps/documentation/places/web-service/nearby-search)
  — the Nearby Search field-to-SKU lists, confirming `places.rating` is Enterprise.
- [Google Maps Platform pricing](https://mapsplatform.google.com/pricing/)
  — the 1 March 2025 change: $200 credit retired, replaced by per-SKU free calls.
- [Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
  — §3 Google ID Caching (place IDs cacheable) and the Places API caching clause (latitude and
  longitude, 30 consecutive calendar days).
- [Policies and attributions for Places API](https://developers.google.com/maps/documentation/places/web-service/policies)
  — "You must not pre-fetch, cache, or store Places API content", with place IDs exempt.
