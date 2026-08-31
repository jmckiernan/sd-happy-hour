# Does `vibe` Earn Its Place?

**Status, 31 August 2026 — closed, and implemented the same day. The recommendation in §6 was to
keep the field and re-derive it, which is a different answer from the one `features` got.** The
eight-label `inferVibe()` is gone; `vibe` now comes from
`scripts/import-google-venues/lib/venue-kind.mjs`, is absent on 1,972 of 3,006 catalog rows and 519
of 686 published ones, and is optional at every validator, form and surface. Every count below was
read out of `public/data/happy-hours.json` and `.data/import/google/*.json` on 31 August 2026. How
to tell this page has gone stale: `npm run rederive:venue-kind -- --dry-run` reprints the
distribution in §4, and the invariants in §7 are test functions you can grep for.

The question was the one `docs/features-field-experiment.md` asked about a different field: it looks
like the same shape, so does it survive the same scrutiny? It does not survive it unchanged. It
survives it better than `features` did, for a reason worth stating up front: **"what kind of place
is this" is a real question with a cheap, honest answer for about a quarter of the catalog, and the
field's problem was never the question — it was the answer being manufactured for the other three
quarters.**

---

## 1. The distribution

27 distinct values across all 3,006 rows, and the same 27 across the 686 published ones. Not one row
was missing the field, because `scripts/validate-data.js` required it.

Eight of the 27 are machine-derived and cover 2,987 rows. The other 19 are hand-typed, sit on venue
ids 2–21 — the original seed listings, before the Google import — and appear once each.

| Value | All rows | % all | Published | % published |
|---|---|---|---|---|
| Restaurant | 998 | 33.2% | 151 | 22.0% |
| Cocktail bar | 653 | 21.7% | 274 | 39.9% |
| Cafe | 640 | 21.3% | 17 | 2.5% |
| Brewery | 180 | 6.0% | 45 | 6.6% |
| Wine bar | 151 | 5.0% | 59 | 8.6% |
| Nightlife spot | 141 | 4.7% | 53 | 7.7% |
| Seafood spot | 132 | 4.4% | 53 | 7.7% |
| Pizza spot | 92 | 3.1% | 15 | 2.2% |
| 19 hand-typed values, one row each | 19 | 0.6% | 19 | 2.8% |

The hand-typed ones are the interesting rows and they are worth listing, because they are what the
field looks like when a person writes it: *Trendy gastropub, Speakeasy, Upscale casual, Rooftop
vibes, Modern Mexican, Tiki bar, Chef-driven, Upscale Mediterranean, Neighborhood gastropub, Craft
cocktails, Dog-friendly patio, Casual chicken joint, Waterfront Mexican, Arcade bar, All-day cafe,
Italian gastropub, Vegan metal bar, Beach brewery, rooftop.*

**This is not the `features` distribution.** `features` was one value on 99.5% of rows. `vibe` has
eight values with a real spread and a plausible-looking shape, and 33% on the fallback rather than
99.5%. On the numbers alone it looks like a field that works. That is exactly why it needed
measuring rather than counting.

## 2. Where it comes from

Entirely `inferVibe()` in `scripts/import-google-venues/lib/normalize.mjs`, which was eight lines:

```js
function inferVibe(primaryType, types = []) {
  const joined = [primaryType, ...types].join(' ').toLowerCase();
  if (/wine_bar|winery/.test(joined)) return 'Wine bar';
  if (/brewery|brewpub/.test(joined)) return 'Brewery';
  if (/night_club/.test(joined)) return 'Nightlife spot';
  if (/seafood|oyster/.test(joined)) return 'Seafood spot';
  if (/cocktail|bar/.test(joined)) return 'Cocktail bar';
  if (/cafe|coffee/.test(joined)) return 'Cafe';
  if (/pizza/.test(joined)) return 'Pizza spot';
  return 'Restaurant';
}
```

`docs/data-sourcing-plan.md` was right that this is entirely Google's taxonomy, and right that a
third of the catalog is on the fallback. There is no path by which a venue's own website, its deal
text, its menu or its owner contributes anything — except the claim form, which offers a free-text
"Vibe" box and which 19 seed listings and no imported venue has ever used.

Two properties of that function matter more than its inputs.

**It reads the whole `types` array, not the primary type.** This is the defect tonight's photo work
found from the other end: Google's `types` is a bag of everything a place might conceivably be, and
every 7-Eleven in the enrichment cache carries `restaurant`, `cafe`, `coffee_shop`,
`pizza_restaurant` and `liquor_store`. A field derived from that array inherits its unreliability
whole. Google's `primaryType`, by contrast, is a single label it commits to, and it is
`convenience_store` on all 155 of those same 7-Elevens.

**Both `bar` and `seafood` are unanchored.** `/cocktail|bar/` matches `barbecue_restaurant`, which is
how 24 barbecue joints and 8 Korean barbecue houses became cocktail bars.

## 3. Where it is used

Everywhere except the one place a taxonomy field usually lives.

| Surface | What it does with `vibe` |
|---|---|
| Venue page hero | Prints it verbatim as the subtitle under the venue name |
| Venue page hero image `alt` | "*Name*, a *vibe* in *neighborhood*" |
| Homepage cards | The `card-vibe` pill next to the trust badge |
| Homepage map popups | "*vibe* · Verified" |
| Search | In the haystack in `venueSearchText()` and in `alertMatchesVenue()` |
| Stock photography | The key into `vibeImages` for the card thumbnail and the hero banner |
| Claim form and submit form | A required free-text field |
| Validators | Required non-empty by `scripts/validate-data.js`, `validation.ts` and `venueContent.ts` |

**It is not a filter.** The homepage's five facets are day, neighborhood, deal type, status and
trust; there is no vibe facet and never has been. That makes this a different question from the
`features` one — nothing browses on it — and it makes the display surfaces decisive, because a label
that is only ever displayed is judged purely on whether it is true.

The stock-photo dependency turns out to be smaller than it looks. `vibeImages` has entries for the 19
hand-typed values plus `Wine bar` and `Seafood spot`, and a `default`. So `Restaurant`, `Cocktail
bar`, `Cafe`, `Brewery`, `Nightlife spot` and `Pizza spot` — 2,704 rows — already resolve to the same
default photo. The field is doing photo work on 302 rows out of 3,006, and `vibeImageFor()` already
falls back cleanly for anything it does not recognise, including nothing at all.

## 4. Is it true?

The test that decides this. For every catalog row with a cached Google record, compare the stored
`vibe` against the `primaryType` Google assigned that place. "Is the thing" means the primary type is
the label itself (`wine_bar` under `Wine bar`); "same family" is generous — anything bar-shaped
counts under `Cocktail bar`, anything cafe-shaped under `Cafe`.

| Value | Rows checked | primaryType is the thing | Same family |
|---|---|---|---|
| Cocktail bar | 506 | **17 (3%)** | 247 (49%) |
| Nightlife spot | 112 | **10 (9%)** | 67 (60%) |
| Wine bar | 128 | 37 (29%) | 37 (29%) |
| Seafood spot | 107 | 53 (50%) | 55 (51%) |
| Pizza spot | 83 | 58 (70%) | 58 (70%) |
| Cafe | 616 | 461 (75%) | 513 (83%) |
| Brewery | 158 | 128 (81%) | 129 (82%) |

Restricted to published venues, which is what a visitor actually reads, it is worse — because the
published set is the bar-heavy half of the catalog and `Cocktail bar` is where the errors are:

| Value | Published rows checked | primaryType is the thing |
|---|---|---|
| Cocktail bar | 155 | **2 (1%)** |
| Nightlife spot | 25 | **0 (0%)** |
| Wine bar | 39 | 6 (15%) |
| Brewery | 30 | 13 (43%) |
| Seafood spot | 29 | 19 (66%) |

The primary types sitting under published `Cocktail bar` are `restaurant` (43), `bar_and_grill` (18),
`bar` (13), `american_restaurant` (12), `mexican_restaurant` (10), `sports_bar` (8),
`barbecue_restaurant` (7). Under published `Wine bar`, the largest group is `italian_restaurant` (9),
against three actual wine bars. Under published `Nightlife spot`, no nightclubs at all.

So the site has been telling readers that Gen Korean BBQ House is a cocktail bar, that Fleming's
Prime Steakhouse is a wine bar, and that 274 of 686 published venues — 40% of everything on the
homepage — are cocktail bars. It said so in the card pill, in the page subtitle, in the image alt
text and in the meta description Google indexes.

**This is a worse failure than `features`, not a milder one.** `casual` on 99.5% of rows was
uninformative and a reader could see it was boilerplate. `Cocktail bar` is specific, singular and
confident, it varies from venue to venue, and it looks exactly like a fact somebody established. It
is §2.1 with the volume turned up: a default that will be believed, wearing the clothes of an
observation.

## 5. Could a good version be had?

This is the part that changes the answer, so it was tested rather than assumed. Three candidate
sources, in the order they cost anything.

**Google's `primaryType`, which we already own.** The 7-Eleven check above is the one that matters:
the array is contaminated and the primary type is not. Restricted to a vocabulary of things people
actually choose on — brewery, sports bar, rooftop bar, pub, wine bar, cocktail bar, nightclub, beer
garden, winery, gastropub, cafe, bar — it answers for 30% of rows with a cached record. It declines
to answer for every venue Google typed by cuisine, which is correct: `mexican_restaurant` says what a
place serves, not what kind of room it is.

**The venue's own name, which we already own.** Names are evidence the owner wrote. Every published
match of every candidate pattern was read by hand:

| Pattern | Published matches | Correct on inspection |
|---|---|---|
| brewing / brewery / brewhouse / taproom | 35 | 35 |
| pub / tavern / alehouse | 33 | ~30 (two are really sports bars, one is closed) |
| sports bar / sports grill | 9 | 9 |
| wine bar / winery / vineyard | 11 | 10 (Fleming's is a steakhouse with one) |
| rooftop | 5 | 5 |
| **lounge** | **19** | **rejected** |

`lounge` was in the candidate list and was dropped at this check. "Sushi Lounge Encinitas",
"Vincenzo Cucina and Lounge", "Firehouse American Eatery & Lounge" are restaurants, and "Press Box
Sports Lounge" is a sports bar. A word that decorates restaurant names is not evidence of a bar. That
one rejection is the reason the hand check was worth doing; the automated version of this exercise
would have shipped it.

**Deal text and menus, which we already store.** Nothing here. Across the 410 published venues with
any deal text at all, the whole corpus yields four mentions of trivia and three of tiki, and no
mention of rooftop, dive, patio or sports. Deal text describes what is discounted, which is the job
it already does for `dealTypes`. It does not describe the room.

**What was not tried, and why.** Crawling venue websites and extracting a kind with a model — the
`features` method. `docs/features-field-experiment.md` already ran the open-vocabulary version of
that pass over 30 venues, and its finding was that sites yield one-off narrative phrases ("game
hall", "mug club", "turquoise walls") that are unique per venue and unfilterable. That is a real
tool for a future editorial field and §7 of that document already says so. It is not the cheaper
answer to this question, and running it here would have cost $18 and four hours to arrive at a
messier version of something two local sources answer for free.

**Yield of the combined derivation**, name and primary type, absent where neither speaks:

| | Carrying a kind | Share |
|---|---|---|
| All 3,006 rows | 1,034 | 34.4% |
| 686 published rows | 167 | 24.3% |

Published, that is Brewery 37, Pub 27, Bar 21, Bar and grill 16, Sports bar 15, Wine bar 7, Cafe 7,
Rooftop bar 5, Winery 5, Cocktail bar 4, Gastropub 2, Tiki bar 2, Beer garden 1, plus the 19
hand-typed. 519 published venues carry nothing.

## 6. The decision

**Keep the field and re-derive it. Do not remove it.**

The `features` audit reached "remove" and this one does not, so the difference is worth being
explicit about.

**1. `features` was a filter facet; `vibe` is a sentence on a page.** A filter has to cover the
corpus to be usable — a `patio` facet that silently omits the patios nobody's website mentioned is
worse than no facet, which is the argument that killed `features`. A per-venue label has no such
requirement. 167 venue pages that say something true, and 519 that say nothing, is strictly better
than 686 that say something 3% accurate. There is no equivalent of the silent-omission problem
because nothing selects on it.

**2. The honest answer is cheap and already bought.** `features` needed a crawl and a model at $18
and four hours to produce something worse than a $29 API field. This needs one local file read.
Both sources are already on disk and neither costs a request.

**3. The current values are actively misleading in a way `casual` was not.** A reader who sees
`casual` on every venue learns nothing and knows it. A reader who sees `Cocktail bar` on a Korean
barbecue house has been told something false and has no way to tell. Of the two fields, this one was
doing more damage while looking healthier, and it was doing it on the hero of every published page
and in the meta description of every one of them.

**4. "What kind of place is this" is worth answering where it can be.** Brewery, sports bar, rooftop
bar, pub and wine bar are distinctions people pick a 4pm drink on. That the field could only answer
for a quarter of the catalog is a fact about San Diego's restaurants, not a reason to stop answering
for the quarter.

Where the derivation cannot answer, the key is absent — not `null`, not `""`, not a plausible guess.
`docs/lessons-and-invariants.md` §2.2 is the rule and this field is now built to it.

## 7. What was implemented

- **`scripts/import-google-venues/lib/venue-kind.mjs`** is new: a closed 16-value vocabulary, ordered
  most-specific-first, matched against Google's `primaryType` and the venue's name, returning
  `undefined` when neither speaks. `inferVibe()` is deleted; `normalize.mjs` spreads `{ vibe }` or
  `{}` so an unknown kind leaves no key behind.
- **`npm run rederive:venue-kind`** (`--dry-run` first) re-derives the catalog. It refuses to run
  without the Google caches, for the reason `rederive:deal-types` refuses without the enrichment
  cache: name matching alone would strip the kind off ~700 listings and report success. It reads the
  catalog immediately before writing it, so a concurrent job's edits are not reverted. It never
  overwrites a value outside the eight retired labels, which is what keeps the 19 hand-typed kinds
  and anything an owner has typed.
- **`vibe` is optional everywhere**: `Venue`, `VenueRecord`, `scripts/validate-data.js`,
  `validation.ts` and `venueContent.ts`. The validator now rejects an empty string instead of
  requiring a value, because `""` is a third state that renders as absence while asserting presence.
- **Every surface handles absence**: the card pill and map popup are omitted rather than blank, the
  hero subtitle is hidden and un-hidden by the client-side listing refresh, the hero `alt` falls back
  to "*Name* in *neighborhood*", and the search haystacks already filtered falsy entries.
- **Catalog re-derived**: 2,339 rows changed, 1,972 now carry no kind, 0 carry a retired label. Only
  the `vibe` key changed on any row; two other agents were writing to the same file and their edits
  were diffed by venue id and left alone.

Seven tests in `tests/venue-audit.test.mjs`:

| Invariant | Test |
|---|---|
| The blanket labels never come back | `testNoListingCarriesARetiredVibeLabel` |
| An unknown kind is absent, never an empty string | `testAVenueWithNoKnownKindCarriesNoVibeAtAll` |
| The kind is read off the primary type, not the `types` array | `testTheVenueKindIsReadFromThePrimaryTypeNotTheTypesArray` |
| Nothing outside the closed vocabulary is derived | `testTheVenueKindIsAlwaysOneOfTheKnownKinds` |
| A more specific kind outranks a vaguer one | `testTheMoreSpecificKindWins` |
| A word that decorates restaurant names is not a kind | `testAWordThatOnlyDecoratesARestaurantNameIsNotAKind` |
| Hand-written kinds survive a re-derivation | `testHandWrittenVenueKindsSurviveTheDerivation` |

## 8. What is still open

- **The claim form still offers a free-text box.** It is the best source there is — an owner knows
  whether their room is a dive bar — and it is now optional rather than required, which is the fix
  that mattered. Turning it into a picker seeded with the vocabulary, with "something else" as an
  escape hatch, would make owner answers countable. Nothing depends on it yet.
- **`Bar` and `Bar and grill` are thin.** They are true, and they are Google's committed answer for
  37 published venues, but "Bar" as a subtitle tells a reader little. They stay because a true thin
  answer beats a false specific one; if a better source arrives they are the first to go.
- **`vibeImages` still keys off the string.** Twenty entries, of which `Wine bar` now matches 19 rows
  rather than 151 — which is a strict improvement, since the wine-bar photograph is no longer being
  shown to Italian restaurants — and the rest match the seed listings. Nothing in the new vocabulary
  has a photo, so `Brewery`, `Sports bar` and the rest fall to the default, exactly as they did
  before. Worth revisiting only if stock photography is worth revisiting at all.
- **Nothing asserts the re-derivation has been run** after a name is edited or a cache is refreshed.
  This is the same gap `docs/lessons-and-invariants.md` §4 already records against
  `rederive:deal-types`, and it now applies to two fields rather than one.
