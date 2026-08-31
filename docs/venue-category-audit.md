# Venue Category Audit

Which *kinds* of place belong in this catalog, which do not, and which ones we have never looked
for.

**Status: the exclusion half is built and live in the pipeline. The addition half is still parked.
No listing has been deleted yet.** Read the decision section below before acting on anything here.

Every count below was read out of `public/data/happy-hours.json` and `.data/import/google/` on
**31 August 2026**, not remembered. Pricing comes from `docs/places-api-cost-analysis.md`. Google's
type tables were checked against the [Place Types (New)](https://developers.google.com/maps/documentation/places/web-service/place-types)
reference on the same date, because only Table A types can be used as `includedTypes` and half the
interesting categories needed verifying.

Headline: **the exclusions now prefilter 8.7% more of the candidate pool than the old blocklist did,
worth about $10 of Details on the full run and 174 junk listings out of the catalog; the addition
list is where the money is, and it costs about $20 per type added.** The exclusions were worth doing
for catalog quality, not for the budget — the dollar saving is small and inflating it would not help
anyone. The additions are worth doing because we have never once searched for a bowling alley.

---

## Decision: exclusions built, additions still on hold

The owner reviewed this document on **31 August 2026** and accepted the recommendation — Tier 1
into `SEARCH_TYPES`, Tier 2 through a Text Search seeder, the §6 exclusions at the enrich
prefilter — and then decided not to do the addition half yet. The discovery run goes ahead on the
five search types the pipeline has always used, at the ~$350 budget.

**What is built, as of this revision:**

- `lib/category-rules.mjs` — the category axis, matching on `primaryType` with a name escape hatch,
  enforced at the enrich prefilter, at staging, at stub import and in the purge script (§6).
- `lib/chain-blocklist.mjs` — extended from 41 brand patterns to 67. The new ones are the
  Starbucks-class corporate coffee, bakery and quick-serve brands, plus the convenience marts (§6.5).
- `tests/venue-blocklist.test.mjs` — nine tests, wired into `npm test`. The load-bearing ones assert
  what must **not** be excluded: sit-down chains, local multi-location operators, `manufacturer`.

**What is not:**

- **`SEARCH_TYPES` is unchanged and there is no `seed-rare-types.mjs`.** §7 is still a design, not
  work underway. That includes the owner's bowling alleys and comedy clubs.
- **Nothing has been deleted from the catalog.** The purge is written and has been dry-run only;
  the counts are in §6.6 and the decision is the owner's.
- **The seven questions in §9 are still open**, and §9 has grown by the borderline brand calls the
  audit turned up.

**Why the additions stay parked.** The overage is the whole reason. §5.4 lands at ~$561 against a
~$350 budget, and Tier 1 is essentially all of the difference — nine types at roughly $25 each,
spent up front on grid sweeps before anyone knows what the current five types yield at full county
coverage. The run about to happen is the cheapest available evidence about whether that money buys
anything.

**What would trigger picking it up.** Any one of these; the first is the expected one.

- The full run finishes and the bar-adjacent categories still look truncated — the 20-result cap
  visibly hiding inventory in the Gaslamp, North Park and Pacific Beach, which is the specific
  claim Tier 1 rests on.
- The free Text Search check in §10 is run and shows bowling alleys and comedy clubs really are
  absent from the enriched cache. That check costs $0, settles Tier 2 on its own, and is the one
  piece of this that can happen at any time without a budget conversation.
- The budget rises, or a second month of the free SKU allowance makes the incremental Tier 1 order
  at the end of §5.4 affordable.
- The catalog needs breadth rather than depth for a business reason — a launch, a partnership, or
  the directory framing in §10.

**What it costs when picked up.** ~$561 against ~$350 for the run as planned: about **$211 of new
spend**, of which Tier 1 discovery is $200–280 and the rest is rounding. Tier 2 is ~$0 inside the
Text Search allowance. The engineering left is half of what it was — `lib/category-rules.mjs` and
the gating are done, so what remains is nine strings in `constants.mjs` and a seeder modelled on
`seed-from-locators.mjs` (§8).

**What gets more expensive by waiting.** Not much, which is why parking the additions is
reasonable. The exclusions were the exception — every run without them added more 7-Elevens — which
is why they are the half that got built.

**The open questions in §9 still block the addition work.** Hotels, casinos, mall and airport
concessions, liquor stores, tasting rooms, the existing listings, and the budget itself. None were
answered by this decision, and answering them is the first task when the additions come off hold.

---

## 0. The test being applied

The owner's criteria, quoted:

> The requirements to make it into the dataset should be:
> - They have some sort of special or happy hour.
> - They are the type of establishment that potentially could have a special or happy hour.
> - There is a possibility that the owner may claim the venue.
>
> It doesn't have to be all of those. It can be any one of those requirements.

This is a logical OR, and it is deliberately generous. Two consequences run through the whole
document:

- **A low hit rate is not, by itself, grounds for exclusion.** A category where nobody has a
  happy hour today can still pass on criterion 2 or 3. Coffee shops score 1.9% and stay.
- **Brand and category are separate axes.** The owner's own example: Starbucks is out, local
  coffee shops are in. `chain-blocklist.mjs` is the brand axis and already works. This document is
  the category axis. A rule on one must not be argued from evidence about the other — the
  `fast_food_restaurant` numbers in §3 are mostly the blocklist's job, not a category verdict.

The only categories that fail the OR test entirely are the ones where **no location of any brand
would ever run a special, and no owner would ever claim the page.** That is a much smaller list
than "categories with a bad hit rate", and §6 is deliberately short because of it.

---

## 1. Method, and what the numbers cannot tell you

The catalog was joined to `enriched.json` on `placeId` to attach Google's `primaryType` and `types`
to each listing.

| | Count |
|---|---|
| Catalog listings | 3,208 |
| — with a `placeId` | 2,792 |
| — joined to an enriched record | 2,787 (421 unmatched: legacy seeds and locator imports) |
| — `hasHappyHourData: true` | 557 |
| — with a schedule (`startTime` set) | 800 |
| — `listingStatus: published` | 690 |
| Enriched records (a Place Details call was bought for each) | 5,361 |
| — `qualified` | 3,804 |

**"Hit rate" throughout means `hasHappyHourData` over catalog listings in that category.** The
557 figure, not the 800, because 800 counts listings that carry a window inherited from Google's
`regularSecondaryOpeningHours` without a confirmed deal behind it.

Three limits worth stating before the tables get used as evidence:

1. **The sample is closed under the current search.** Every one of the 5,361 enriched places was
   returned by a search for `restaurant`, `bar`, `cafe`, `night_club` or `brewery` — I checked, and
   **zero** enriched places lack all five of those in `types`. So the eight bowling alleys we have
   are the eight that Google *also* tags as restaurants. A bowling alley with a bar and no
   restaurant tag is not in this dataset, cannot be counted, and is exactly the venue §7 is about.
   The addition-side numbers are therefore a **floor on what exists, not an estimate of it.**
2. **A zero can mean "no happy hour" or "we could not find it".** Thai restaurants are 0/36. Thai
   restaurants in San Diego do run specials; what they mostly do not have is a scrapeable website
   saying so. That is an extraction problem wearing a category costume, and it is not an argument
   for excluding Thai food.
3. **Truncation biases toward the famous.** Nearby Search caps at 20 by popularity, so within any
   category the venues we hold skew large and well-reviewed. Small, local, claimable places — the
   ones the business actually wants — are the ones being cut off.

---

## 2. The catalog by primary type

Every `primaryType` with at least 10 listings. `n` is catalog listings, `HH` is
`hasHappyHourData`, `Details` is Place Details calls bought for that type across the whole
enriched cache including places that never reached the catalog.

| primaryType | n | HH | Hit rate | Details bought |
|---|---|---|---|---|
| *(unmatched — legacy seeds)* | 421 | 173 | 41.1% | — |
| `coffee_shop` | 321 | 6 | 1.9% | 759 |
| `restaurant` | 305 | 76 | 24.9% | 540 |
| `mexican_restaurant` | 231 | 32 | 13.9% | 344 |
| `cafe` | 162 | 2 | 1.2% | 272 |
| `bar` | 141 | 27 | 19.1% | 335 |
| `brewery` | 116 | 11 | 9.5% | 170 |
| `american_restaurant` | 97 | 28 | 28.9% | 159 |
| `italian_restaurant` | 87 | 19 | 21.8% | 126 |
| `pizza_restaurant` | 80 | 15 | 18.8% | 134 |
| `bar_and_grill` | 61 | 20 | **32.8%** | 85 |
| `breakfast_restaurant` | 59 | 0 | 0.0% | 73 |
| `seafood_restaurant` | 54 | 24 | **44.4%** | 92 |
| `mediterranean_restaurant` | 41 | 5 | 12.2% | 47 |
| `taco_restaurant` | 37 | 1 | 2.7% | 76 |
| `sushi_restaurant` | 37 | 8 | 21.6% | 54 |
| `thai_restaurant` | 36 | 0 | 0.0% | 42 |
| `chinese_restaurant` | 34 | 2 | 5.9% | 70 |
| `hamburger_restaurant` | 34 | 6 | 17.6% | 85 |
| `bakery` | 34 | 1 | 2.9% | 43 |
| `sports_bar` | 29 | 11 | **37.9%** | 47 |
| `sandwich_shop` | 28 | 2 | 7.1% | 77 |
| `convenience_store` | 27 | 0 | **0.0%** | 233 |
| `barbecue_restaurant` | 26 | 8 | 30.8% | 39 |
| `japanese_restaurant` | 25 | 3 | 12.0% | 35 |
| `steak_house` | 25 | 8 | 32.0% | 37 |
| `winery` | 25 | 5 | 20.0% | 42 |
| `cocktail_bar` | 24 | 3 | 12.5% | 36 |
| `tea_house` | 24 | 0 | 0.0% | 27 |
| `donut_shop` | 23 | 0 | 0.0% | 30 |
| `vietnamese_restaurant` | 21 | 1 | 4.8% | 22 |
| `grocery_store` | 21 | 0 | **0.0%** | 24 |
| `chicken_restaurant` | 19 | 3 | 15.8% | 46 |
| `deli` | 17 | 0 | 0.0% | 20 |
| `hawaiian_restaurant` | 16 | 1 | 6.3% | 20 |
| `brunch_restaurant` | 16 | 0 | 0.0% | 24 |
| `brewpub` | 15 | 6 | **40.0%** | 24 |
| `ice_cream_shop` | 15 | 0 | 0.0% | 19 |
| `indian_restaurant` | 14 | 3 | 21.4% | 19 |
| `fast_food_restaurant` | 14 | 0 | **0.0%** | 279 |
| `hotel` | 13 | 1 | 7.7% | 14 |
| `bagel_shop` | 13 | 0 | 0.0% | 25 |
| `wine_bar` | 12 | 3 | 25.0% | 15 |
| `middle_eastern_restaurant` | 12 | 0 | 0.0% | 12 |
| `lounge_bar` | 11 | 1 | 9.1% | 40 |
| `ramen_restaurant` | 10 | 3 | 30.0% | 14 |
| `store` | 10 | 0 | 0.0% | 10 |
| `night_club` | 10 | 0 | 0.0% | 80 |

Read this alongside the `types`-membership view, which is more honest about what a venue *is*
because a place carries several types. Selected rows, catalog listings whose `types` array
contains the type:

| type (in `types`) | n | HH | Hit rate |
|---|---|---|---|
| `tex_mex_restaurant` | 14 | 13 | 92.9% |
| `oyster_bar_restaurant` | 14 | 8 | 57.1% |
| `gastropub` | 25 | 14 | 56.0% |
| `brewpub` | 51 | 26 | 51.0% |
| `pub` | 103 | 49 | 47.6% |
| `banquet_hall` | 19 | 9 | 47.4% |
| `bar_and_grill` | 178 | 83 | 46.6% |
| `cocktail_bar` | 130 | 58 | 44.6% |
| `sports_bar` | 126 | 50 | 39.7% |
| `bar` | 811 | 289 | 35.6% |
| `seafood_restaurant` | 126 | 44 | 34.9% |
| `wine_bar` | 118 | 41 | 34.7% |
| `beer_garden` | 44 | 15 | 34.1% |
| `karaoke` | 19 | 6 | 31.6% |
| `live_music_venue` | 73 | 22 | 30.1% |
| `event_venue` | 190 | 55 | 28.9% |
| `video_arcade` | 21 | 6 | 28.6% |
| `winery` | 30 | 7 | 23.3% |
| `restaurant` | 2,071 | 351 | 16.9% |
| `cafe` | 764 | 16 | 2.1% |
| `coffee_shop` | 575 | 11 | 1.9% |
| `fast_food_restaurant` | 104 | 2 | 1.9% |
| `bakery` | 173 | 1 | 0.6% |
| `tea_house` | 79 | 0 | 0.0% |
| `convenience_store` | 33 | 0 | 0.0% |
| `thai_restaurant` | 40 | 0 | 0.0% |
| `middle_eastern_restaurant` | 33 | 0 | 0.0% |

The shape of it: **anything with "bar" or "pub" in its type is a 35–57% hit; anything that is a
shop rather than a room you sit and drink in is under 3%.** That line — do people sit down and
order a drink here — predicts the hit rate better than cuisine, price or rating does.

Two rows deserve calling out because they are the interesting ones for the addition list:
`karaoke` at 31.6%, `live_music_venue` at 30.1%, `video_arcade` at 28.6% and `banquet_hall` at
47.4% are all **higher than plain `restaurant` at 16.9%**, and every one of them arrived here by
accident, as a side effect of a restaurant or bar search.

---

## 3. What is in the catalog that should not be

Named examples, so the judgement can be checked rather than trusted.

**Convenience stores — 27 listings, 0 happy hours, 233 Details calls.** Twenty of the 27 are
literally named `7-Eleven`; the rest are Circle K, ampm, ExtraMile and a food mart. A further 206 sit in the enriched cache without
reaching the catalog. This is the single clearest case in the dataset: a 7-Eleven does not run a
happy hour, cannot run one, and no franchisee is going to claim a page on a San Diego happy hour
site. It fails all three criteria. It also cost roughly **$4.70 in Details calls** to learn that,
which is the cheap version of this mistake — the expensive version is the full-county run.

**Grocery stores and supermarkets — 26 listings, 0 happy hours.** Jimbo's (three locations),
North Park Produce, Balboa International Market, `Commissary Naval Base San Diego`. A commissary
on a naval base is not a venue. Note the near-miss: `market` in `types` scores 22.6% (7 of 31),
because a "market" in San Diego is often a bar with a deli counter. **Exclude `grocery_store` and
`supermarket`; keep `market`.**

**Fast food — 14 listings, 279 Details calls, 0 happy hours.** Chipotle ×4, Wienerschnitzel,
Rally's, Dairy Queen, Wetzel's Pretzels. The 265 enriched-but-not-catalogued are McDonald's,
Carl's Jr., Jack in the Box, Chick-fil-A. Most of those were stopped by the blocklist *after* the
Details call, not before it — the blocklist runs on the candidate name at enrich, so the ones
that got through are brands not on the list. A category rule catches the long tail the brand list
never will.

**Retail and services that are not venues.** `store` (10 listings — vape shops, smoke shops,
`1835 Creative Studios`), `book_store` (7), `gift_shop`, `nail_salon`, `art_gallery`, `art_studio`,
`government_office`, `educational_institution`, `shipping_service`, `tour_agency`, `coworking_space`,
`indoor_playground`, `swimming_pool`. Individually tiny, collectively 30-odd Details calls and a
guaranteed zero. `Welldeck Recreation Center` on a naval base is in the catalog as a fast food
restaurant.

**Delivery-only and catering.** `meal_delivery`, `meal_takeaway`, `catering_service`,
`food_court`, `pizza_delivery` — 40 Details calls, one happy hour between them, and that one is a
misclassification in our favour: `SD TapRoom` is a genuine taproom that Google typed
`pizza_delivery`. There is no room to sit in a ghost kitchen and no window to discount. Google
also exposes `pureServiceAreaBusiness` on Place Details, which flags a business with no storefront
directly; §8.5 of the cost analysis already recommends capturing it. That boolean is a better rule
than the type list.

**Lodging as a building.** `motel`, `rv_park`, `lodging` — zero yield. `hotel` is a different
question and is in §8, because the hotel *bar* is real.

### The categories I looked at and decided to keep

Stating these explicitly, because the hit rates make them look like exclusion candidates and they
are not:

| Category | Hit rate | Why it stays |
|---|---|---|
| `coffee_shop` / `cafe` | 1.9% / 1.2% | The owner named this as an expansion target. 321 catalog listings, almost all locally owned — `Por Vida`, `Communal Coffee`, `Lestat's on Park`, `Bird Rock Coffee Roasters`. Passes criteria 2 and 3 comfortably. The Starbucks problem is the blocklist's, and the blocklist already holds Starbucks, Dunkin', Peet's and Coffee Bean |
| `breakfast_restaurant` | 0/59 | Morning Glory, Breakfast Republic, Snooze. Zero happy hours is correct and beside the point — bottomless mimosas are a special, and these are exactly the kind of independent operator who claims a listing |
| `thai_restaurant`, `middle_eastern_restaurant`, `korean_restaurant` | 0% | Extraction failure, not category failure. See §1 limit 2 |
| `tea_house` (boba) | 0/24 | Kung Fu Tea, Ding Tea, Bei Yuan. Boba shops run happy-hour pricing constantly; we have no source that publishes it. Local ownership is the norm. Criterion 3 alone carries this |
| `donut_shop`, `bakery`, `ice_cream_shop`, `juice_shop` | ~0% | Same reasoning. `Donut Bar`, `Nomad Donuts`, `Sidecar Doughnuts` are independents. Low value, but not *negative* value |
| `liquor_store` | 0/6 | Genuinely borderline — see §8. `Vino Carta Wine Shop and Bar` and `Holiday Wine Cellar` run tastings; `Country Wine & Spirits Gas Station` does not |

The distinction being drawn: a 7-Eleven is *pollution*, a quiet boba shop is *inventory*. Both
have a 0% hit rate. Only one of them fails the owner's test.

---

## 4. What we have never looked for

`SEARCH_TYPES` in `lib/constants.mjs` is five types and has been since the pipeline was written:

```js
export const SEARCH_TYPES = ['restaurant', 'bar', 'cafe', 'night_club', 'brewery'];
```

Everything else in the catalog is there by accident — because Google also tagged it `restaurant`
or `bar`. The evidence for that is flat: **0 of 5,361 enriched places lack all five types.**

All of the following are Table A types, verified against Google's reference, so every one can be
passed as an `includedType`. The county estimates are mine, from local knowledge and the shape of
the existing data; they are estimates and are labelled as such.

### Tier 1 — high yield, add these

| Type | In catalog today | Hit rate | Est. county population | Why |
|---|---|---|---|---|
| `sports_bar` | 126 | **39.7%** | 200–300 | Third-highest hit rate of any large category. A sports bar with no `bar` tag is invisible today |
| `pub` | 103 | **47.6%** | 120–180 | Nearly one in two has a happy hour |
| `wine_bar` | 118 | **34.7%** | 100–150 | |
| `cocktail_bar` | 130 | **44.6%** | 150–250 | |
| `brewpub` | 51 | **51.0%** | 60–100 | Separate type from `brewery`, and the pub half is where the happy hour is |
| `gastropub` | 25 | **56.0%** | 40–70 | Highest hit rate of any category with n ≥ 20 |
| `beer_garden` | 44 | 34.1% | 30–50 | |
| `winery` | 30 | 23.3% | 100–140 | San Diego has a real wine industry — Ramona, Escondido, Julian. Tasting-room specials are standard. Note the county trap: half the wineries in the enriched cache are Temecula and get discarded by the county filter |
| `live_music_venue` | 73 | 30.1% | 60–100 | Beats plain `restaurant` |

These eight are not speculative expansion. They are categories we **already hold hundreds of
listings in, at hit rates above the catalog average**, discovered accidentally. Searching them
directly mostly buys depth: the 20-result truncation cap means a `bar` search in the Gaslamp
returns the twenty most famous bars, and a `cocktail_bar` search returns twenty *more*.

### Tier 2 — the owner's non-food-and-drink expansion

| Type | In catalog | Hit rate | Est. county | Assessment |
|---|---|---|---|---|
| `bowling_alley` | 5 | 0% | 25–35 | The owner's example. Nearly every bowling alley in the county has a full bar and most run a weeknight special. The 0% is 5 venues that came in as restaurants, not evidence. **High confidence, low sample** |
| `comedy_club` | 3 | 33% | 8–15 | The owner's example. Two-drink minimums, pre-show specials, and the clubs are independently owned. `ENTONO Live Music & Comedy` is already in the enriched cache |
| `karaoke` | 19 | **31.6%** | 30–50 | Better hit rate than `restaurant`, and it arrived by accident |
| `video_arcade` | 21 | **28.6%** | 20–35 | Barcades are a San Diego staple. `Brewski's Bar & Arcade` is in the cache already |
| `banquet_hall` | 19 | **47.4%** | 40–70 | Surprisingly strong. Caveat: many are attached to a restaurant that we already hold, so expect overlap |
| `event_venue` | 190 | 28.9% | 200–400 | Large and high-yield, but the messiest type on the list — it catches `Quartyard` and `The Collective`, and also wedding barns |
| `casino` | 3 | 0% | 10–15 | Tribal casinos: Sycuan, Barona, Viejas, Pala, Jamul, Harrah's. Each contains multiple bars and restaurants that absolutely run specials. See §8 — the question is whether we list the casino or its venues |
| `golf_course` | 10 | 10% | 80–100 | The clubhouse bar is the venue. `The Loma Club`, `Singing Hills at Sycuan`. Moderate confidence |
| `movie_theater` | 9 | 11% | 40–60 | Only the dine-in ones matter: `THE LOT`, `Cinépolis Luxury`, `Angelika`, `Rooftop Cinema Club`. Four brands, not a category — arguably better handled by a seed list than a type search |
| `amusement_center` | 8 | 25% | 20–30 | K1 Speed, Boardwalk, Round1. Mixed: some have bars, Chuck E. Cheese does not |
| `miniature_golf_course` | 1 | — | 10–20 | Thin. Low priority |
| `concert_hall` / `performing_arts_theater` / `amphitheatre` | 7 | 0% | 20–30 | Venue bars exist but are event-gated, not a recurring happy hour. **Low priority** |
| `hookah_bar` | 14 | 0% | 15–25 | A bar in name. 0/14 is a real signal, not a small sample. **Do not add** |

Types I checked and am **not** proposing: `fitness_center`, `spa`, `marina`, `arena`, `stadium`,
`tourist_attraction`, `farm`. Either no drink service, or the drink service is a concession stand
with no owner to claim it.

---

## 5. Cost impact

Per `docs/places-api-cost-analysis.md`: Nearby Search Enterprise **$35/1k**, Place Details
Enterprise **$20/1k** ($25/1k with Atmosphere), AI extraction **$0.012–$0.023 per venue**. The
expected full run is ~7,500 discovery calls and ~5,722 Details calls, about $322–346 all in.

### 5.1 What the exclusions save

Re-measured against the rules as they were actually built, over the 5,714 candidates in the cache:

| Prefilter | Candidates it stops | Share | Projected on 5,722 new Details | Saving @ $20/1k | AI extraction avoided |
|---|---|---|---|---|---|
| Old blocklist, 41 brands | 710 | 12.4% | — | already banked | — |
| **New brands (§6.5)** | **404** | 7.1% | ~405 calls | **$8** | ~$5–9 |
| **Category rules (§6), net of the above** | **91** | 1.6% | ~90 calls | **$2** | ~$1–2 |
| §3 "keep but deprioritise" — still not proposed | 355 | 6.2% | ~380 calls | $8 | $5–9 |

The category rules stop far fewer candidates than the parked version predicted — 91 rather than 720
— for two reasons, and both are worth understanding before anyone reads this as a shortfall. Most of
what the category list would have caught is a 7-Eleven or a Circle K that the brand list now catches
first, and the twelve types removed in §6.1 were the bulk of the rest.

**Total incremental saving: roughly $10–20 on the run.** I am not going to inflate this. The dollar
saving is small; the reason to do it is that 20 7-Elevens and ten Panera Breads are in the catalog
right now and every one of them is a page a visitor can land on and a row in the claim search.

### 5.2 What the additions cost

The fixed grid is 567 cells. One more type is one more call per cell:

> 567 cells × $0.035 = **$19.85 per added type**, before subdivision.

Rare types barely subdivide — the cost analysis measured `night_club` and `brewery` staying near
600 calls total against `restaurant`'s 2,931 — so budget **$20–25 per type** for Tier 2 and
**$25–35** for the dense Tier 1 bar types, which will subdivide in the Gaslamp.

| Package | Types | Discovery cost | New Details (est.) | Details cost | Total |
|---|---|---|---|---|---|
| Tier 1 (8 bar-adjacent types) | 8 | $200–280 | 600–1,000 | $12–20 | **$212–300** |
| Tier 2 core (`bowling_alley`, `comedy_club`, `karaoke`, `video_arcade`, `banquet_hall`, `casino`, `golf_course`, `amusement_center`) | 8 | $160–200 | 250–450 | $5–9 | **$165–209** |
| Both | 16 | $360–480 | 850–1,450 | $17–29 | **$377–509** |

That is more than the entire current run budget, and it is the finding that matters most in this
document. **Adding types is expensive because discovery cost scales with the grid, not with how
many venues the type actually has.** Searching all 567 cells for comedy clubs costs $20 to find
maybe twelve venues.

### 5.3 The cheaper way to buy the additions

Text Search Pro is **$32/1k with 5,000 free calls per month**, and `seed-from-locators.mjs`
already uses it at $0 because its volume sits inside the allowance. A rare type does not need a
567-cell sweep. `"bowling alley in San Diego County"` over 20–30 coarse regional anchors finds
essentially all of them, and 30 calls × 16 types = 480 calls — **free, inside the monthly Text
Search allowance.**

This splits the addition list cleanly:

| Category shape | Mechanism | Cost |
|---|---|---|
| Dense, urban, truncation-limited (Tier 1 bar types) | Add to `SEARCH_TYPES`, full grid | $200–280 |
| Sparse, countable, geographically obvious (Tier 2) | Text Search sweep on regional anchors | ~$0 |

**Recommendation: add Tier 1 to `SEARCH_TYPES`; do Tier 2 as a Text Search seeder.** That gets the
owner's bowling alleys and comedy clubs for nothing and spends the real money only where the
20-result cap is genuinely hiding inventory.

### 5.4 Net

| Line | Cost |
|---|---|
| Baseline full run (expected, capture-everything mask) | $346 |
| − §6 and §6.5 exclusions (built) | −$10 |
| + Tier 1 types in `SEARCH_TYPES` | +$240 |
| + Tier 2 via Text Search seeder | +$0 |
| **Proposed total** | **~$561** |

If $561 is over budget, the order to cut in is: Tier 2 seeder first (free), then exclusions
(cheap, improves quality), then Tier 1 types one at a time by hit rate — `gastropub` (56%),
`brewpub` (51%), `pub` (48%), `cocktail_bar` (45%), `sports_bar` (40%), `wine_bar` (35%),
`beer_garden` (34%), `live_music_venue` (30%), `winery` (23%). Each is ~$25 and independent.

---

## 6. The exclusion list as built — `lib/category-rules.mjs`

**Rule: exclude on `primaryType` only, never on `types` membership.** This is load-bearing.
`manufacturer` appears in the `types` of 204 catalog listings at an 18.1% hit rate, because
Google tags breweries as manufacturers. Excluding on `types` would delete a fifth of the breweries.
As a `primaryType` it appears 5 times and yields nothing — and it is still not on the list, because
the cost of being wrong about it is asymmetric.

```
convenience_store    gas_station          grocery_store        supermarket
asian_grocery_store  department_store     shopping_mall        store
wholesaler           supplier             book_store           gift_shop
toy_store            home_goods_store     meal_delivery        nail_salon
beauty_salon         spa                  art_gallery          art_studio
government_office    educational_institution                   non_profit_organization
community_center     coworking_space      tour_agency          travel_agency
indoor_playground    athletic_field       fitness_center       gym
lodging              motel                rv_park
```

Deliberately **not** on the list, despite low or zero hit rates: `coffee_shop`, `cafe`, `bakery`,
`donut_shop`, `bagel_shop`, `tea_house`, `tea_store`, `ice_cream_shop`, `juice_shop`,
`dessert_shop`, `breakfast_restaurant`, `deli`, `sandwich_shop`, `thai_restaurant`, `liquor_store`,
`hotel`, `market`. Reasons in §3 and §9.

### 6.1 Twelve types came off the proposed list, and the reason matters

The parked version of this document also proposed `fast_food_restaurant`, `meal_takeaway`,
`pizza_delivery`, `catering_service`, `food_court`, `tea_store`, `food_store`, `health_food_store`,
`shipping_service`, `swimming_pool`, `hot_dog_stand` and `butcher_shop`. They are gone, because
listing the venues each one would actually have deleted did not survive the owner's third criterion.

| Type | What it would have deleted | Verdict |
|---|---|---|
| `fast_food_restaurant` | Angelo's Burgers, El Tapatio Restaurant, Mariscos Gonzalez, Philly Steak Subs — alongside Wienerschnitzel, Rally's and Wetzel's Pretzels | **Off the list.** Four of the nine are local independents Google mistyped. The corporate half is the brand list's job, and the brand list does it by name with no collateral damage |
| `meal_takeaway`, `pizza_delivery` | It's Raw Poke Shop, Stage Stop Pizza, Tasty Pizza, Jibaritos de la Isla, SD TapRoom | **Off the list.** A local pizzeria that also delivers is still a local pizzeria |
| `catering_service` | Regrind Coffee, Big Oven Pizza Mobile Truck | **Off the list.** Mixed, and the coffee half passes criterion 3 |
| `food_court` | Portside Pier, Market on 8th | **Off the list.** Both are food halls with bars in them |
| `tea_store` | OMOMO TEA SHOPPE | **Off the list.** §3 keeps boba explicitly, so this type was contradicting it |
| `shipping_service` | Leucadia Pizza — Carlsbad | **Off the list.** The only listing under it is a real restaurant, mistyped |
| `food_store`, `health_food_store`, `butcher_shop` | Bougie's Cheese Shop, All Aboard Charcuterie, Ramona Family Naturals | **Off the list.** A cheese shop that pours wine is a plausible venue |
| `swimming_pool` | Dive at Harrah's Resort SoCal | **Off the list.** That one is a pool bar at a casino |
| `hot_dog_stand` | 1904 Street Dogs | **Off the list.** One local stand, and criterion 3 is arguable |

The general shape of the finding: **Google's `primaryType` is noisy in exactly the direction that
hurts, mistyping small local businesses as delivery and fast food.** Every type kept on the list is
one where the noise runs the other way — nothing gets mistyped *as* a nail salon.

### 6.2 The name escape hatch

`SD TapRoom` proves Google's `primaryType` is sometimes simply wrong: a genuine taproom with a
genuine happy hour, typed `pizza_delivery`. It is the only listing in the catalog carrying an
excluded type and a happy hour, and the escape hatch is why it survives.

If the name matches `bar`, `pub`, `tavern`, `taproom`, `cantina`, `brew`, `brewery`, `brewing`,
`brewhouse`, `lounge`, `grill`, `kitchen`, `cocktail`, `saloon`, `winery` or `speakeasy`, the place
is kept whatever Google typed it. Bare `brew` is in there deliberately: it saves Home Brew Mart, the
original Ballast Point site, from `store`. The hatch errs toward keeping, which is the right bias —
it also keeps four cigar-and-scotch lounges typed `store` that a stricter rule would have taken.

The same pattern guards `looksLikeShoppingMall()` in `venue-quality.mjs`. The two are not shared
yet; that is a small refactor and not worth doing until a third caller appears.

---

## 6.5 The brand list as built — `lib/chain-blocklist.mjs`

The blocklist went from 41 patterns to 67. **Where the line is drawn, since this is the judgement
the owner most needs to check:** not "chain", and not "multi-location" either. A brand is blocked
when its afternoon pricing is set in a head office *and* it reaches customers through its own app,
so no local operator has anything to gain from claiming the page.

Added, with catalog counts:

| Brand | Listings | Why |
|---|---|---|
| 7-Eleven | 20 | The owner's clearest case. Caught by category too, but discovery occasionally hands us a candidate with no type at all |
| Panera Bread | 10 | 21 in the enriched cache, not one happy hour, and the loyalty app is the only channel it markets through |
| Yum Yum Donuts | 10 | Same class as Krispy Kreme, which was already on the list |
| Dutch Bros Coffee | 7 | Drive-thru coffee. Starbucks with a different logo |
| CAVA, Chipotle, Dave's Hot Chicken, sweetgreen, Jollibee, Habit Burger, The Melt, Shake Smart | 26 | Corporate fast casual. Chipotle was a plain gap in the old list — five were live in the catalog |
| Einstein Bros., Bruegger's, Paris Baguette, Corner Bakery, 85°C Bakery Cafe | 17 | Corporate bakery-cafés, all app-driven |
| Blue Bottle, Philz, Black Rock Coffee Bar | 7 | Corporate coffee. Blue Bottle is Nestlé-owned |
| Winchell's Donut House, Foster's Freeze, Nekter Juice Bar | 8 | National franchise quick-serve |
| ampm, Circle K, ExtraMile | 4 | Gas-station marts |
| Farmer's Fridge | 0 catalog, 6 enriched | A refrigerated vending kiosk in an office lobby. Not a venue in any sense |

**Kept, explicitly, and now covered by tests:** BJ's, Chili's, Applebee's, Buffalo Wild Wings,
Olive Garden, Texas Roadhouse, Outback, Yard House, Red Robin, The Cheesecake Factory, P.F. Chang's,
Benihana, Ruth's Chris, Black Angus, On The Border. Every one has a bar and a real happy hour —
Chili's is 12 listings and 12 happy hours, the best-performing brand in the catalog. Also kept: Bird
Rock Coffee Roasters (8 locations), Lofty (6), The Taco Stand (6), Sombrero (6), Karl Strauss (5),
Communal (4), Mostra (4), James Coffee (4). Local ownership across several addresses is the profile
the business wants most, not a reason to delete.

The regex safety work carries over: whole-word matching so "Subway Tile Cafe" survives "Subway", and
whole-*name* matching for `cava`, `ampm` and `the melt`, which would otherwise reach into an
unrelated local name. `Cava Wine Bar` is a test case, not a hypothetical.

---

## 6.6 Purge impact — written, dry-run only, not executed

`npm run purge:chains` now covers both axes. The category half joins the catalog to the enriched
cache to get the primary type, because the catalog does not store it; a listing that was never
enriched is left alone rather than guessed at.

Dry run against the 3,208-listing catalog:

| Bucket | Listings | What is in it |
|---|---|---|
| Corporate chains | 115 | 20 7-Elevens, 10 Panera, 10 Yum Yum Donuts, and the rest of §6.5 |
| Excluded categories | 59 | 21 grocery stores, 5 Barnes & Noble, 5 vape and cigar shops, 4 Asian supermarkets, 3 shopping centres, 3 tour operators, 3 indoor playgrounds, a naval commissary |
| **Total** | **174** | Would leave **3,034** |
| Of those, `published` | **0** | |
| Of those, with a happy hour | **0** | |

Every one of the 174 is an `unlisted` claimable stub, which is the whole reason it is worth doing:
they are not deal pages, they are 174 rows in the claim search nobody will ever claim.

**It has not been run.** Deleting from a git-tracked catalog is the owner's call, and there is a
concurrent enrich in flight against the same file. `npm run purge:chains -- --dry-run` reproduces
the table; dropping `--dry-run` executes it and re-runs `validate:data` afterwards.

Three grocery-store misfires are worth a look before it executes, because the rule cannot tell them
apart from Jimbo's: **Cardiff Seaside Market**, **Kaelin's Market** and **Cuisinery Food Market**.
Cardiff Seaside Market in particular has a bar. Three listings out of 174 is the accuracy this rule
buys — adding `market` to the escape hatch would save those three and lose the other eighteen.

---

## 7. Proposed addition list — approved, on hold

**To `SEARCH_TYPES` (Tier 1, ~$240):**

```
sports_bar  pub  wine_bar  cocktail_bar  brewpub  gastropub  beer_garden  winery
live_music_venue
```

**To a new Text Search seeder (Tier 2, ~$0):**

```
bowling_alley  comedy_club  karaoke  video_arcade  banquet_hall  casino
golf_course    amusement_center
```

**Rejected:** `hookah_bar` (0/14 is real), `concert_hall`, `performing_arts_theater`,
`amphitheatre`, `miniature_golf_course`, `fitness_center`, `spa`, `marina`, `tourist_attraction`,
`farm`. `movie_theater` is four brands, not a category — handle as a seed list.

---

## 8. Where the rules belong

Four possible gates, cheapest first.

| Gate | File | Prevents | Verdict |
|---|---|---|---|
| Discovery | `discover.mjs` / `discover-adaptive.mjs` | The search call itself | **Cannot be used for exclusions.** `excludedPrimaryTypes` exists on Nearby Search, but the call is priced per request, not per result — excluding types does not make a `restaurant` search cheaper. It is only the mechanism for *additions* |
| Enrich prefilter | `enrich.mjs` | The $20/1k Details call | **Yes, and this is where it went.** Discovery already returns `primaryType` in the mask (`venue-pipeline-reference.md` §1.4), so the type is known for free before any Details spend. It sits beside `isBlockedChain` |
| Stage | `build-staging.mjs:33` | Catalog pollution only | **Yes, as a second pass.** Money is already spent by here, but it catches places whose Details response reveals a type the candidate record did not, and it is where `pureServiceAreaBusiness` should be checked |
| Merge | `merge.mjs` | Nothing new | No |

### Implementation — done, except the two addition items

1. **`lib/category-rules.mjs`** — done. Mirrors `chain-blocklist.mjs` in shape and in commented
   reasoning. Exports `EXCLUDED_PRIMARY_TYPES`, `isExcludedCategory(primaryType, name)` and
   `hasVenueNameSignal(name)`. Takes the type and the name separately, because the three callers
   hold them in three different shapes.
2. **`enrich.mjs`** — done. One line in the prefilter chain, beside the chain check.
3. **`build-staging.mjs`** — done, as a second pass against the enriched record. The
   `pureServiceAreaBusiness` check still waits on that field reaching `DETAILS_MASK`.
4. **`import-claimable-stubs.mjs`** — done, and this is the gate that mattered most: a stub is how
   twenty 7-Elevens reached the claim search in the first place.
5. **`merge.mjs`** — `category-rules.mjs` added to the staleness guard, so a staging file built
   before a rule change cannot be merged after it.
6. **`constants.mjs`** — **not done.** Tier 1 types are still not in `SEARCH_TYPES`. Nine extra
   types multiplies the discovery call count, so this should land with a `--max-calls` budget
   decided in advance.
7. **`seed-rare-types.mjs`** — **not written.** This is the owner's bowling alleys and comedy clubs,
   and it is the ~$0 half of §7.

`purge-chains.mjs` now covers categories as well as brands, but has only been dry-run. **The 174
already-catalogued listings the rules would have blocked are a deletion from a git-tracked file, and
that is not this document's call to make** — see §6.6 for the counts.

---

## 9. Open questions for the owner

These are genuinely borderline. I have a recommendation on each, but none should be implemented
without a decision.

**1. Hotels.** A hotel is a building, not a venue — but hotel bars run some of the best happy
hours in the county, and `The Pearl`, `TOWER23` and `La Valencia` are all in the catalog as
`hotel`, of which exactly one of 13 has a happy hour. Google exposes `subDestinations` and `containingPlaces`, which
§2.2 of the cost analysis already recommends capturing, and those would let us list *the bar* with
the hotel as its parent. **Recommendation: keep `hotel`, exclude `motel`/`lodging`/`rv_park`, and
revisit properly once `subDestinations` is in the mask.** Do not add `resort_hotel`.

**2. Casinos.** Sycuan, Barona, Viejas, Pala, Jamul. Each holds five to ten bars and restaurants
that do run specials, and the tribal operator is not going to claim a listing. So the venue we
want is inside the casino, not the casino. **Recommendation: add `casino` to the Tier 2 seeder to
find the properties, then decide whether to list the property or manually seed its bars.** Ten to
fifteen venues is small enough to handle by hand.

**3. Restaurants inside malls, airports and stadiums.** `looksLikeShoppingMall()` already excludes
the mall itself but keeps a named restaurant inside it. Airport and stadium concessions are a
different animal — no local owner, no claim, prices set by a concessionaire. **Recommendation:
exclude anything whose address resolves to San Diego International or Petco Park. Needs a rule
written; not proposed here.**

**4. Liquor stores and wine shops.** `Vino Carta Wine Shop and Bar` pours by the glass and runs
happy hour. `Country Wine & Spirits Gas Station` does not. Both are `liquor_store`. **Recommendation:
keep the category out of the exclusion list and let the name escape hatch in §6 sort it — "and Bar"
in the name is the signal.** Accept a handful of junk listings as the price.

**5. Breweries versus tasting rooms.** `brewery` is already searched and scores 9.5%, low for the
category — many are production facilities with a tasting counter and no website page. Adding
`brewpub` (51%) should help. **Question: is a production brewery with a tasting room a venue we
want?** I think yes, but the hit rate says the extraction will keep failing on them.

**6. The 174 existing listings.** Twenty 7-Elevens, 21 grocery stores, 10 Panera Breads, five Barnes
& Nobles and a naval commissary are in the catalog right now. All 174 are unlisted stubs, none has a
happy hour, and the purge is written and dry-run. Removing them is still a separate decision from
changing the filter. **Recommendation: run `npm run purge:chains` on a clean tree, once no enrich is
in flight. Check the three Markets in §6.6 first.**

**7. Budget.** §5.4 lands at ~$561 against a $350 budget. Tier 1 is the whole overage. **Question
for the owner: raise the budget, or add Tier 1 types incrementally by hit rate across two calendar
months** — which also collects the free SKU allowance twice, worth about $55 (cost analysis §1.4).

### The brand calls I deliberately did not make

These are the ones where "corporate operation that will never engage with us" genuinely could go
either way. None is in the code. Each is a one-line addition to `BRANDS` if the owner says so.

**8. Denny's (23 listings) and IHOP (8).** The largest single block of corporate listings left in the
catalog, and the reason they survived: they are sit-down restaurants, which is the category the owner
explicitly wants. But neither has a bar, neither runs anything resembling a happy hour, and both
market through corporate value menus rather than a local operator. Zero happy hours across 31
listings. **My inclination is to block both, and I did not, because the owner's Chili's/Applebee's
instruction is about sit-down chains and these are sit-down chains.** Same question, smaller:
Broken Yolk Cafe (11 — San Diego-born, franchised locally, so I lean keep), Olive Garden (6) and
Texas Roadhouse (3), both of which do have bars and stay on that basis.

**9. Regional quick-serve with a beer licence.** Round Table Pizza (2), Epic Wings (6), Rubio's
Coastal Grill (3), Mendocino Farms (7), Plant Power Fast Food (2), Urban Plates (3), Burger Lounge
(3), The Crack Shack (3 — and 3 happy hours, so clearly keep). These sell beer, several are
San Diego-founded, and none has a happy hour we can find. **I left every one of them in.** The rule
I applied: if it pours beer and was founded here, criterion 3 is live.

**10. Corporate coffee I blocked, for the record.** Blue Bottle, Philz, Black Rock, Dutch Bros and
Panera are blocked; Bird Rock, Lofty, Communal, Mostra, James, Parakeet and Dark Horse are not. The
line is national corporate ownership, not location count. **If the owner disagrees about any of them, Blue
Bottle and Philz are the two most arguable** — both are the kind of third-wave coffee bar that could
plausibly run an afternoon special, and both are wholly owned by a multinational.

**11. Fraternal and social clubs.** `association_or_organization` is 6 listings, 0 happy hours, and
it is not on the exclusion list because the type covers Elks lodges, VFW posts and yacht clubs —
which run the cheapest bars in the county and are locally run. **Question: are member-only bars
inventory or noise?** They fail criterion 1 for the public but pass 2 and 3 outright.

---

## 10. What would change my mind

- **If the extraction, not the category, is the binding constraint.** Coffee shops, Thai
  restaurants and boba shops all score ~0% and all have thin websites. If a better extraction
  source lifted those to 10%, the "low value but keep" bucket in §3 becomes genuinely valuable and
  the argument for spending on new *categories* weakens relative to spending on new *sources*.
- **If bowling alleys turn out to be already covered.** The 0-of-5,361 finding says the five types
  are the only door, but Google's tagging is generous and a bowling alley with a grill may well
  carry `restaurant`. A single free Text Search for bowling alleys in San Diego, compared against
  the enriched cache, settles this for $0 and should be run before spending $20 on a grid sweep.
- **If the owner wants a directory rather than a deal site.** Everything in §6 assumes a listing
  with no plausible deal is a cost. If the goal is coverage — every food and drink business in the
  county, claimable — then only the non-venues (§3, retail and services) should go, and the
  exclusion list shrinks to about a dozen types.
