# Lessons and invariants

What went wrong in this catalog, the pattern behind each one, the rule that replaced it, and whether
anything enforces that rule today. This is the durable half of a night's work whose specifics will
stop mattering; the patterns are what recur.

**Status: current. Every count below was read out of `public/data/happy-hours.json` at commit
`d4b9b17` on 31 August 2026, and every test named was confirmed to exist and to run inside
`npm test`.** How to check that this page has not rotted: the counts in §2 are reproducible with
`npm run audit:deals-menus`, `npm run audit:empty-listings` and `npm test`, and every invariant in
§3 names a test function you can grep for. If a test named here does not exist, this page is stale
and the test is the authority, not the prose.

This page does not repeat the pipeline specification (`docs/venue-pipeline-reference.md`) or the
individual audits. It is the layer above them: the reasoning you would want before writing the
equivalent code for a second city. §5 is the index of the detailed documents and their status.

---

## 1. The through-line

Nearly every data defect found on 30–31 August 2026 was a variant of one thing: **the data
confidently asserted something nobody had checked, and no surface could tell an assertion from an
observation.**

None of them was a crash and few were visible as a bug on a page. They were confident,
plausible, well-formed values that had never been read off anything — a venue attribute derived from
Google's type taxonomy, a deal category derived from the same, a caption derived from a URL, a
neighborhood derived from a street name. Each passed validation, because validation was checking
shape rather than provenance.

That is the failure mode to design against in a new city. It does not announce itself, it survives
every schema check, and it is discovered by a person browsing the site and finding one page wrong.

---

## 2. The patterns

### 2.1 A default is an assertion, and it will be believed

A field that must always have a value gets a filler value, the filler outnumbers the real data, and
every consumer reads it as a finding.

- **`features` was `casual` on 3,193 of 3,208 rows** (99.5%), and `['casual']` and nothing else on
  2,942 of them (91.7%). `inferFeatures()` matched Google's place types and seeded `casual`
  unconditionally; `scripts/validate-data.js` required the array to be non-empty, which is the only
  reason the filler existed. `patio` appeared on 5 rows and a dog-friendly value on 2, both typed by
  a person. The field is gone in full — see §2.2.
- **`vibe` was `Restaurant` on 998 of 3,006 rows and `Cocktail bar` on 653**, of which 17 were
  cocktail bars when measured against Google's own `primaryType`. It looked healthier than
  `features` — eight values, a real-looking spread — and it was worse, because the wrong answers
  were specific and printed on every published page. Re-derived from the primary type and the
  venue's own name; absent on 1,972 rows rather than guessed (`docs/vibe-field-audit.md`).
- **`dealTypes` claimed `food` on 767 of 800 scheduled venues**, and `['food']` alone on 525. Deal
  text and Google's `types` array went into one lowercased blob with a `food` default, and Google
  tags essentially every eating establishment with the literal type `food` (4,876 of 5,361 places in
  the enrich cache). After re-derivation from deal text alone, **357 venues with a window and no
  deal text of any kind were still asserting `food`**; 162 of those carried `['food']` and nothing
  else. Removing the default emptied `dealTypes` on 207 listings, 204 of which had been claiming a
  food discount off a page that says nothing about food.
- **Every gallery caption was the string literal `'Happy hour menu'`**, from a constant with no
  content check behind it anywhere in the pipeline. Selection read the URL and the `alt` attribute;
  the media sniffer read twelve bytes to answer "is this an image", never "is this a menu". Of the
  329 image records, 324 were boards we typeset ourselves, where the caption is a fact. **Of the 5
  genuinely scraped from a venue, 5 were not menus** — a photograph of a hand-painted sign, two
  promotional graphics, and two live-music calendars from 2025.
- **`venueDealLines()` fell back to the string `"Happy hour"`** whenever a listing had no offer text,
  so 290 published pages rendered a chip reading "Happy hour" under a heading reading **Deals**, and
  it reached the meta description. This is the same "a label is not an offer" bug that
  `NOT_AN_OFFER` had already been written to catch in the extractor, surviving in the renderer.

**The rule.** A derived field must be derivable from something the venue itself published. Where it
is not, the honest value is empty, and the validator has to permit empty — `validate-data.js` now
exempts `dealTypes` wherever `dealsUnknown` is true, for the same reason it already exempted
`deals`. A required-non-empty rule on a field nobody can source does not produce data; it produces
filler with a schema.

The generalisation worth carrying: **`dealTypes` was the worse offender than `deals` would have
been**, because it drives a filter. Invented deal text is at least visible on the page where a reader
can disbelieve it. An invented deal type is a false positive for everyone who filters on it and is
visible to nobody.

Enforced by `testVenuesWithNoDealTextClaimNoFoodDiscount`,
`testCatalogDealTypesAreEmptyOnlyWhereTheOffersAreUnknown`,
`testNoListingCarriesTheRemovedFeaturesField`,
`testNoListingCarriesARetiredVibeLabel`,
`testAVenueWithNoKnownKindCarriesNoVibeAtAll`,
`testTheVenueKindIsReadFromThePrimaryTypeNotTheTypesArray`,
`testNoGalleryPhotoClaimsToBeTheMenuOfAVenueWithNoStoredMenu`, `testNoScrapedImageClaimsToBeOurBoard`,
`testAWindowOnlyVenuePageOffersNoChipsToShow`, `testEveryWindowOnlyListingSaysItsOffersAreUnknown` and
`testTheHonestEmptyStateNamesNoOfferAndNoPrice`, all in `tests/venue-audit.test.mjs`.

### 2.2 Absence has to be sayable, which usually means three states

The defect underneath §2.1 is that a two-state field cannot distinguish "we asked and the answer is
no" from "nobody has ever asked". A `false` printed for silence is a fabricated observation.

`features` could never say it. Its replacement can: `outdoorSeating` and `allowsDogs`, and the wider
amenity set merged alongside them, keep **true, false and absent distinct**, including inside the
grouped objects where a missing sub-key is unknown rather than no. Google answered `allowsDogs` for
1,041 of 3,006 rows — 603 yes, 438 no — so a default of `false` would have invented a dog ban for the
1,965 venues nobody has asked about. Surfaces show a fact only when it is true, and a venue with
nothing known renders no section at all rather than a grid of greyed-out maybes.

`dealsUnknown` is the same idea one layer up: it is not "no happy hour", it is "we know the window
and not the offers", and it exists so that an empty `deals` array is a statement rather than a gap.

Enforced by `testAmenitiesAreBooleanOrAbsentButNeverGuessed`,
`testGroupedAmenitiesAreNeverPublishedEmpty`, `testAmenitiesAreWrittenOnlyWhenGoogleAnswered` and
`testFieldsGoogleNeverAnswersAreNotPublished`.

### 2.3 A boolean records a decision and discards the reason for it

`seoHidden` was set at import whenever Google's happy-hour answer was below high confidence, and
until 31 August nothing ever took it off. Earlier that same day a clear-on-scrape path landed
(`8279315`) that required a high-confidence `found` scrape **with deal lines**, and a bulk reindex
cleared **100 published venues**. The remaining cohort stayed hidden because the rule asked about
offers, not existence — and early exit paths from `applyScrape` never reconciled at all. Later the
same day (`8f0faea`) the deals requirement was dropped, reconcile was wired to every exit, and 26
more became visible. The flag was then split (`d4b9b17`): `seoHidden` is search only; browse uses
`browseHold` with a named reason and a `since` date. 55 published venues still carry
`browseHold: unverified_window`.

Two separate fixes came out of that, and the second is the transferable one.

- **Lifting has to be part of the same code path as setting.** `applyScrape` now applies the
  confirmation rule on every exit path, including the ones that decided a scrape carried nothing
  worth storing — a scrape that finds no offers still settles that the venue exists. A fresh import
  reaches the correct answer with no repair script afterwards, and
  `npm run import:venues:reindex-verified` exists only for listings scraped before the rule.
- **The flag was also carrying two unrelated facts.** "Do not spend crawl budget here" and "we
  cannot source this venue's window" want different handling and different copy, and one boolean
  holding both is what left published venues off their own neighborhood pages. `seoHidden` is now
  search and nothing else; browse visibility is `browseHold`, a structured value carrying a `reason`
  from a known vocabulary and a `since` date. `npm run validate:data` rejects a reason the codebase
  does not know how to handle, because a hold nobody can act on hides a venue and explains nothing.

**The rule.** If a flag can be wrong later, it carries why it was set and what would clear it, and
the clearing runs where the setting runs. A dated, named hold makes a stale one visible; a bare
boolean makes staleness undetectable, which is the same defect as §2.6 in a different field.

Enforced by `testTheTwoHedgesAreReadByTheSurfacesTheyBelongTo` and
`testAConfirmedVenueIsNeverKeptOutOfTheIndexOrItsNeighborhoodPage`
(`tests/homepage-reachability.test.mjs`), and `testOnlyANamedHoldKeepsAVenueOffItsNeighborhoodPage`,
`testAVerifiedHappyHourStopsBeingHiddenFromTheNeighborhoodPage` and
`testAnUnprovenHappyHourStaysHidden` (`tests/neighborhood-assign.test.mjs`).

### 2.4 A fallback heuristic that runs before authoritative data will quietly win

This one bit three times tonight in three unrelated subsystems, which is why it is the pattern most
worth internalising.

- **Neighborhood assignment matched street names before cities and ZIPs.** The address regexes exist
  as a last resort for addresses with no parseable city or ZIP, and they were running third of five.
  So "Scripps Poway Parkway" filed a Scripps Ranch venue under Poway, twenty miles inland; El Cajon
  Boulevard put North Park and College Area venues in El Cajon; Linda Vista Road put them in Vista;
  and Avenida Del Mar sent five San Clemente restaurants to the Del Mar page. A separate city now
  outranks the street, a San Diego ZIP decides within the city, and a street name is consulted only
  when neither could be parsed. **124 venues were reclassified.** An unrecognised ZIP now stays a
  vague `San Diego` rather than a confident wrong city.
- **Google's place `types` outranked the venue's own deal text** inside one lowercased blob (§2.1).
  The cheap signal was not merely present, it was indistinguishable from the authoritative one. The
  fix was to separate them and give them an explicit precedence: the booleans say what a venue
  *pours*, the deal text says what it *discounts*, and the text wins; the booleans may only fill a
  silence.
- **URL ranking was treated as evidence that an image was a menu.** A scrape that could not
  transcribe a menu published the images it had ranked as the menu anyway. Ranking is a guess about
  where to look, not a finding about what was found. A transcription is now the only thing that
  labels an image a menu.

**The rule.** Order the sources explicitly, cheapest-last where the cheap one is a guess, and make
the fallback's output distinguishable from the authoritative one rather than merging them into a
single value. Where the fallback is all that is left, prefer a vaguer answer to a confident wrong
one. The same shape appears benignly elsewhere in the pipeline and is worth copying: the deep
inventory crawl consults guessed conventional paths **only** when nothing discovered scored ≥ 20.

Enforced by `testAStreetNameNeverOutranksTheCityItSitsIn`,
`testAStreetNameNeverOutranksASanDiegoZip`,
`testAnUnrecognisedSanDiegoZipStaysVagueRatherThanGuessing`,
`testEveryCatalogedVenueAgreesWithTheAssignmentRule` and
`testNoVenueSitsAbsurdlyFarFromTheNeighborhoodItIsFiledUnder`
(`tests/neighborhood-assign.test.mjs`), and `testGuessedPathsYieldToDiscoveredOnes` and
`testHomepageOutranksGuessedPaths` (`tests/venue-audit.test.mjs`).

### 2.5 A display constraint that reaches storage destroys data

A limit that describes what fits on a screen is not a fact about the venue, and persisting it is a
one-way loss.

- **A menu board fits four sections and 24 items per section, and the trimmed menu was written
  back.** Amigo Cantina permanently lost five items and an entire tequila flight section that way.
  Boards now paginate, so length is no longer a reason to discard anything a venue published, and
  the caps are raised to 12 sections as a guard against a model returning a dinner menu rather than
  as a layout limit. Page breaks are decided by measuring a candidate page's rendered height against
  a 1,500px bound at the board's 1,080px width, not by counting items. One catalog menu now runs to
  five sections, which is the proof the cap is no longer being applied to storage.
- **The deal refresh kept eight chips while the layout renders six.** A refresh that genuinely found
  more offers than before pushed two of them somewhere no reader would ever see. Every path now uses
  `MAX_DEAL_CHIPS`.
- **`allDay: true` was stored as `00:00–23:59`**, which is a rendering of "all day" as a calendar
  day rather than a description of the venue's service day. The open-now check believed it, so a
  brewery advertising "all day Monday" reported happy hour as live at 3am. All-day is now a
  presentational fact and the window carries the real bounds of the service day, evaluated like any
  other window; the special case is gone from the library so every consumer agrees automatically.
  18 listings reported overnight happy hour before this, 0 after, across all 31 all-day listings.
- **Cropping was removed from menu images entirely**, because whatever the frame trims off a menu is
  an item nobody reading it will know existed. Framing moved to the featured photo, where it is
  stored as a focal point and a scale applied at render — the file is never re-cropped, so the choice
  stays re-editable.
- **Framing is keyed by frame name — `hero`, `card`, `tile` — not by aspect ratio.** A ratio key
  looks more general but is a CSS measurement wearing a data hat: restyling a card from 200px to
  240px tall would silently re-key every crop and orphan what admins had set, with no way to tell an
  orphan from a deliberate blank.

**The rule.** Storage holds what the venue published. Presentation may cap, paginate, truncate or
crop at render time, and must not write the result back. Where a cap does belong in storage it is a
sanity bound against a bad extraction, sized well clear of anything real, and it says so.

Enforced by `testMenuPaginationNeverDropsContent`, `testBoardPagesFormACompleteSequence`,
`testDealChipsCapAtSix`, `testNoCatalogListingStoresAnUnboundedAllDayWindow`,
`testAnAllDayWindowIsNotLiveInTheSmallHours` and
`testTheOpenNowCheckReadsTheSanDiegoWeekdayNotTheUtcOne` (`tests/venue-audit.test.mjs`).

### 2.6 Round-tripping a record must not lose its provenance

**269 of 313 stored menus had no record of where they came from.** The natural reading is that nobody
recorded it. The truth is that it was recorded and then thrown away: normalizing a menu for board
layout rebuilt it from `note` and `sections` alone, dropping `sourceUrl`, `observedAt` and the
scraped original on **every** re-render. A field can be written correctly at import and still be
empty on 86% of rows.

The consequence is not cosmetic. Without provenance there is no way to tell how old a menu is or
whether the price on the page is still the price on the wall, so **staleness becomes undetectable**
— and staleness is the one thing a directory of afternoon prices cannot afford. It also cannot be
backfilled from nothing.

Two related habits came out of the same night. Every recovered offer stores its source URL, the date
and the quoted line, so a chip can be re-checked against the sentence it came from without
re-crawling. And a board is written to its own `-hh-menu-board` filename slot rather than the
`-hh-menu` name a scraped flyer takes, because rendering our drawing of a menu over the flyer it was
transcribed from destroys the only evidence the transcription can be checked against.

Enforced by `testMenuNormalizationKeepsProvenance` and `testEveryStoredMenuHasARenderedBoard`
(`tests/venue-audit.test.mjs`).

### 2.7 "The record exists, is correct, and nothing links to it"

**83 published venues with real happy-hour schedules were unreachable through the site's own
navigation.** Their pages rendered, their data validated, `npm run validate:data` passed, and no test
failed. There was no trace of the problem anywhere except a person browsing a neighborhood page and
noticing a venue missing.

This is a whole failure class, not one bug, and it is invisible to every check that reasons about a
record in isolation. Reachability is a property of the record *plus* every surface that selects on
it, so the only way to catch it is to assert it directly: take the published set, run it through the
real selection code for each surface, and require that nothing falls out.

That is what `tests/homepage-reachability.test.mjs` now does against the live dataset on every run —
every published venue appears on the homepage, is findable by searching its own name, and survives
every filter facet. It also pins which fields are allowed to gate which surface, so the homepage
grid cannot start reading a hedge that belongs to search.

Two honest caveats it records rather than fixes: the day filter opens on today's weekday rather than
"All days", and 140 published venues carry no `dealTypes` and so match no option of the deal filter
once a visitor selects one. Both are reachable at the defaults, and both are stated on the page
rather than left for someone to rediscover.

Enforced by `testEveryPublishedVenueIsOnTheHomepage`,
`testEveryPublishedVenueCanBeFoundBySearchingItsOwnName`,
`testEveryPublishedVenueSurvivesEveryFilterFacet`,
`testVenuesWithNoDealTypesAreReachableThroughTheDealFilter` and
`testABuildingFullOfTenantsIsNotAPublishedVenue`, plus
`testEveryVisibleVenueHasANeighborhoodPageToAppearOn` in `tests/neighborhood-assign.test.mjs`.

A neighbouring instance of the same class, found the same night: the sitemap filter selected on
`listingStatus` and not on `seoHidden`, so a page rendering `noindex` was simultaneously advertised
in the sitemap. Four surfaces read the flag and one of them had been missed.

### 2.8 A derived value goes stale unless something re-derives it

`dealTypes` is derived from deal text, and deal text is cleaned, compressed and refreshed after
import by three separate scripts, none of which recomputed the derived field. **Roughly 210 venues
advertised beer on their own page and could not be found by filtering for beer.** The value was
correct when written and wrong by the time anyone read it.

The structural version of the same problem is the flat day and time fields, which are a mirror of
`windows` derived from the primary window only: **121 listings have a day in `windows` that is
missing from flat `days`**, always in that direction. A shared `happyHourDayNames` helper makes it
harmless for rendering, which is a patch rather than a fix — deriving the flat fields from `windows`
at build time would remove the divergence at source.

And the same lesson in a place where the derivation is a filter rather than a field: the import
filters run at **staging** time and freeze into `staging.json`, so fixing a filter does nothing for a
staging file built before the fix. That is how 99 venues went live with "Happy hour" as their only
deal *after* the filter rejecting it had been written. Merge now refuses to run if any file that
shaped the staging output has changed since it was built.

**The rule.** Either derive at read time, or own a re-derivation command and run it after anything
that touches an input. `npm run rederive:deal-types` is that command, `--dry-run` first.

Enforced for the days case by `testHighlightedDaysCoverEveryWindowNotJustThePrimaryOne` and
`testCatalogHighlightedDaysNeverOmitAScheduledDay`. The staleness guard on merge has no test; it is a
mtime comparison against a hardcoded file list, and adding a file to the pipeline without adding it
to that list is an unguarded mistake.

### 2.9 An invariant that is not in `npm test` guards nothing

The catalog-wide checks — no listing claiming an all-day happy hour round the clock, no menu section
without items under it, no deal chip that is really an extractor annotation — were written and then
sat in a suite nothing invoked. Wiring it into `npm test` broke the whole suite everywhere without
outbound network access, because one check fetched a live venue's sitemap. It was removed again, then
the crawling check was split into `npm run test:venue-crawl:live` and the 119 offline checks were
wired back in.

That is three commits to arrive at an obvious place, and the lesson is the middle step: **a suite
that mixes offline invariants with live network checks will eventually be disabled, and it takes the
invariants with it.** Keep them in separate scripts from the start. Everything cited in §3 runs
inside `npm test` today; that was true of none of it two days ago.

### 2.10 Silent success is worse than a loud failure

Four unrelated instances, all found tonight:

- **`rederive-deal-types.mjs` read a missing enrichment cache as "Google said nothing"**, which would
  have stripped the drink types off 154 listings whose only source is that cache, and reported
  success. It now refuses to run without the cache.
- **Venue id allocation now throws rather than allocating past the end of its band.** A run that
  stops with an error is recoverable; a quiet id collision between two cities is discovered when the
  catalogs meet, by which point repair means renumbering venues and rewriting every foreign key, and
  a single miss hands an ownership claim to the wrong venue.
- **GitHub answers `200` with an empty body for a file over 1 MB**, which is documented behaviour
  rather than an error. `JSON.parse('')` then threw a `SyntaxError` carrying no HTTP status, so every
  admin venue page failed with "Unexpected end of JSON input" and the failure slipped straight
  through the status classification added for credential errors. Absent, empty and unparseable are
  now three different answers, and the read falls back to the Blobs API.
- **An admin list's keyset cursor round-tripped `created_at` through a JavaScript `Date`**, which
  keeps milliseconds, while the query compared the microsecond value Postgres stores. Load More
  either re-served rows or returned nothing while still advertising more results. A malformed cursor
  now returns 400 rather than silently restarting at page one, because that looked identical to
  pagination that never advances.

Enforced for the id case by `testAllocationPastTheEndOfTheBandFailsLoudly`,
`testAnotherCitysIdsNeverMoveThisCitysCursor` and `testEveryCatalogedVenueSitsInsideSanDiegosBand`
(`tests/venue-id-bands.test.mjs`).

### 2.11 An extractor quotes accurately and understands nothing

Worth stating separately because it governs how much of this can ever be automated. Re-reading 234
venue websites for missing offers produced priced lines on 22 listings, **of which 12 survived a
hand check.** The rejected ones were quoted perfectly off the venue's own site: a $20 corkage fee, a
$2 dessert fee, a $15 valet charge, "add steak $15", three regular entrées and a $45 wine-club
membership. Six of those shapes are filters with unit tests now; the rest were rejected by reading
the page.

The same pattern in the features experiment: all 40 extracted quotes were found verbatim on the page
they cited, and 13% of the conclusions drawn from them were still wrong. **Grounding is not
correctness.** A model that never fabricates a quote will still label a venue that closes at midnight
`late night`, and attribute a beach club's trivia night to the juice counter inside it.

So the shape that works is to separate the crawl from the write: propose cheaply and in bulk, accept
by hand, and store the quote so the acceptance can be re-checked later without re-crawling. Four
recoveries were declined where a plausible chip was there for the taking and would have been a guess.

Enforced by `testARecoveredOfferHasToQuoteAPrice` and `testApplyScrapeRequiresEvidence`.

### 2.12 A document's status line is part of its contract

`docs/venue-category-audit.md` carried the status "accepted in principle, deliberately parked" long
after its recommendations had been implemented, enforced at four gates and applied to the catalog.
Nobody could tell the real state without reading the code, and the cost was an agent re-litigating
settled decisions.

Its header now states the two halves separately — exclusions implemented and executed, additions
designed and parked on budget — with the count each claim was measured against and the date.

The same rot was found tonight in `docs/venue-pipeline-reference.md` §5.8, which said the Atmosphere
capture run "has never been run, so every catalog row is currently unknown and no surface displays
these yet". By then the backfill had run over 2,787 place ids, `outdoorSeating` was present on 1,983
catalog rows, and the venue page was displaying amenities. It has been corrected. A reference
document is the most dangerous place for this, because it is the one people quote instead of
re-measuring.

**The convention this page follows, and asks of the others.** A document states its status in its own
header, in the specific rather than the general; names the date and the artifact its counts were read
from; and says how a reader could tell it had gone stale — a command to re-run, or a test to grep for.
"Living document" is not a status. §5 indexes these documents and deliberately does not restate their
statuses, because a central status table is one more thing to rot.

---

## 3. The invariants, and what enforces them

Every test below runs inside `npm test`. The suites are `tests/venue-audit.test.mjs` (offline catalog
invariants), `tests/homepage-reachability.test.mjs`, `tests/neighborhood-assign.test.mjs`,
`tests/venue-blocklist.test.mjs` and `tests/venue-id-bands.test.mjs`.

| Invariant | Test |
|---|---|
| No published venue is missing from the homepage, name search, or any filter facet | `testEveryPublishedVenueIsOnTheHomepage`, `testEveryPublishedVenueCanBeFoundBySearchingItsOwnName`, `testEveryPublishedVenueSurvivesEveryFilterFacet` |
| A venue with no `dealTypes` is still reachable through the deal filter | `testVenuesWithNoDealTypesAreReachableThroughTheDealFilter` |
| Search and browse hedges are read only by the surfaces they belong to | `testTheTwoHedgesAreReadByTheSurfacesTheyBelongTo` |
| A confirmed venue is never held out of the index or its neighborhood page | `testAConfirmedVenueIsNeverKeptOutOfTheIndexOrItsNeighborhoodPage`, `testAVerifiedHappyHourStopsBeingHiddenFromTheNeighborhoodPage` |
| Only a named, dated hold keeps a venue off its neighborhood page | `testOnlyANamedHoldKeepsAVenueOffItsNeighborhoodPage` |
| Every visible venue has a neighborhood page to appear on | `testEveryVisibleVenueHasANeighborhoodPageToAppearOn` |
| A street name never outranks the city or ZIP it sits in | `testAStreetNameNeverOutranksTheCityItSitsIn`, `testAStreetNameNeverOutranksASanDiegoZip` |
| An unrecognised ZIP stays vague rather than guessing | `testAnUnrecognisedSanDiegoZipStaysVagueRatherThanGuessing` |
| Every catalog venue agrees with the assignment rule and sits near its neighborhood | `testEveryCatalogedVenueAgreesWithTheAssignmentRule`, `testNoVenueSitsAbsurdlyFarFromTheNeighborhoodItIsFiledUnder` |
| No venue with a window and no deal text claims a food discount | `testVenuesWithNoDealTextClaimNoFoodDiscount`, `testCatalogDealTypesAreEmptyOnlyWhereTheOffersAreUnknown` |
| The removed `features` field never comes back | `testNoListingCarriesTheRemovedFeaturesField` |
| The retired vibe labels never come back, and an unknown kind is absent rather than empty | `testNoListingCarriesARetiredVibeLabel`, `testAVenueWithNoKnownKindCarriesNoVibeAtAll` |
| A venue's kind is read off the primary type and the name, never the `types` array | `testTheVenueKindIsReadFromThePrimaryTypeNotTheTypesArray`, `testTheVenueKindIsAlwaysOneOfTheKnownKinds`, `testTheMoreSpecificKindWins`, `testAWordThatOnlyDecoratesARestaurantNameIsNotAKind`, `testHandWrittenVenueKindsSurviveTheDerivation` |
| Amenities are true, false or absent, never guessed or published empty | `testAmenitiesAreBooleanOrAbsentButNeverGuessed`, `testGroupedAmenitiesAreNeverPublishedEmpty`, `testAmenitiesAreWrittenOnlyWhenGoogleAnswered`, `testFieldsGoogleNeverAnswersAreNotPublished` |
| No image claims to be a menu without a transcription behind it | `testNoGalleryPhotoClaimsToBeTheMenuOfAVenueWithNoStoredMenu`, `testNoScrapedImageClaimsToBeOurBoard` |
| Menu normalization keeps provenance, and every stored menu has a board | `testMenuNormalizationKeepsProvenance`, `testEveryStoredMenuHasARenderedBoard` |
| Pagination never drops menu content, and board pages form a complete sequence | `testMenuPaginationNeverDropsContent`, `testBoardPagesFormACompleteSequence` |
| No menu section is stored with zero items under it | `testEveryStoredMenuSectionHasItemsUnderIt` |
| No deal chip is an extractor annotation, and chips cap at six | `testNoDealChipIsAnExtractorPlaceholder`, `testDealChipsCapAtSix` |
| No stored all-day window is unbounded, and none is live in the small hours | `testNoCatalogListingStoresAnUnboundedAllDayWindow`, `testAnAllDayWindowIsNotLiveInTheSmallHours` |
| Open-now reads the San Diego weekday, not the UTC one | `testTheOpenNowCheckReadsTheSanDiegoWeekdayNotTheUtcOne` |
| Highlighted days never omit a day a listing is scheduled on | `testHighlightedDaysCoverEveryWindowNotJustThePrimaryOne`, `testCatalogHighlightedDaysNeverOmitAScheduledDay` |
| A window-only page shows an admission, not a chip, and names no price | `testAWindowOnlyVenuePageOffersNoChipsToShow`, `testTheHonestEmptyStateNamesNoOfferAndNoPrice`, `testEveryWindowOnlyListingSaysItsOffersAreUnknown` |
| A recovered offer has to quote a price; a scrape has to carry evidence | `testARecoveredOfferHasToQuoteAPrice`, `testApplyScrapeRequiresEvidence` |
| Menu text reaches the search haystack | `testMenuTextIsSearchable` |
| A building full of tenants is not a published venue | `testABuildingFullOfTenantsIsNotAPublishedVenue`, `testApplyScrapeClearsFoodHallTenantDeals` |
| No published listing with a happy hour would be purged by the brand or category rules | `testNoPublishedListingWithAHappyHourWouldBePurged` |
| Local markets, private clubs and mistyped local places survive the category rules | `testLocalMarketsWithARealCounterSurviveTheGroceryRule`, `testPrivateClubsAreNotTreatedAsMembersOnly`, `testGoogleMistypingALocalPlaceDoesNotDeleteIt`, `testTheRuleNeverExcludesATypeBreweriesCarry` |
| Id allocation stays inside the city's band and fails loudly at its end | `testEveryCatalogedVenueSitsInsideSanDiegosBand`, `testAllocationPastTheEndOfTheBandFailsLoudly`, `testAnotherCitysIdsNeverMoveThisCitysCursor` |
| County comes from Google's data, not the bounds rectangle | `testCountyComesFromGoogleNotTheBoundsRectangle` |

---

## 4. Lessons with no test yet

This is a to-do list, not a summary. Each is a rule someone could break tomorrow with nothing
failing.

- **The merge staleness guard is an unguarded list.** It compares mtimes against a hardcoded set of
  seven files. Adding a new filter to the staging path without adding it to that list restores the
  exact bug the guard exists to prevent, and no test notices.
- **Nothing asserts that a re-derivation has been run after its inputs changed.** `rederive:deal-types`
  and `rederive:venue-kind` are commands someone has to remember. A check that recomputes either for
  a sample and compares against the stored value would turn §2.8 into an invariant.
- **The wider amenity fields are unvalidated.** `scripts/validate-data.js` type-checks
  `outdoorSeating` and `allowsDogs` only. The eleven other Google-sourced amenity fields now on the
  catalog — `reservable`, `liveMusic`, `restroom`, `goodForGroups`, `goodForWatchingSports`,
  `servesVegetarianFood`, `parkingOptions`, `paymentOptions`, `accessibilityOptions`, `priceLevel`,
  `priceRange` — pass through unchecked.
- **The menu `price` / `offer` model is in place** (`docs/menu-price-model.md`). Absolute vs
  discount kinds are classified from the printed text; the board typesets discounts differently;
  schema.org only emits absolute prices. What remains unenforced is provenance-on-every-menu and
  the 115 unparseable price strings left for a human.
- **Provenance is required by convention, not by the validator.** New scrapes write `sourceUrl` and
  `observedAt`; nothing rejects an `hhMenu` that lacks both. 269 rows would fail such a rule today,
  so it has to be introduced as "no *new* menu without provenance" rather than a flat invariant.
- **32 windows stored as `19:00–18:00` and similar are left alone deliberately.** `12:00–08:00` is
  genuinely ambiguous between a transposition and a real overnight window, and guessing publishes
  wrong hours. All but two are unlisted. This is a known-bad set with no owner.
- **`endTime: "23:59"` and `endTime: "00:00"` are two encodings of the same intent** differing by a
  minute. An explicit `endsAtClose` flag, mirroring the existing `startsAtOpen`, would retire the
  sentinel.
- **Neighborhood boxes still overlap around Carlsbad and Encinitas**, which is the Cardiff bug not
  yet triggered. The assignment tests catch a venue filed absurdly far from its neighborhood; they do
  not catch a box quietly swallowing its neighbour.
- **Nothing checks that a document's status line is true.** §2.12 is a convention with no enforcement
  and no obvious way to build one.

---

## 5. Where the detail lives

Each of these states its own status in its own header, which is where the authority sits. This table
says what a document is for, not whether it is current.

| Document | What it holds |
|---|---|
| `docs/venue-pipeline-reference.md` | The specification: every gate, threshold and constant in pipeline order, with the incident behind each |
| `docs/venue-data-pipeline.md` | The operational playbook: how to run a job, what an outcome means |
| `docs/porting-to-a-new-city.md` | What is about restaurants and what is about San Diego; the new-city checklist. §8 is append-only |
| `docs/deal-and-menu-audit.md` | The measured state of deals, times and menus, and which problems needed a decision |
| `docs/window-only-listings.md` | Why 290 listings were a window and nothing else, what was recovered, and the publish-versus-stub question |
| `docs/homepage-reachability.md` | The unreachable-venue investigation and the `seoHidden` / `browseHold` split |
| `docs/venue-category-audit.md` | Which kinds of place belong in the catalog; the brand and category axes |
| `docs/features-field-experiment.md` | Closed evidence for deleting `features`. Kept for the method, not as a live proposal |
| `docs/vibe-field-audit.md` | Closed evidence for keeping `vibe` and re-deriving it. Same method as the features experiment, opposite answer |
| `docs/places-api-cost-analysis.md` | Field tiers, caching terms, and the derivation of the budget |
| `docs/reducing-google-dependency.md` | The Google pricing questions and the Atmosphere decision. Its plan, alternatives and refresh sections are superseded |
| `docs/data-sourcing-plan.md` | Where every field comes from, what each source costs, and how often each is re-checked |
| `docs/data-architecture.md` | Where the venue catalog should live |
| `docs/infrastructure-scalability.md` | What breaks first across the whole stack, in order |

For a second city, the entries that matter most are `porting-to-a-new-city.md` for the mechanics and
this page for the reasoning. §2.1 through §2.7 are the defects a fresh pipeline will reproduce
exactly, because nothing about any of them is about San Diego.
