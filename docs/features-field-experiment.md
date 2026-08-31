# Can `features` Be Read Off Venue Websites?

A one-off test, run on 31 August 2026, of the question the owner asked after reading
`docs/reducing-google-dependency.md` §3: *"Can we do a test run on deriving it from some sites,
maybe 30 or so, and see what we get, because we may just want to remove it if it doesn't pull
anything valuable?"*

Thirty venues were sampled from the catalog, their websites crawled with the importer's own deep
inventory, and features extracted with the same `claude-haiku-4-5` fallback the happy-hour cascade
uses. Every extracted feature was then checked by hand against the page it came from.

**The answer is no.** Extraction works — half the sample yielded at least one true feature, and
78% of what came back was correct — but what it yields is not worth a filter. The single feature
that appears often enough to filter on is "private events", which is a catering enquiry, not a
reason to pick a bar for happy hour. The patio, the one attribute the owner cares about and the
one the current field cannot produce, appeared on 3 of 30 venues. Recommendation is in §7:
**remove the field.**

Nothing here was wired into the pipeline. The scripts are in
`scripts/experiments/features-field/` and are marked exploratory in their own headers. The catalog
was not touched.

---

## 1. Sampling method

The pool is every catalog venue with an `http(s)` `website`, minus two exclusions: `maps.google.com`
(a Google listing URL, not a venue site) and the handful of Temecula / Murrieta / south Orange
County rows the search rectangle drags in, which are real chain websites but bad representatives of
a San Diego catalog. That leaves **2,801 venues out of 3,208**.

Selection is deterministic — a SHA-1 of the venue id gives each row a stable sort key, so re-running
`sample.mjs` on the same catalog draws the same thirty. No seed to remember, no draw to re-roll
until it looks good.

Thirty slots were allocated proportionally across four venue types derived from `vibe`, floored at
three so brewery is not represented by a single site. Within each type the first sweep takes one
venue per region before allowing a second, and no two venues may share a domain. Three guarantees
then run, each pinning what it admits so the next cannot evict it:

- **at least 4 chain-domain venues** (a domain appearing on three or more catalog rows), because a
  chain's location-picker site is a different extraction problem from an independent's,
- **at least 2 social-only websites** (an Instagram or Facebook page as the venue's `website`),
  which is the roughest input the crawler ever sees and is the venue's real listed site for 61 rows,
- **at least 8 venues with a published happy hour.** This is the one deliberate deviation from
  proportionality: 81% of the pool is claimable stubs, so a proportional draw would be almost
  entirely venues that are not on any browse surface. Since a `features` filter would live on those
  browse surfaces, the listed venues are over-weighted roughly 1.4×.

What came out:

| Axis | Composition |
|---|---|
| Type | 11 restaurant, 9 bar, 7 cafe, 3 brewery |
| Region | 7 coastal, 6 north county inland, 5 urban core, 5 other San Diego, 4 east county, 3 south bay |
| Ownership | 23 independent, 7 on a chain or multi-location domain |
| Listing | 8 with a published happy hour, 22 claimable stubs |
| Site shape | 2 social-only, 1 on a military base directory, the rest own domains |

The thirty are in the table in §5. The sample is honest about site quality in the direction that
matters: it contains a Facebook page with 641 characters of usable text, an Instagram page that
yielded 48,000 characters of navigation and nothing else, a 7-Eleven, and an Applebee's whose
location picker served pages for Anchorage, Alaska.

## 2. Crawl

`crawl.mjs` calls `inventoryWebsite()` from `lib/website-crawl.mjs` with the pipeline's own budget —
6 pages, 8 fetches, 150 ms between requests — through `createCachedFetch()` with the Playwright
fallback enabled, exactly as `refresh-happy-hour.mjs` does. Page text is frozen to
`.data/experiments/features-field/pages/`, so both extraction passes and every audit below read the
same bytes and nothing is re-fetched.

All 30 venues returned at least one readable page; 86 HTML pages, 20 PDFs or images and 39 social
snippets in total. Two of those crawls are worth naming now because they shape the results:

- **Players Sports Grill** returned five pages of a JavaScript location-picker shell. The words
  "Skip to main content" and "Toggle navigation" appear; nothing about the venue does.
- **Applebee's Oceanside** returned six pages describing the branch at 4331 Credit Union Drive,
  **Anchorage, Alaska** — TVs, sports atmosphere, happy hour and all. The chain location-picker
  resolved to the wrong branch and the crawler had no way to know.

## 3. Choosing a vocabulary

The brief was explicit that the vocabulary should come from evidence rather than from a guess, so
the model was run twice.

**Pass 1 (`extract-open.mjs`) gave it no candidate list at all** and asked what each venue advertises
about itself, in the venue's own words, with a quote for each claim. Thirty venues produced **124
attribute phrases, of which 112 were distinct and 106 appeared exactly once.** Seven venues produced
nothing. The model rated 13 sites "rich", 11 "thin" and 6 "unusable".

The phrases that recurred at all:

| Phrase | Venues |
|---|---|
| catering | 6 |
| happy hour | 4 |
| weekend brunch | 2 |
| private parties | 2 |
| live music | 2 |
| drive-thru | 2 |

Everything else — "turquoise walls", "mug club", "adobada off the trompo", "game hall", "speakeasies",
"free cover free games", "member-only parties" — appeared once. **That distribution is the finding,
before any measurement of accuracy.** What venue websites publish about themselves is mostly
logistics (catering, online ordering, gift cards) and mostly unique to the venue. The one attribute
appearing on a fifth of the sample is "catering", which nobody filters a happy-hour directory by.

Pass 1 did earn its keep in one way: it turned up two categories the owner's candidate list did not
have — **private events** (the venue-side of all that catering and party language) and **family
friendly** — and it confirmed that *rooftop*, *fire pit*, *dance floor* and *waterfront* were not
things these sites talk about. The closed vocabulary for pass 2 is the owner's candidate list plus
those two, fifteen values, each with a written definition in the prompt so the verdicts below have
something to be judged against:

`patio`, `rooftop`, `waterfront view`, `dog friendly`, `live music`, `sports tvs`, `games`,
`trivia or karaoke`, `dance floor`, `fire pit`, `late night`, `brunch`, `family friendly`,
`private events`, `parking`.

## 4. Extraction and how accuracy was measured

**Pass 2 (`extract-closed.mjs`)** ran one Haiku call per venue over the frozen pages, requiring a
verbatim quote and a source URL for every feature, and forbidding inference from venue type. It
returned **40 features across 19 venues**.

Accuracy was measured in two layers, because they answer different questions.

**Grounding (`check-quotes.mjs`, automated, all 40).** Every quote is looked back up in the frozen
text of the page it names. All 40 were found on the page they claimed, 38 verbatim and 2 as elided
quotes joined with "…". So the model did not fabricate a single quote — which is worth knowing, and
is *not* the same as being right.

**Verdicts (`verdicts.json`, by hand, all 40).** Forty is small enough to check completely rather
than sample, so each feature was judged against the frozen page text and, where the quote was
ambiguous, against the live site. Three verdicts: `true`, `false`, and `uncertain` for cases where
the site says something adjacent but a customer filtering on the feature could reasonably arrive and
be disappointed. Every judgement carries a written reason in `verdicts.json`.

## 5. Results

### Coverage

| | |
|---|---|
| Venues yielding at least one feature | **19 / 30 (63%)** |
| Venues yielding at least one *true* feature | **15 / 30 (50%)** |
| Features per venue | 1.33 |

### Accuracy

| Verdict | Features | Share |
|---|---|---|
| true | 31 | **78%** |
| false | 5 | 13% |
| uncertain | 4 | 10% |
| quote actually present on the cited page | 40 / 40 | 100% |

### Distribution

The column that decides the question. "True" is the count after the hand check.

| Feature | Extracted | True | Share of the 30 |
|---|---|---|---|
| private events | 12 | 11 | 37% |
| brunch | 5 | 5 | 17% |
| patio | 3 | 3 | 10% |
| trivia or karaoke | 4 | 3 | 10% |
| live music | 3 | 2 | 7% |
| late night | 5 | 2 | 7% |
| family friendly | 3 | 2 | 7% |
| games | 2 | 1 | 3% |
| waterfront view | 1 | 1 | 3% |
| parking | 1 | 1 | 3% |
| dog friendly | 1 | 0 | 0% |
| rooftop | 0 | 0 | 0% |
| sports tvs | 0 | 0 | 0% |
| dance floor | 0 | 0 | 0% |
| fire pit | 0 | 0 | 0% |

### Per venue

Verdicts in the order the features are listed.

| Venue | Type | Features found | Source page | Verdicts |
|---|---|---|---|---|
| Cocina Del Charro | restaurant | patio, brunch, family friendly, private events | cocinadelcharro.com, /locations | true, true, true, true |
| Tony's Jacal | restaurant | patio, private events | tonysjacalsd.com | true, true |
| Players Sports Grill | bar | — | — | nothing extracted |
| The Amigo Cantina | bar | private events | amigospotsandiego.com | true |
| Happy Does Bar | bar | games, trivia or karaoke, patio, late night, brunch, private events | happydoesbar.com | true, true, true, true, true, true |
| Kilowatt Brewing Kearny Mesa | brewery | late night | kilowatt.beer/happy-hour | **false** |
| Uvas Winery | bar | live music, private events | uvaswinery.net | *uncertain*, true |
| Hopnonymous Brewing — Normal Heights | brewery | trivia or karaoke, late night | hopnonymousbrewing.com/locations/adams-ave | true, **false** |
| Applebee's Grill + Bar | bar | — | — | nothing extracted |
| TJ Oyster Bar | restaurant | private events | tjoyster.com/location/4410-bonita-rd | **false** |
| Marechiaro's Italian Restaurant | restaurant | family friendly, private events | marechiarositalian.com | true, true |
| Chula Tacos | restaurant | late night | eatchulatacos.com | **false** |
| Big Kahuna's | restaurant | private events | bigkahunaca.com | true |
| Soda Bar | bar | live music | sodabarmusic.com | true |
| Superbloom Coffee & Juice | cafe | waterfront view, trivia or karaoke, games | missionbaybeachclub.com | true, *uncertain*, *uncertain* |
| The Cowshed | bar | — | — | nothing extracted |
| Larry's Beach Club | bar | — | — | nothing extracted |
| SPACEBAR Cafe & Wine Bistro | bar | brunch, private events | atspacebar.com | true, true |
| Kaffee Meister — Lakeside | cafe | — | — | nothing extracted |
| Casa Reveles Restaurant | restaurant | family friendly | casarevelesrestaurant.com | **false** |
| The Coffee Corner | cafe | — | — | nothing extracted |
| BOBER Tea & Coffee | cafe | — | — | nothing extracted |
| Fall Brewing Company | brewery | — | — | nothing extracted |
| 7-Eleven | cafe | — | — | nothing extracted |
| Cosmic Bloom Coffee | cafe | — | — | nothing extracted |
| Halo Halo Cafe | restaurant | — | — | nothing extracted |
| Carlotta Brunch | restaurant | brunch | carlottabrunch.com | true |
| Windmill Canyon Restaurant | restaurant | private events | pendleton.usmc-mccs.org/dining-entertainment/dining/restaurants | true |
| Gaslamp Lumpia Factory | restaurant | brunch, trivia or karaoke, live music, private events, parking, late night | gaslamplumpiafactory.com | true, true, true, true, true, true |
| Ryan Bros. Coffee | cafe | dog friendly, private events | ryanbroscoffee.com | *uncertain*, true |

## 6. What the errors look like

The failures are more informative than the successes, because they are not random noise — they fall
into four repeatable classes, and three of them would survive any amount of prompt tuning.

**Hours arithmetic, 3 of the 5 falses.** Kilowatt closes at 12am on Friday and Saturday, Chula Tacos
at 12am daily; both were called `late night`. Midnight is the boundary, not past it, and a venue that
shuts at midnight on its two latest nights is not what someone filtering for late night wants. The
Hopnonymous case is worse: the quoted "1:00 pm – 12:00 am" is an *events-calendar entry for the
happy hour*, read as closing time. This class is fixable — derive `late night` from the hours we
already store rather than asking a model to read a page — but that means it is not a website
extraction problem at all.

**Catering read as private events, 1 false and part of the noise elsewhere.** TJ Oyster Bar's only
event language is a "Catering" nav item; catering is something the venue brings to you, and it says
nothing about whether you can book the room. Marechiaro's got `private events` right, but from the
catering line rather than from the Banquets page that actually supports it. Since `private events` is
the highest-frequency feature in the whole experiment, the fact that its evidence is routinely the
wrong kind of evidence matters more than one wrong verdict.

**Marketing adjectives read as amenities, 1 false.** Casa Reveles says "We are a family restaurant
founded in 1995", which describes who owns it. There is no kids menu on the site. Cocina Del Charro
was scored `family friendly` from the equally weak phrase "family atmosphere" and happens to be
right, because a kids menu exists elsewhere on the site the model did not cite. One right answer
from bad evidence and one wrong answer from the same bad evidence is not a distinction the pipeline
could make at import time.

**Provenance, all 4 uncertains.** Superbloom Coffee & Juice is a counter inside Mission Bay Beach
Club and its listed website is the club's. The club's Wednesday trivia and its bocce court are real;
attributing them to the juice counter is a category error the model cannot detect, because from
inside the HTML they are the same venue. Ryan Bros. Coffee's `dog friendly` comes from a republished
Yelp review — a customer's observation, not the venue's policy, and the site itself never says it.
Uvas Winery's `live music` happens only at member-only parties every other month. Each of these is
defensible as a reading of the page and misleading as a filter.

**And the false negatives.** Of the 11 venues that yielded nothing, 9 are honest empties — grepping
the frozen text for every feature word in the vocabulary finds nothing, because a drive-thru coffee
bar's website really does only sell coffee. The other 2 are crawl failures, and they are the two
chain sites: Players Sports Grill, which is a sports bar with televised sport as its entire premise,
returned a location-picker shell, and Applebee's returned Anchorage. The extraction guardrails
behaved correctly in both cases — refusing to invent a feature from a shell, refusing to copy Alaska
onto Oceanside — but the outcome is that **the one obvious `sports tvs` venue in the sample scored
zero**, and `sports tvs` reads as a 0% feature when it is really a crawl-coverage problem.

## 7. Recommendation

**Remove the field.** Not because extraction cannot be made to work — it works about as well as this
kind of thing ever does — but because what it produces will not support the thing a feature field
exists to do.

The reasoning, in the order it actually matters:

**1. Nothing in the vocabulary clears the bar for a filter except the one value nobody wants to
filter by.** `private events` is on 37% of the sample and is the only value with double-digit
counts. It is a catering enquiry. Someone opens a happy-hour site to find a patio at 4pm on a
Thursday, not to book a rehearsal dinner. Strip it out and the best remaining value is `brunch` at
17% — also not a happy-hour attribute — and then `patio` and `trivia or karaoke` at 10%, or three
venues each. Scaled to the 557 published venues with a website, `patio` would land on roughly 56 of
them. A filter that returns 56 results out of 557 is defensible; a filter that *silently omits the
other patios* because their website never mentioned one is not, and there is no way to tell those
two populations apart from the outside.

**2. The one attribute worth having has a direct answer that costs $0.005 a venue.** `patio` is
Google's `outdoorSeating` boolean, and `dog friendly` is `allowsDogs`, both in the Atmosphere mask
that `docs/reducing-google-dependency.md` §4.3 already recommends buying once at +$29 for a full
run. This experiment found `patio` on 3 of 30 sites and `dog friendly` on 0 — the single instance
came from a customer review. Spending scraping time and model tokens to recover a worse version of
a field we can buy outright, once, for the price of a coffee, is the wrong trade in both directions.

**3. Half the catalog cannot answer the question at all.** 11 of 30 sites yielded nothing, and 9 of
those were genuinely silent rather than badly crawled. A field populated on half the rows and
unpopulated on the other half is not a filter, it is a hint — and it inherits the exact defect the
current field has, where an absent value cannot be distinguished from an unknown one. That is what
`casual`-on-99.5% already does, in the opposite direction.

**4. The errors are the kind that cost trust.** 13% of what was extracted was wrong and another 10%
was misleading, and the wrong answers are confident and specific: a venue labelled `late night` that
closes at midnight, a coffee counter labelled with the beach club's trivia night. `docs/venue-pipeline-reference.md`
§5.4 already takes the position that we would rather say `dealsUnknown` than print filler. The same
standard applied here says a `features` array assembled this way should not be published.

So: **delete `features` from the catalog and from the data contract**, and drop the `inferFeatures`
regexes in `normalize.mjs` with it. The `features` array is currently required non-empty by
`scripts/validate-data.js` §11.1, which is the only thing keeping `casual` on 3,193 rows.

Two things worth doing instead, both cheap and both already on the plan in
`docs/reducing-google-dependency.md` §6:

- **Buy `outdoorSeating` and `allowsDogs` once** on the capture run, and publish them as two named
  booleans rather than as members of a mushy `features` array. Two attributes that are either true
  or unknown are more honest and more filterable than a fifteen-value vocabulary that is mostly
  empty.
- **Ask for the rest in the claim form.** An owner ticking "patio" takes two seconds, is correct by
  construction, carries no caching restriction, and permanently removes that venue from any refresh
  budget. Every venue in this sample whose site was silent about its patio has an owner who knows
  the answer.

If someone later wants a *narrative* attribute — the `speakeasy`, `tiki`, `arcade bar` and
`chef-driven` values that a person hand-typed on 22 rows and that read like real editorial data —
pass 1 of this experiment is the shape of the tool for it. It surfaced "game hall", "karaoke room",
"mug club", "turquoise walls" and "speakeasies" from the venues' own copy. That is a different
field with a different purpose, it is one-per-venue rather than a filter facet, and it should not be
built by reviving this one.

## 8. Cost and runtime

**This run.** 60 Haiku calls over 30 venues, metered through `lib/ai-usage.mjs`:

| Pass | Calls | Input tok | Output tok | Cost |
|---|---|---|---|---|
| open vocabulary | 30 | 164,246 | 10,621 | $0.2174 |
| closed vocabulary | 30 | 170,396 | 4,890 | $0.1948 |
| **total** | **60** | **334,642** | **15,511** | **$0.41** |

That is $0.0137 per venue for both passes, or $0.0065 for the closed pass alone. Crawling took 251
seconds of wall clock at concurrency 4, against a partly warm page cache. No Google Places calls were
made; the sample and every attribute came out of the committed catalog and the local caches.

**A full run, had the answer been yes.** 2,801 catalog venues have a usable website. The closed pass
alone would cost **about $18**, or **$38** if the open pass ran too. Crawling is the real expense
and it is time, not money: roughly 33 seconds of work per venue, so **3–4 hours at concurrency 8**,
less in practice because most of these domains are already in `.data/cache/pages` from happy-hour
refresh runs. On the projected distribution that spend would yield a true `patio` on around 280
venues and a true `dog friendly` on approximately none — against $29 and one API run for a better
version of both.

## 9. Reproducing this

Scripts are in `scripts/experiments/features-field/`, outputs in
`.data/experiments/features-field/` (gitignored), and the hand-written verdicts are committed
alongside the scripts in `verdicts.json` so the accuracy numbers can be re-derived or argued with.

```
node scripts/experiments/features-field/sample.mjs           # deterministic, no network
node --env-file=.env scripts/experiments/features-field/crawl.mjs
node --env-file=.env scripts/experiments/features-field/extract-open.mjs
node --env-file=.env scripts/experiments/features-field/extract-closed.mjs
node scripts/experiments/features-field/check-quotes.mjs     # grounding, no network
node scripts/experiments/features-field/report.mjs           # every number above
```

`crawl.mjs` skips any venue already frozen under `pages/`, so re-running the extraction passes costs
model tokens and nothing else. None of these scripts writes to `public/data/happy-hours.json` or to
anything the pipeline reads.
