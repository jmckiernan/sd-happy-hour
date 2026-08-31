# What a visitor can actually find

83 published venues with real happy-hour schedules were unreachable through the
site's own navigation. Their pages rendered, their data validated, and nothing
linked to them. This records why, what the rule is now, and what is still
hidden.

## 1. Why the 83 were flagged

`seoHidden` is set at import whenever Google's happy-hour answer was below high
confidence, and until recently nothing ever took it off. A first pass cleared
100 of them by requiring a high-confidence scrape carrying **both a window and
deal lines**. These 83 failed that bar. Grouped by what they actually have:

| Cause | Count |
|---|---|
| Never scraped, no window provenance at all | 47 |
| Scrape found the window at medium or low confidence | 17 |
| Scrape found the window at high confidence, no offers with it | 8 |
| Scrape read the site and found no offers published (`not_published`) | 5 |
| The page we read describes another branch (`other_location`) | 4 |
| The listed website belongs to another brand (`wrong_website`) | 2 |

Only 8 were held back by the deals requirement alone. The larger fact is that
36 of the 83 have a window quoted off the venue's own happy-hour page, and 47
have no provenance for their window whatsoever.

## 2. The rule now

`isVerifiedForIndexing` asks one question: **have we confirmed this is a real
place with a real happy-hour window?** Three things have to hold, and deals are
deliberately not among them:

1. The window is complete — days, a start and an end.
2. The window has provenance: a quote read off the venue's own happy-hour page,
   or Google's `HAPPY_HOUR` secondary opening hours, which are times-only by
   construction and can never bring a quote with them.
3. Nothing since contradicts the attribution — the site we read was this
   venue's, describing this branch, and the listing is a venue rather than a
   building full of them.

Deals are content a confirmed venue may or may not publish. `docs/window-only-
listings.md` already decided that window-only listings stay published, because
knowing when happy hour runs is what most visitors came for, so requiring
offers here hid real venues for failing a test about something else.

`applyScrape` now applies this on every exit path, including the ones that
decided the scrape carried nothing worth storing — a scrape that finds no
offers still settles that the venue exists. A fresh import reaches the same
answer with no repair script afterwards.

**26 venues became visible.** 55 published venues remain `seoHidden`: 47 whose
window has no provenance at all, 6 whose pages describe another brand or
branch, and 2 whose scrape stored no times quote. Each is an unverified claim
rather than a hidden venue, and the honest fix for the 47 is the one
`docs/window-only-listings.md` §4 proposes — scrape them, or convert them to
claim stubs.

## 3. The buildings

Four published listings were not venues: Mission Valley (a shopping centre),
Liberty Public Market, Windmill Food Hall and Sky Deck at Del Mar Highlands
Town Center. Each publishes one happy-hour page covering a dozen businesses, so
every time and price on it belongs to a tenant we do not have a listing for —
Sky Deck's stored window quote names six restaurants by name.

They are now `unlisted`, not hidden. Two of them (Liberty Public Market and Sky
Deck) were never hidden at all and had been browsable the whole time. Hiding a
wrong record from search leaves it on a browsable page; `unlisted` is the state
the catalog already has for a row we keep only so an owner can find it.

## 4. What `seoHidden` should mean

The flag's stated purpose is SEO and its effect had become navigational, and
those are not the same thing. As it stands:

- The homepage grid — the surface with the search box and every filter, and so
  the one a visitor actually browses — selects on `listingStatus` alone and has
  always shown `seoHidden` venues.
- The homepage's ItemList structured data, the sitemap, the venue page's
  `noindex` and the **neighborhood pages** exclude them.

Three of those four are search-engine surfaces. The neighborhood pages are
navigation, and that is where the meaning slipped. The flag should mean "keep
this out of search indexes" and nothing else; the neighborhood pages should
either show these venues or the catalog should carry a separate, named reason
for holding a venue back from browse. Leaving one boolean to mean both is what
produced this bug, and it will produce it again.

## 5. How much of the catalog can a visitor find?

Of 3,006 records, 686 are published and **all 686 appear on the homepage**, are
findable by searching their own name, and survive every filter facet. The 2,320
unlisted records are claim stubs, by design.

Two caveats on "findable":

- The day filter opens on today's weekday rather than "All days", so a venue
  whose window excludes today is not in the default view until the visitor
  changes that filter.
- 140 published venues carry no `dealTypes`, so they match no option of the
  deal filter. They are reachable while it sits at "All deals", which is its
  default, but any deal-type selection excludes them.

`tests/homepage-reachability.test.mjs` asserts all of this against the live
dataset on every run.
