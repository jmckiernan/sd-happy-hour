# Venue Category Audit

Which *kinds* of place belong in this catalog, which do not, and which ones we have never looked
for. A proposal, not a change: nothing in the pipeline moves until the owner signs off on the
lists in §6 and §7.

Every count below was read out of `public/data/happy-hours.json` and `.data/import/google/` on
**31 August 2026**, not remembered. Pricing comes from `docs/places-api-cost-analysis.md`. Google's
type tables were checked against the [Place Types (New)](https://developers.google.com/maps/documentation/places/web-service/place-types)
    10|reference on the same date, because only Table A types can be used as `includedTypes` and half the
interesting categories needed verifying.

Headline: **the exclusion list saves about $40 on the full run and removes roughly 1,100 junk
listings; the addition list is where the money is, and it costs about $20 per type added.** The
exclusions are worth doing for catalog quality more than for the budget. The additions are worth
doing because we have never once searched for a bowling alley.

---

    20|## 0. The test being applied

The owner's criteria, quoted:

> The requirements to make it into the dataset should be:
> - They have some sort of special or happy hour.
> - They are the type of establishment that potentially could have a special or happy hour.
> - There is a possibility that the owner may claim the venue.
>
> It doesn't have to be all of those. It can be any one of those requirements.

    30|This is a logical OR, and it is deliberately generous. Two consequences run through the whole
document:

- **A low hit rate is not, by itself, grounds for exclusion.** A category where nobody has a
  happy hour today can still pass on criterion 2 or 3. Coffee shops score 1.9% and stay.
- **Brand and category are separate axes.** The owner's own example: Starbucks is out, local
  coffee shops are in. `chain-blocklist.mjs` is the brand axis and already works. This document is
  the category axis. A rule on one must not be argued from evidence about the other — the
  `fast_food_restaurant` numbers in §3 are mostly the blocklist's job, not a category verdict.

    40|The only categories that fail the OR test entirely are the ones where **no location of any brand
would ever run a special, and no owner would ever claim the page.** That is a much smaller list
than "categories with a bad hit rate", and §6 is deliberately short because of it.

---

## 1. Method, and what the numbers cannot tell you

The catalog was joined to `enriched.json` on `placeId` to attach Google's `primaryType` and `types`
to each listing.
    50|
| | Count |
|---|---|
| Catalog listings | 3,208 |
| — with a `placeId` | 2,792 |
| — joined to an enriched record | 2,787 (421 unmatched: legacy seeds and locator imports) |
| — `hasHappyHourData: true` | 557 |
| — with a schedule (`startTime` set) | 800 |
| — `listingStatus: published` | 690 |
| Enriched records (a Place Details call was bought for each) | 5,361 |
    60|| — `qualified` | 3,804 |

**"Hit rate" throughout means `hasHappyHourData` over catalog listings in that category.** The
557 figure, not the 800, because 800 counts listings that carry a window inherited from Google's
`regularSecondaryOpeningHours` without a confirmed deal behind it.

Three limits worth stating before the tables get used as evidence:

1. **The sample is closed under the current search.** Every one of the 5,361 enriched places was
   returned by a search for `restaurant`, `bar`, `cafe`, `night_club` or `brewery` — I checked, and
   **zero** enriched places lack all five of those in `types`. So the eight bowling alleys we have
    70|   are the eight that Google *also* tags as restaurants. A bowling alley with a bar and no
   restaurant tag is not in this dataset, cannot be counted, and is exactly the venue §7 is about.
   The addition-side numbers are therefore a **floor on what exists, not an estimate of it.**
2. **A zero can mean "no happy hour" or "we could not find it".** Thai restaurants are 0/36. Thai
   restaurants in San Diego do run specials; what they mostly do not have is a scrapeable website
   saying so. That is an extraction problem wearing a category costume, and it is not an argument
   for excluding Thai food.
3. **Truncation biases toward the famous.** Nearby Search caps at 20 by popularity, so within any
   category the venues we hold skew large and well-reviewed. Small, local, claimable places — the
   ones the business actually wants — are the ones being cut off.

    80|---

## 2. The catalog by primary type

Every `primaryType` with at least 10 listings. `n` is catalog listings, `HH` is
`hasHappyHourData`, `Details` is Place Details calls bought for that type across the whole
enriched cache including places that never reached the catalog.

| primaryType | n | HH | Hit rate | Details bought |
|---|---|---|---|---|
| *(unmatched — legacy seeds)* | 421 | 173 | 41.1% | — |
    90|| `coffee_shop` | 321 | 6 | 1.9% | 759 |
| `restaurant` | 305 | 76 | 24.9% | 540 |
| `mexican_restaurant` | 231 | 32 | 13.9% | 344 |
| `cafe` | 162 | 2 | 1.2% | 272 |
| `bar` | 141 | 27 | 19.1% | 335 |
| `brewery` | 116 | 11 | 9.5% | 170 |
| `american_restaurant` | 97 | 28 | 28.9% | 159 |
| `italian_restaurant` | 87 | 19 | 21.8% | 126 |
| `pizza_restaurant` | 80 | 15 | 18.8% | 134 |
| `bar_and_grill` | 61 | 20 | **32.8%** | 85 |
   100|| `breakfast_restaurant` | 59 | 0 | 0.0% | 73 |
| `seafood_restaurant` | 54 | 24 | **44.4%** | 92 |
| `mediterranean_restaurant` | 41 | 5 | 12.2% | 47 |
| `taco_restaurant` | 37 | 1 | 2.7% | 76 |
| `sushi_restaurant` | 37 | 8 | 21.6% | 54 |
| `thai_restaurant` | 36 | 0 | 0.0% | 42 |
| `chinese_restaurant` | 34 | 2 | 5.9% | 70 |
| `hamburger_restaurant` | 34 | 6 | 17.6% | 85 |
| `bakery` | 34 | 1 | 2.9% | 43 |
| `sports_bar` | 29 | 11 | **37.9%** | 47 |
   110|| `sandwich_shop` | 28 | 2 | 7.1% | 77 |
| `convenience_store` | 27 | 0 | **0.0%** | 233 |
| `barbecue_restaurant` | 26 | 8 | 30.8% | 39 |
| `japanese_restaurant` | 25 | 3 | 12.0% | 35 |
| `steak_house` | 25 | 8 | 32.0% | 37 |
| `winery` | 25 | 5 | 20.0% | 42 |
| `cocktail_bar` | 24 | 3 | 12.5% | 36 |
| `tea_house` | 24 | 0 | 0.0% | 27 |
| `donut_shop` | 23 | 0 | 0.0% | 30 |
| `vietnamese_restaurant` | 21 | 1 | 4.8% | 22 |
   120|| `grocery_store` | 21 | 0 | **0.0%** | 24 |
| `chicken_restaurant` | 19 | 3 | 15.8% | 46 |
| `deli` | 17 | 0 | 0.0% | 20 |
| `hawaiian_restaurant` | 16 | 1 | 6.3% | 20 |
| `brunch_restaurant` | 16 | 0 | 0.0% | 24 |
| `brewpub` | 15 | 6 | **40.0%** | 24 |
| `ice_cream_shop` | 15 | 0 | 0.0% | 19 |
| `indian_restaurant` | 14 | 3 | 21.4% | 19 |
| `fast_food_restaurant` | 14 | 0 | **0.0%** | 279 |
| `hotel` | 13 | 1 | 7.7% | 14 |
   130|| `bagel_shop` | 13 | 0 | 0.0% | 25 |
| `wine_bar` | 12 | 3 | 25.0% | 15 |
| `middle_eastern_restaurant` | 12 | 0 | 0.0% | 12 |
| `lounge_bar` | 11 | 1 | 9.1% | 40 |
| `ramen_restaurant` | 10 | 3 | 30.0% | 14 |
| `store` | 10 | 0 | 0.0% | 10 |
| `night_club` | 10 | 0 | 0.0% | 80 |

Read this alongside the `types`-membership view, which is more honest about what a venue *is*
because a place carries several types. Selected rows, catalog listings whose `types` array
contains the type:
   140|
| type (in `types`) | n | HH | Hit rate |
|---|---|---|---|
| `tex_mex_restaurant` | 14 | 13 | 92.9% |
| `oyster_bar_restaurant` | 14 | 8 | 57.1% |
| `gastropub` | 25 | 14 | 56.0% |
| `brewpub` | 51 | 26 | 51.0% |
| `pub` | 103 | 49 | 47.6% |
| `banquet_hall` | 19 | 9 | 47.4% |
| `bar_and_grill` | 178 | 83 | 46.6% |
   150|| `cocktail_bar` | 130 | 58 | 44.6% |
| `sports_bar` | 126 | 50 | 39.7% |
| `bar` | 811 | 289 | 35.6% |
| `seafood_restaurant` | 126 | 44 | 34.9% |
| `wine_bar` | 118 | 41 | 34.7% |
| `beer_garden` | 44 | 15 | 34.1% |
| `karaoke` | 19 | 6 | 31.6% |
| `live_music_venue` | 73 | 22 | 30.1% |
| `event_venue` | 190 | 55 | 28.9% |
| `video_arcade` | 21 | 6 | 28.6% |
   160|| `winery` | 30 | 7 | 23.3% |
| `restaurant` | 2,071 | 351 | 16.9% |
| `cafe` | 764 | 16 | 2.1% |
| `coffee_shop` | 575 | 11 | 1.9% |
| `fast_food_restaurant` | 104 | 2 | 1.9% |
| `bakery` | 173 | 1 | 0.6% |
| `tea_house` | 79 | 0 | 0.0% |
| `convenience_store` | 33 | 0 | 0.0% |
| `thai_restaurant` | 40 | 0 | 0.0% |
| `middle_eastern_restaurant` | 33 | 0 | 0.0% |
   170|
The shape of it: **anything with "bar" or "pub" in its type is a 35–57% hit; anything that is a
shop rather than a room you sit and drink in is under 3%.** That line — do people sit down and
order a drink here — predicts the hit rate better than cuisine, price or rating does.

Two rows deserve calling out because they are the interesting ones for the addition list:
`karaoke` at 31.6%, `live_music_venue` at 30.1%, `video_arcade` at 28.6% and `banquet_hall` at
47.4% are all **higher than plain `restaurant` at 16.9%**, and every one of them arrived here by
accident, as a side effect of a restaurant or bar search.

---
   180|
## 3. What is in the catalog that should not be

Named examples, so the judgement can be checked rather than trusted.

**Convenience stores — 27 listings, 0 happy hours, 233 Details calls.** Twenty of the 27 are
literally named `7-Eleven`; the rest are Circle K, ampm, ExtraMile and a food mart. A further 206 sit in the enriched cache without
reaching the catalog. This is the single clearest case in the dataset: a 7-Eleven does not run a
happy hour, cannot run one, and no franchisee is going to claim a page on a San Diego happy hour
site. It fails all three criteria. It also cost roughly **$4.70 in Details calls** to learn that,
   190|which is the cheap version of this mistake — the expensive version is the full-county run.

**Grocery stores and supermarkets — 26 listings, 0 happy hours.** Jimbo's (three locations),
North Park Produce, Balboa International Market, `Commissary Naval Base San Diego`. A commissary
on a naval base is not a venue. Note the near-miss: `market` in `types` scores 22.6% (7 of 31),
because a "market" in San Diego is often a bar with a deli counter. **Exclude `grocery_store` and
`supermarket`; keep `market`.**

**Fast food — 14 listings, 279 Details calls, 0 happy hours.** Chipotle ×4, Wienerschnitzel,
Rally's, Dairy Queen, Wetzel's Pretzels. The 265 enriched-but-not-catalogued are McDonald's,
Carl's Jr., Jack in the Box, Chick-fil-A. Most of those were stopped by the blocklist *after* the
   200|Details call, not before it — the blocklist runs on the candidate name at enrich, so the ones
that got through are brands not on the list. A category rule catches the long tail the brand list
never will.

**Retail and services that are not venues.** `store` (10 listings — vape shops, smoke shops,
`1835 Creative Studios`), `book_store` (7), `gift_shop`, `nail_salon`, `art_gallery`, `art_studio`,
`government_office`, `educational_institution`, `shipping_service`, `tour_agency`, `coworking_space`,
`indoor_playground`, `swimming_pool`. Individually tiny, collectively 30-odd Details calls and a
guaranteed zero. `Welldeck Recreation Center` on a naval base is in the catalog as a fast food
restaurant.

   210|**Delivery-only and catering.** `meal_delivery`, `meal_takeaway`, `catering_service`,
`food_court`, `pizza_delivery` — 40 Details calls, one happy hour between them, and that one is a
misclassification in our favour: `SD TapRoom` is a genuine taproom that Google typed
`pizza_delivery`. There is no room to sit in a ghost kitchen and no window to discount. Google
also exposes `pureServiceAreaBusiness` on Place Details, which flags a business with no storefront
directly; §8.5 of the cost analysis already recommends capturing it. That boolean is a better rule
than the type list.

**Lodging as a building.** `motel`, `rv_park`, `lodging` — zero yield. `hotel` is a different
question and is in §8, because the hotel *bar* is real.
   220|
### The categories I looked at and decided to keep

Stating these explicitly, because the hit rates make them look like exclusion candidates and they
are not:

| Category | Hit rate | Why it stays |
|---|---|---|
| `coffee_shop` / `cafe` | 1.9% / 1.2% | The owner named this as an expansion target. 321 catalog listings, almost all locally owned — `Por Vida`, `Communal Coffee`, `Lestat's on Park`, `Bird Rock Coffee Roasters`. Passes criteria 2 and 3 comfortably. The Starbucks problem is the blocklist's, and the blocklist already holds Starbucks, Dunkin', Peet's and Coffee Bean |
| `breakfast_restaurant` | 0/59 | Morning Glory, Breakfast Republic, Snooze. Zero happy hours is correct and beside the point — bottomless mimosas are a special, and these are exactly the kind of independent operator who claims a listing |
   230|| `thai_restaurant`, `middle_eastern_restaurant`, `korean_restaurant` | 0% | Extraction failure, not category failure. See §1 limit 2 |
| `tea_house` (boba) | 0/24 | Kung Fu Tea, Ding Tea, Bei Yuan. Boba shops run happy-hour pricing constantly; we have no source that publishes it. Local ownership is the norm. Criterion 3 alone carries this |
| `donut_shop`, `bakery`, `ice_cream_shop`, `juice_shop` | ~0% | Same reasoning. `Donut Bar`, `Nomad Donuts`, `Sidecar Doughnuts` are independents. Low value, but not *negative* value |
| `liquor_store` | 0/6 | Genuinely borderline — see §8. `Vino Carta Wine Shop and Bar` and `Holiday Wine Cellar` run tastings; `Country Wine & Spirits Gas Station` does not |

The distinction being drawn: a 7-Eleven is *pollution*, a quiet boba shop is *inventory*. Both
have a 0% hit rate. Only one of them fails the owner's test.

---

   240|## 4. What we have never looked for

`SEARCH_TYPES` in `lib/constants.mjs` is five types and has been since the pipeline was written:

```js
export const SEARCH_TYPES = ['restaurant', 'bar', 'cafe', 'night_club', 'brewery'];
```

Everything else in the catalog is there by accident — because Google also tagged it `restaurant`
or `bar`. The evidence for that is flat: **0 of 5,361 enriched places lack all five types.**

   250|All of the following are Table A types, verified against Google's reference, so every one can be
passed as an `includedType`. The county estimates are mine, from local knowledge and the shape of
the existing data; they are estimates and are labelled as such.

### Tier 1 — high yield, add these

| Type | In catalog today | Hit rate | Est. county population | Why |
|---|---|---|---|---|
| `sports_bar` | 126 | **39.7%** | 200–300 | Third-highest hit rate of any large category. A sports bar with no `bar` tag is invisible today |
| `pub` | 103 | **47.6%** | 120–180 | Nearly one in two has a happy hour |
   260|| `wine_bar` | 118 | **34.7%** | 100–150 | |
| `cocktail_bar` | 130 | **44.6%** | 150–250 | |
| `brewpub` | 51 | **51.0%** | 60–100 | Separate type from `brewery`, and the pub half is where the happy hour is |
| `gastropub` | 25 | **56.0%** | 40–70 | Highest hit rate of any category with n ≥ 20 |
| `beer_garden` | 44 | 34.1% | 30–50 | |
| `winery` | 30 | 23.3% | 100–140 | San Diego has a real wine industry — Ramona, Escondido, Julian. Tasting-room specials are standard. Note the county trap: half the wineries in the enriched cache are Temecula and get discarded by the county filter |
| `live_music_venue` | 73 | 30.1% | 60–100 | Beats plain `restaurant` |

These eight are not speculative expansion. They are categories we **already hold hundreds of
   270|listings in, at hit rates above the catalog average**, discovered accidentally. Searching them
directly mostly buys depth: the 20-result truncation cap means a `bar` search in the Gaslamp
returns the twenty most famous bars, and a `cocktail_bar` search returns twenty *more*.

### Tier 2 — the owner's non-food-and-drink expansion

| Type | In catalog | Hit rate | Est. county | Assessment |
|---|---|---|---|---|
| `bowling_alley` | 5 | 0% | 25–35 | The owner's example. Nearly every bowling alley in the county has a full bar and most run a weeknight special. The 0% is 5 venues that came in as restaurants, not evidence. **High confidence, low sample** |
| `comedy_club` | 3 | 33% | 8–15 | The owner's example. Two-drink minimums, pre-show specials, and the clubs are independently owned. `ENTONO Live Music & Comedy` is already in the enriched cache |
   280|| `karaoke` | 19 | **31.6%** | 30–50 | Better hit rate than `restaurant`, and it arrived by accident |
| `video_arcade` | 21 | **28.6%** | 20–35 | Barcades are a San Diego staple. `Brewski's Bar & Arcade` is in the cache already |
| `banquet_hall` | 19 | **47.4%** | 40–70 | Surprisingly strong. Caveat: many are attached to a restaurant that we already hold, so expect overlap |
| `event_venue` | 190 | 28.9% | 200–400 | Large and high-yield, but the messiest type on the list — it catches `Quartyard` and `The Collective`, and also wedding barns |
| `casino` | 3 | 0% | 10–15 | Tribal casinos: Sycuan, Barona, Viejas, Pala, Jamul, Harrah's. Each contains multiple bars and restaurants that absolutely run specials. See §8 — the question is whether we list the casino or its venues |
| `golf_course` | 10 | 10% | 80–100 | The clubhouse bar is the venue. `The Loma Club`, `Singing Hills at Sycuan`. Moderate confidence |
| `movie_theater` | 9 | 11% | 40–60 | Only the dine-in ones matter: `THE LOT`, `Cinépolis Luxury`, `Angelika`, `Rooftop Cinema Club`. Four brands, not a category — arguably better handled by a seed list than a type search |
   290|| `amusement_center` | 8 | 25% | 20–30 | K1 Speed, Boardwalk, Round1. Mixed: some have bars, Chuck E. Cheese does not |
| `miniature_golf_course` | 1 | — | 10–20 | Thin. Low priority |
| `concert_hall` / `performing_arts_theater` / `amphitheatre` | 7 | 0% | 20–30 | Venue bars exist but are event-gated, not a recurring happy hour. **Low priority** |
| `hookah_bar` | 14 | 0% | 15–25 | A bar in name. 0/14 is a real signal, not a small sample. **Do not add** |

Types I checked and am **not** proposing: `fitness_center`, `spa`, `marina`, `arena`, `stadium`,
`tourist_attraction`, `farm`. Either no drink service, or the drink service is a concession stand
with no owner to claim it.

---

   300|## 5. Cost impact

Per `docs/places-api-cost-analysis.md`: Nearby Search Enterprise **$35/1k**, Place Details
Enterprise **$20/1k** ($25/1k with Atmosphere), AI extraction **$0.012–$0.023 per venue**. The
expected full run is ~7,500 discovery calls and ~5,722 Details calls, about $322–346 all in.

### 5.1 What the exclusions save

Measured share of the existing spend, applied forward:

   310|| Bucket | Details bought | Share | Projected on 5,722 new Details | Saving @ $20/1k | AI extraction avoided |
|---|---|---|---|---|---|
| §6 exclusion list | 665 | 12.4% | ~710 calls | **$14** | ~$9–16 |
| §3 "keep but deprioritise" — not proposed | 355 | 6.6% | ~380 calls | $8 | $5–9 |

Of the 5,714 candidates in the cache, **720 (12.6%) carry an excluded primary type**. Of those,
127 reached the live catalog and exactly one has a happy hour — `SD TapRoom`, a taproom Google
mistyped as `pizza_delivery`, which the rule in §6 explicitly protects.

**Total saving: roughly $23–30 on the run, plus the crawl time and the human review of ~1,100
   320|listings nobody wants.** I am not going to inflate this. The dollar saving is small. The reason
to do it is that 27 7-Elevens are in the catalog right now and every one of them is a page a
visitor can land on.

### 5.2 What the additions cost

The fixed grid is 567 cells. One more type is one more call per cell:

> 567 cells × $0.035 = **$19.85 per added type**, before subdivision.

Rare types barely subdivide — the cost analysis measured `night_club` and `brewery` staying near
   330|600 calls total against `restaurant`'s 2,931 — so budget **$20–25 per type** for Tier 2 and
**$25–35** for the dense Tier 1 bar types, which will subdivide in the Gaslamp.

| Package | Types | Discovery cost | New Details (est.) | Details cost | Total |
|---|---|---|---|---|---|
| Tier 1 (8 bar-adjacent types) | 8 | $200–280 | 600–1,000 | $12–20 | **$212–300** |
| Tier 2 core (`bowling_alley`, `comedy_club`, `karaoke`, `video_arcade`, `banquet_hall`, `casino`, `golf_course`, `amusement_center`) | 8 | $160–200 | 250–450 | $5–9 | **$165–209** |
| Both | 16 | $360–480 | 850–1,450 | $17–29 | **$377–509** |

That is more than the entire current run budget, and it is the finding that matters most in this
document. **Adding types is expensive because discovery cost scales with the grid, not with how
   340|many venues the type actually has.** Searching all 567 cells for comedy clubs costs $20 to find
maybe twelve venues.

### 5.3 The cheaper way to buy the additions

Text Search Pro is **$32/1k with 5,000 free calls per month**, and `seed-from-locators.mjs`
already uses it at $0 because its volume sits inside the allowance. A rare type does not need a
567-cell sweep. `"bowling alley in San Diego County"` over 20–30 coarse regional anchors finds
essentially all of them, and 30 calls × 16 types = 480 calls — **free, inside the monthly Text
Search allowance.**

   350|This splits the addition list cleanly:

| Category shape | Mechanism | Cost |
|---|---|---|
| Dense, urban, truncation-limited (Tier 1 bar types) | Add to `SEARCH_TYPES`, full grid | $200–280 |
| Sparse, countable, geographically obvious (Tier 2) | Text Search sweep on regional anchors | ~$0 |

**Recommendation: add Tier 1 to `SEARCH_TYPES`; do Tier 2 as a Text Search seeder.** That gets the
owner's bowling alleys and comedy clubs for nothing and spends the real money only where the
20-result cap is genuinely hiding inventory.

   360|### 5.4 Net

| Line | Cost |
|---|---|
| Baseline full run (expected, capture-everything mask) | $346 |
| − §6 category exclusions | −$25 |
| + Tier 1 types in `SEARCH_TYPES` | +$240 |
| + Tier 2 via Text Search seeder | +$0 |
| **Proposed total** | **~$561** |

If $561 is over budget, the order to cut in is: Tier 2 seeder first (free), then exclusions
   370|(cheap, improves quality), then Tier 1 types one at a time by hit rate — `gastropub` (56%),
`brewpub` (51%), `pub` (48%), `cocktail_bar` (45%), `sports_bar` (40%), `wine_bar` (35%),
`beer_garden` (34%), `live_music_venue` (30%), `winery` (23%). Each is ~$25 and independent.

---

## 6. Proposed exclusion list

**Rule: exclude on `primaryType` only, never on `types` membership.** This is load-bearing.
`manufacturer` appears in the `types` of 204 catalog listings at an 18.1% hit rate, because
Google tags breweries as manufacturers. Excluding on `types` would delete a fifth of the breweries.
   380|As a `primaryType` it appears 5 times and yields nothing.

```
convenience_store    gas_station          grocery_store        supermarket
asian_grocery_store  food_store           department_store     shopping_mall
health_food_store    tea_store            store                wholesaler
fast_food_restaurant meal_delivery        meal_takeaway        catering_service
food_court           pizza_delivery       nail_salon           beauty_salon
gift_shop            book_store           art_gallery          art_studio
government_office    educational_institution                   non_profit_organization
community_center     shipping_service     coworking_space      tour_agency
supplier             manufacturer         indoor_playground    swimming_pool
   390|athletic_field       lodging              motel                rv_park
```

Deliberately **not** on the list, despite low or zero hit rates: `coffee_shop`, `cafe`, `bakery`,
`donut_shop`, `bagel_shop`, `tea_house`, `ice_cream_shop`, `juice_shop`, `dessert_shop`,
`breakfast_restaurant`, `deli`, `sandwich_shop`, `thai_restaurant`, `liquor_store`, `hotel`,
`market`. Reasons in §3 and §8.

**Escape hatch, required.** `SD TapRoom` proves Google's `primaryType` is sometimes just wrong.
Any type-level exclusion must be overridable by a name signal — if the name matches
`/\b(bar|pub|tavern|taproom|cantina|brewery|brewing|lounge|grill|kitchen|cocktail)\b/i`, keep the
   400|place regardless of type. That pattern already exists in `looksLikeShoppingMall()` in
`venue-quality.mjs` and should be lifted out and reused rather than written twice.

---

## 7. Proposed addition list

**To `SEARCH_TYPES` (Tier 1, ~$240):**

```
sports_bar  pub  wine_bar  cocktail_bar  brewpub  gastropub  beer_garden  winery
   410|live_music_venue
```

**To a new Text Search seeder (Tier 2, ~$0):**

```
bowling_alley  comedy_club  karaoke  video_arcade  banquet_hall  casino
golf_course    amusement_center
```

**Rejected:** `hookah_bar` (0/14 is real), `concert_hall`, `performing_arts_theater`,
   420|`amphitheatre`, `miniature_golf_course`, `fitness_center`, `spa`, `marina`, `tourist_attraction`,
`farm`. `movie_theater` is four brands, not a category — handle as a seed list.

---

## 8. Where the rules belong

Four possible gates, cheapest first.

| Gate | File | Prevents | Verdict |
|---|---|---|---|
   430|| Discovery | `discover.mjs` / `discover-adaptive.mjs` | The search call itself | **Cannot be used for exclusions.** `excludedPrimaryTypes` exists on Nearby Search, but the call is priced per request, not per result — excluding types does not make a `restaurant` search cheaper. It is only the mechanism for *additions* |
| Enrich prefilter | `enrich.mjs:63–72` | The $20/1k Details call | **Yes — this is where the exclusion list goes.** Discovery already returns `primaryType` in the mask (`venue-pipeline-reference.md` §1.4), so the type is known for free before any Details spend. This is exactly where `isCorporateFastFood` already sits |
| Stage | `build-staging.mjs:33` | Catalog pollution only | **Yes, as a second pass.** Money is already spent by here, but it catches places whose Details response reveals a type the candidate record did not, and it is where `pureServiceAreaBusiness` should be checked |
| Merge | `merge.mjs` | Nothing new | No |

### Recommended implementation

1. **New file `lib/category-rules.mjs`**, deliberately mirroring `chain-blocklist.mjs` — same
   shape, same commented reasoning, same "a category needs to fail all three criteria to be here"
   doc comment. Exports `EXCLUDED_PRIMARY_TYPES`, `isExcludedCategory(place)` and the venue-name
   escape hatch.
   440|2. **`enrich.mjs`**: one line in the existing prefilter chain, beside the fast-food check.
3. **`build-staging.mjs`**: the same predicate against the enriched record, plus a
   `pureServiceAreaBusiness` check once that field is in `DETAILS_MASK`.
4. **`constants.mjs`**: Tier 1 types appended to `SEARCH_TYPES`. Nine extra types multiplies the
   discovery call count, so this change should land with a `--max-calls` budget decided in advance.
5. **New `seed-rare-types.mjs`**, modelled on `seed-from-locators.mjs`, running Text Search over
   regional anchors for the Tier 2 types.
6. **`docs/venue-pipeline-reference.md` §2.1 and §9** updated, since it documents the prefilter
   chain and the blocklist and would otherwise go stale immediately.

   450|Nothing here touches `purge-chains.mjs` or the existing catalog. **The 127 already-catalogued
listings that the new rule would have blocked should be reviewed as a separate, explicit decision**
— that is a deletion from a git-tracked file and it is not this document's call to make.

---

## 9. Open questions for the owner

These are genuinely borderline. I have a recommendation on each, but none should be implemented
without a decision.

   460|**1. Hotels.** A hotel is a building, not a venue — but hotel bars run some of the best happy
hours in the county, and `The Pearl`, `TOWER23` and `La Valencia` are all in the catalog as
`hotel`, of which exactly one of 13 has a happy hour. Google exposes `subDestinations` and `containingPlaces`, which
§2.2 of the cost analysis already recommends capturing, and those would let us list *the bar* with
the hotel as its parent. **Recommendation: keep `hotel`, exclude `motel`/`lodging`/`rv_park`, and
revisit properly once `subDestinations` is in the mask.** Do not add `resort_hotel`.

**2. Casinos.** Sycuan, Barona, Viejas, Pala, Jamul. Each holds five to ten bars and restaurants
that do run specials, and the tribal operator is not going to claim a listing. So the venue we
want is inside the casino, not the casino. **Recommendation: add `casino` to the Tier 2 seeder to
   470|find the properties, then decide whether to list the property or manually seed its bars.** Ten to
fifteen venues is small enough to handle by hand.

**3. Restaurants inside malls, airports and stadiums.** `looksLikeShoppingMall()` already excludes
the mall itself but keeps a named restaurant inside it. Airport and stadium concessions are a
different animal — no local owner, no claim, prices set by a concessionaire. **Recommendation:
exclude anything whose address resolves to San Diego International or Petco Park. Needs a rule
written; not proposed here.**

**4. Liquor stores and wine shops.** `Vino Carta Wine Shop and Bar` pours by the glass and runs
happy hour. `Country Wine & Spirits Gas Station` does not. Both are `liquor_store`. **Recommendation:
   480|keep the category out of the exclusion list and let the name escape hatch in §6 sort it — "and Bar"
in the name is the signal.** Accept a handful of junk listings as the price.

**5. Breweries versus tasting rooms.** `brewery` is already searched and scores 9.5%, low for the
category — many are production facilities with a tasting counter and no website page. Adding
`brewpub` (51%) should help. **Question: is a production brewery with a tasting room a venue we
want?** I think yes, but the hit rate says the extraction will keep failing on them.

**6. The 127 existing listings.** Twenty-seven 7-Elevens, 21 grocery stores, 14 fast food outlets
and a naval commissary are live in the catalog right now. Removing them is a separate decision from
changing the filter. **Recommendation: purge, using a script modelled on `purge-chains.mjs`, after
   490|this document is approved.**

**7. Budget.** §5.4 lands at ~$561 against a $350 budget. Tier 1 is the whole overage. **Question
for the owner: raise the budget, or add Tier 1 types incrementally by hit rate across two calendar
months** — which also collects the free SKU allowance twice, worth about $55 (cost analysis §1.4).

---

## 10. What would change my mind

- **If the extraction, not the category, is the binding constraint.** Coffee shops, Thai
  restaurants and boba shops all score ~0% and all have thin websites. If a better extraction
   500|  source lifted those to 10%, the "low value but keep" bucket in §3 becomes genuinely valuable and
  the argument for spending on new *categories* weakens relative to spending on new *sources*.
- **If bowling alleys turn out to be already covered.** The 0-of-5,361 finding says the five types
  are the only door, but Google's tagging is generous and a bowling alley with a grill may well
  carry `restaurant`. A single free Text Search for bowling alleys in San Diego, compared against
  the enriched cache, settles this for $0 and should be run before spending $20 on a grid sweep.
- **If the owner wants a directory rather than a deal site.** Everything in §6 assumes a listing
  with no plausible deal is a cost. If the goal is coverage — every food and drink business in the
  county, claimable — then only the non-venues (§3, retail and services) should go, and the
  exclusion list shrinks to about a dozen types.
