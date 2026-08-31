# Deal, time and menu quality audit

**Status, 31 August 2026 — the mechanical fixes are applied and the invariants in §9 are
enforced. The items marked "Owner" in §6 and §7 are still open decisions.** Two things dated
after this audit and supersede parts of it: the 290 window-only listings in §8 are now the subject
of `docs/window-only-listings.md`, which is the current account of that cohort, and the menu
provenance gap in §7 was traced to normalization discarding it on re-render rather than to nobody
recording it. Re-run `npm run audit:deals-menus` to check any number here.

Audited against `public/data/happy-hours.json` on 2026-08-31: 3,006 listings, 690
published, 800 carrying a happy-hour window. Counts below are after the fixes in
this pass; where a number changed, both are given. The patterns behind these
defects, and which of them a test now guards, are in `docs/lessons-and-invariants.md`.

Two scripts reproduce everything here:

```
npm run audit:deals-menus        # deals and menus, safe fixes separated from judgment calls
npm run fix:all-day-windows      # all-day windows that do not describe a service day
```

The audit started from a bug the owner found on one venue page and the venue
turned out to be a worked example of four separate problems, each of which had
siblings across the catalog. That is the organising idea: nothing below is
specific to San Diego Brewing Company, it is just where each one was first seen.

## 1. The empty menu section, and menus as images

**Root cause.** The venue publishes its happy-hour menu as an image. The
extractor read the page's text, which held the section headings and none of the
items, and stored its own annotation `Beverages [no items listed]` as the
venue's only deal. That string then reached the page title, the meta
description and the `makesOffer` structured data. The renderer was never
involved.

The deeper problem was that a structured menu representation already existed —
`hhMenu.sections[].items[].price` — but nothing rendered it as text. It was only
ever typeset into a PNG and pushed back into the gallery, so both the scraped
path and our own path ended as images, and this venue had neither.

| Problem | Before | After |
|---|---|---|
| Deal chips that are an extractor annotation | 1 | 0 |
| Listings whose menu is rendered from stored text | 0 | 313 |
| Listings with a menu image and no menu text | 19 | 17 (see §3) |
| Listings with menu content but no deals | 4 | 3 |
| Deals but no window | 0 | 0 |

**Fixed.** Menus render as HTML from `hhMenu`. The scraped flyer moved to
`hhMenu.sourceImages` as provenance — it is the evidence the prices were read
off and the only way to re-check a transcription, but it is not presentation, so
it cannot be mistaken for the menu again. Menu text now reaches the consumer
search haystack and the venue JSON-LD as a `hasMenu` tree with prices. Two
filters learned the shapes that caused this: `Beverages` and the other section
titles a menu-as-an-image leaves behind, and bracketed extractor annotations.

## 2. The mislabelled image, and the true caption rate

Every gallery caption was the string literal `'Happy hour menu'` in
`lib/menu-flyers.mjs`, with **no content check anywhere in the pipeline**.
Selection reads the URL and the `alt` attribute; `sniffMediaFromBytes` reads
twelve bytes to answer "is this an image", never "is this a menu". So a
photograph of brewery tanks was captioned as the menu because it sat on the
happy-hour page.

The rate is much better than the raw 334 suggests, because most of those images
are ours:

| Of 329 image records | Count | Could it be mislabelled? |
|---|---|---|
| Boards we typeset ourselves from `hhMenu` | 324 | No — the caption is a fact, not a guess |
| Genuinely scraped from the venue | 5 | Yes |

Of the scraped images, **all 5 were in fact not menus** and are now captioned
for what they are:

- **The Tower Bar (453)** — a photograph of a hand-painted sign reading "HAPPY
  HOUR 4-7 DAILY". Names no item and no price. It got in because the filename is
  `happyhourbear.jpg`.
- **Barn Door Public House (585)**, two images — promotional graphics, "Thursday
  $5 Pints 'til 6" and the Friday equivalent. Real offers, not menus.
- **Encinitas Ranch Golf Course (515)**, two images — live-music calendars from
  2025 and last spring. Stale as well as mislabelled.

So the honest statement of the rate: **of the images a user could have been
shown as a menu that we did not draw ourselves, 5 of 5 were not menus.** The
mechanism guaranteed it — ranking a URL was the only test.

**Fixed.** A transcription is now the only thing that labels an image a menu.
Images we read a menu off become `hhMenu.sourceImages`; images we did not are
held as `menuCandidateImages`, captioned unconfirmed, and shown nowhere.

**Also found: 13 orphaned boards.** Images we rendered ourselves whose
`generated` flag was lost and whose `hhMenu` had since been deleted — nine
Chili's locations plus South of Nick's, Oggi's Vista, Native Oaks and Same Same.
Consequences: `menus:render` skips them forever, so they can never be
re-rendered; `menu-coverage.mjs` reported them as scraped flyers; and the images
are stale and unfixable in place. They are identifiable with certainty because
their `sourceUrl` is the HTML page the menu was read from rather than a media
file, which only our own renderer produces. Their flag is restored. One further
case appeared during cleanup: Kindred (19) now has a board and no `hhMenu`,
because its menu was two storefront error messages and was removed.

## 3. The 19 listings with an image and no menu text

These were the listings that could not comply with always rendering our own
menu. Reconciled:

| | Count |
|---|---|
| Orphaned boards — our render, `hhMenu` deleted | 13 |
| Scraped images that were not menus (§2) | 3 venues, 5 images |
| Scraped images that were real menus | 3 |

**Transcribed (3).** Amigo Cantina (395) — a fully legible two-page menu, 22
items across food, cocktails, beer, wine and tequila flights. Tour de Tapas
(595) — one relative offer, "15% off bottles and glasses of wine, beer and
sangria", recorded exactly as the flyer states it. Maya's Cookies (500) — "$2
chocolate chip cookies", which also recovered a listing marked
`dealsUnknown: true` while its own flyer stated a price.

**Resisted transcription, and why (3).** The Tower Bar, Barn Door and Encinitas
Ranch have no menu to transcribe: a sign, two promo graphics and two event
calendars. None names a priced item, so no price was invented for any of them.
The 13 orphaned boards were deliberately not re-transcribed from their own PNGs:
nine are Chili's locations that the chain purge is removing anyway, and reading
prices back off an image we rendered from data we have since deleted would
launder a guess into the catalog. They need a re-scrape.

## 4. Times, and the 3am false positive

**Format validity is genuinely clean**: zero invalid `HH:MM` strings and zero
malformed day arrays across every flat field and every window. All the remaining
problems are semantic.

At 03:13 America/Los_Angeles on Monday, evaluated through the real
`sanDiegoTime.ts`:

| Cause | Before | After | Published now |
|---|---|---|---|
| `allDay` window stored as the calendar day or an implausible start | 18 | **0** | 0 |
| Window stored with start and end apparently swapped | 9 | 9 | 0 |
| Window genuinely published as starting before dawn | 2 | 2 | 1 |
| **Total** | **29** | **11** | **1** |

**Root cause.** `allDay: true` meant "the whole calendar day", stored as
`00:00–23:59`. That is not what any venue means by an all-day happy hour. All-day
is now a presentational fact — the page says "All day" — and the window must
carry the real bounds of the venue's service day, evaluated like any other
window. The special case is gone from the library, so every consumer agrees
automatically.

**All-day reconciliation.** 31 listings have an all-day window. 16 stored the
calendar day and were bounded first; 2 more stored a deliberate-looking but
implausible start (Hooleys at 4am, The Lobby Tiki Bar at 3am) and were caught by
tightening the rule, keeping their credible 9pm closes; the remaining 13 were
already bounded correctly. **All 31 now describe a service day and none reports
happy hour overnight.** Only one venue in the catalog publishes its own hours, so
30 of the 31 use a conservative 11am–10pm default; Brewing Company's default
lands on exactly the 11am–10pm its own page quotes.

**Overnight windows crossing midnight**: 50 exist and roughly 18 are legitimate
late-night service (`21:00–00:00`, `22:30–00:00`). 32 have a duration over ten
hours and are almost certainly transpositions — `19:00–18:00`, `12:00–11:00`,
`18:00–15:00`, mostly on all seven days. These are **left alone**: `12:00–08:00`
is genuinely ambiguous between `08:00–12:00` and a real overnight, and guessing
publishes wrong hours. All but two are unlisted. Note `endTime: "23:59"` and
`endTime: "00:00"` are two encodings of the same intent that differ by a minute;
an explicit `endsAtClose` flag, mirroring the existing `startsAtOpen`, would
retire the sentinel.

**Timezone handling is correct.** `sanDiegoTime.ts` resolves every wall clock
through `America/Los_Angeles`, refuses offsetless strings rather than letting
`new Date` apply the machine zone, and handles both DST transitions. The 3am bug
was not a timezone bug. Tests cover all-day windows, overnight windows crossing
midnight, and the day-boundary case where Pacific and UTC disagree on the date.

## 5. The day chips that disagreed with the prose

The build highlighted the union of every window; the owner-edits repaint then
rebuilt the chips from the flat `days` array alone, dropping any day that only
exists in `windows`. Both now go through one `happyHourDayNames` helper.

**121 listings have a day in `windows` that is missing from flat `days`**, always
in that direction — the flat array was derived from the primary window only, so
every venue with a weekend or late-night secondary window has a stale one. The
shared helper makes this harmless for rendering. Deriving the flat fields from
`windows` at build time would remove the divergence at source and is the
recommended follow-up; the flat fields could then go away.

## 6. Deals

| Problem class | Count | Disposition |
|---|---|---|
| Extractor annotation as a deal chip | 1 | **Fixed** |
| Deal chip that is a street address or phone number | 3 | **Fixed** |
| Deal wholly contained in a longer chip beside it | 5 | **Fixed** |
| Unterminated HTML comment / dangling conjunction | 2 | **Fixed** |
| Listings over the six-chip cap | 3 | **Fixed** |
| Empty, whitespace, HTML-entity, HTML-tag, mojibake deals | 0 | — |
| Head-truncated deals (`"er $8"`, `"From"`) | 10 across 7 | Owner — needs re-scrape |
| Deals over the 42-char chip budget | 120 across 97 | Owner — route to `compress-deals` |
| `dealTypes` set while `deals` is empty | 158 | Owner — see below |
| `dealTypes` contradicted by the venue's own deal text | 20 | Owner |
| `dealsUnknown: true` with a priced offer in its own evidence | 7 | Owner — some are false positives |
| `dealsUnknown: true` with a non-empty `deals` array | 0 | — |
| Marketing copy / non-offers surviving the filter | 2 | Owner |

**`dealTypes` was re-derived correctly.** Zero listings are missing a tag their
text supports. The 178 discrepancies are all the other direction — tags nothing
in the current catalog justifies.

**The 158 are a trap, and the trap is now disarmed.** Their drink types came from
Google's cached `servesBeer`/`servesWine`/`servesCocktails` booleans, and they
hold no deal text of their own. The "keep what it has" guard in
`rederive-deal-types.mjs` only protects listings that *have* deal text, so if the
enrichment cache is ever missing, a re-run reads it as "Google said nothing",
strips all 158, and reports success. **The script now refuses to run without the
cache** rather than silently doing that. The decision the owner still owns is
whether to keep tags that cannot be re-checked, or accept that 158 venues become
unfilterable.

**Vocabulary gaps worth fixing before deleting any tag**, since they make correct
data look wrong: `mimosas` classifies as cocktails but not wine; `sake` as wine
but not cocktails; `oysters` is a sibling of `food` rather than implying it, so
Ironside Fish & Oyster's `$1.50 oysters` is invisible to a food filter; and
`"you call its"` misses the `you call it` pattern by one letter. Fixing the
patterns first will shrink the 20 before anything is removed.

## 7. Menus

| Problem class | Count | Disposition |
|---|---|---|
| Prices in one of several spellings of the same value | 60 across 19 | **Fixed** |
| Prices that are not prices (`"$"`, `"Not specified"`, `"token"`) | 77 across 10 | **Fixed** |
| `note` that only restates the section titles beneath it | 9 | **Fixed** |
| Menu item that is a storefront error message | 2 | **Fixed** |
| Duplicate name+price within one menu | 2 | **Fixed** |
| Sections with zero items | 0 | — (now an invariant) |
| Empty or duplicate section titles, overlong item names | 0 | — |
| `hhMenu` with no `sourceUrl` and no `observedAt` | 269 | Owner — cannot be invented |

**The price field is typed wrongly, and that is worth deciding before more
cleanup.** Around 480 items hold genuinely informative relative prices — `"$2
off"`, `"50% off"`, `"½ off"` — in a field validated as if it were absolute. That
guarantees a permanent "invalid" rate that is not actually invalid. Splitting
amount from discount, or adding a `priceKind`, would let the validator be strict
without false alarms and let the renderer lay out `"½ off"` differently from
`"$6"`.

**269 of 313 menus have no provenance at all** — the object is just `{note,
sections}`. There is no way to tell how old 86% of the menus are or where they
came from, which makes staleness undetectable. This is the largest structural gap
on the menu side and it cannot be backfilled from nothing; new scrapes should
always write `sourceUrl` and `observedAt`, as the transcriptions in this pass do.

## 8. Cross-checks

- **Menu content but no deals: 3** (Karl Strauss, Sky Deck, The Nolen Rooftop) —
  all `dealsUnknown: true`, so a page showing dozens of priced items also tells
  the reader we do not know the specials. Recoverable by deriving chips from the
  menu.
- **Deals but no window: 0.** Clean, and enforced by `validate-data.js`.
- **290 published listings have a window and nothing else** — no deals, no menu,
  no image. This is 42% of published listings and the largest user-visible
  quality problem in the dataset. It is not a cleanup: those listings need a
  re-scrape or unpublishing.
- **Three published listings are not venues** — Mission Valley and Liberty
  Public Market are shopping centres, Sky Deck is a food hall. Their deal data is
  aggregated across tenants and is structurally untrustworthy.

## 9. Invariants now guarded

In `tests/venue-audit.test.mjs`, which runs as part of `npm test` since the one
live-crawl check moved to `test:venue-crawl:live`:

- No listing stores an all-day window that does not describe a service day.
- No stored menu section has zero items under it.
- No deal chip is an extractor annotation.
- Highlighted days never omit a day a listing is scheduled on.
- An all-day window is not live in the small hours; the open-now check reads the
  San Diego weekday, not the UTC one.
- Menu text reaches the search haystack.
