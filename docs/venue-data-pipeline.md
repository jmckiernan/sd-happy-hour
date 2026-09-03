# Venue data pipeline playbook

This is the working description of how Happy Hour SD finds, verifies, stores, and displays happy hour listings. Update it whenever a gate, outcome, or display rule changes.

The public site is a directory of **substantiated** happy hours. Every venue we know about stays in `public/data/happy-hours.json` so an owner can claim it. Only listings we can stand behind appear on the homepage, map, and neighborhood pages.

---

For the exhaustive list of every check, gate, threshold and constant in the pipeline — in stage
order, with the reasoning behind each — see `docs/venue-pipeline-reference.md`. This file is the
operational playbook; that one is the specification.

## What a listing is allowed to say

- **Times** must come from Google’s happy-hour hours or from a venue page we can quote.
- **Deals** are short chips: price plus item (`$7 martinis`), not slogans, questions, or “good vibes” copy.
- **Extra detail** belongs on the venue page only when it is real information (a second window, a named night, a constraint like “with a full pour” or “Tuesday only”). Marketing sentences are not extra detail.
- If we have verified times but no offer lines, the chip is **Happy hour**. We do not tell the shopper “deals not listed — check with venue” on browse cards or the venue deal grid. That copy made listings look empty even when the window was real.
- Venue **operating hours** (`openTime` / `closeTime`) are not happy hour. Google sometimes stores `12:00–02:00` as `HAPPY_HOUR` when that is actually “open everyday noon to 2am.”

---

## Sources, in order

1. **Google Business Profile** `regularSecondaryOpeningHours` of type `HAPPY_HOUR`. Authoritative for *when*, never for *what is on offer*.
2. **The venue website, inventoried once per domain** (not once per location). robots.txt → sitemap → always fetch the homepage, `/menu` / `/menus`, and any happy-hour/specials URL, then rank other candidates. Specials, happy hour, menus, PDFs, and flyer images all count. Playwright only when the page is a challenge or the HTML is an empty shell. Menu pages wait for content the same way specials pages do. PDFs linked from a specials page are queued even when the host is `www` vs apex. Image/PDF bytes are sniffed (JPEG/PNG/WebP/PDF magic) before they go to Haiku — a `.png` URL that is actually JPEG must not 400 the whole extract. Google's `websiteUri` is not trusted on its own: we do not invent `{venuename}.com`, and a listed URL is rejected when the page does not mention this venue's name and a San Diego-area address or phone. Google Maps links are source URLs, not websites.
2b. **Store-locator widgets**, for multi-location brands that publish the offer nowhere else. `/locations` is followed at a deliberately low score (below every specials and menu link) because its *own* text almost never says "happy hour" — the widget renders client-side. When a page references a known platform we read the account id out of the script tag and call the public JSON API over plain HTTP: Storepoint (`storepoint.co/api/v1/js/{id}.js` → `api.storepoint.co/v1/{id}/locations`), Stockist (`data-stockist-widget-tag` → `stockist.co/api/v1/{tag}/locations/search`), StoreRocket. The adapter list is a fast path, not the mechanism — `collectLocationRecordsFromJson` mines *any* JSON for location-shaped objects carrying offer text, which is what covers platforms nobody added an adapter for. Offers are matched to **one** venue by coordinates (then street address), never brand-wide.
3. **One Haiku call per location** with those HTML candidates plus up to four vision blocks (PDF or specials images). Recurring specials count even when the page never says “happy hour.” A happy-hour section on the menu beats a homepage FAQ. Chips are **at most 6**: condense a category into one chip (`$6 house beers, wines & wells`); if there are more than six distinct categories, keep the most useful mix of drinks and food. If there are only two or three, list only those. Each page is clipped to **20k characters** around the happy-hour section (80k combined across sources). Output is compact JSON; truncated JSON is repaired or retried. Food halls / marketplaces get shared hours only — one tenant’s menu is not copied onto the hall. A happy-hour **menu image or PDF flyer** is saved to `galleryImages` (PDF pages are rasterized to JPEGs) and shown in the venue photo lightbox. Generic dinner-menu PDFs are not saved.
4. **An outcome**, stored on `lastScrape`. A miss is never a single “no data” bucket.

Chain brands are fetched once, then mapped onto each location. A page about a different address is `other_location`, not a find.

---

## Scrape outcomes

| Outcome | Meaning |
| --- | --- |
| `found` | Offers or times with supporting quotes |
| `google_complete` | Google already has times and we already have deal lines |
| `not_published` | We read candidate pages; this location does not currently publish specials |
| `no_website` | No official site on the listing |
| `no_candidates` | Site fetched, but nothing ranked as specials/happy-hour/menu |
| `blocked` | Challenge, 403, or 429 |
| `media_unreadable` | Best candidate is a PDF or image we could not read |
| `wrong_website` | The listed URL does not mention this venue or its San Diego address |
| `extract_failed` | We got content, extraction failed |
| `ambiguous` | Sources disagreed or the page was too unclear to apply |
| `other_location` | Same brand, different address |

`not_published` is a real read. `no_candidates`, `blocked`, and `extract_failed` are not. Never roll those together into one “no data” count.

---

## Apply gates (what is allowed to overwrite JSON)

- A model **confidence label is not evidence**. Apply requires a short quote plus URL.
- Google-backed times stay unless a **dedicated** specials/happy-hour **or menu** URL disagrees **and** we have a times quote.
- Windows must be **plausible happy hour**, not operating hours: reject 8+ hour spans, 2am–8am, and zero-length windows. Overnight (22:00–01:00) is allowed. Late-night starts at 20:00 or later.
- Deal lines come from the model. We strip nav junk and clock ranges from chips; we do not require a `$`, “half price”, or other hardcoded offer vocabulary before writing deals. “1/2 off drafts” is a real deal.
- After extract, deal strings that are still marketing copy or longer than a chip are rewritten by a **second Haiku pass** (`compress-deals`) into homepage chips. Venues that already have `weeklySpecials` are skipped so named nights are not thrown away. The UI does not truncate mid-sentence.
- If Anthropic returns a **credit balance** error, the job **stops immediately**. It does not stamp the rest of the catalog as `extract_failed`. It writes `.data/import/refresh-status.json`, rings the terminal bell, and shows a macOS notification. Resume with `--retry-failed` after adding credits.

---

## Data shape

Stored in `public/data/happy-hours.json`.

- `startTime` / `endTime` / `days` — primary window for older UI and filters.
- `windows[]` — canonical schedule when a venue has more than one period (afternoon exchange, late-night beer exchange, Sunday 5pm–close).
- `openTime` / `closeTime` — venue hours, distinct from happy hour.
- `deals[]` — short chips for homepage, map, neighborhoods, and the venue-page deal grid.
- `weeklySpecials[]` — day-by-day or occasion rows that do not fit one window (`named_night`, `exchange`, `fixed_price`, `food`, `venue_note`, `event`). Summaries stay short; `details[]` can hold real extra lines (prices, constraints). Game day uses `occasion: "game_day"` with no weekday.
- `dealsUnknown` — we have times but no offer lines. Display still says “Happy hour.”
- `listingStatus` — `published` reaches browse; `unlisted` stays claimable.
- `hhSources` / `hhConflicts` / `lastScrape` — provenance and disagreements (for example Google `12:00-02:00` vs website exchange hours).
- `windows[].startsAtOpen` — the venue published only an end time (“Open–7PM”). `startTime` still holds a plausible clock time so filters and the live badge work, but no UI prints it; the label reads “Open until 7 PM”.
- `windows[].endTime === '23:59'` — stand-in for “until we close”. Never printed as a clock time; boards and venue pages render “–Close”.
- `hhMenu` — the structured board (`{ note, sections[{ title, items[{ name, price }] }] }`) behind a generated menu image. Kept so the design can change without a re-crawl.
- `galleryImages[].generated` — true for boards we typeset. A scraped flyer always wins; generated boards are the fallback and the only images `menus:render` will replace.

Homepage cards show at most three chips and pin the address/Details footer to the bottom of the row. The venue page shows the same chips (up to six) plus the weekly specials section when that data exists.

---

## Display rules

- **Homepage / map / neighborhoods:** `cardSpecials()`. Prefer today’s named night + exchange; otherwise weekly headlines or the stored deal chips. Fallback: `Happy hour`.
- **Venue page deal grid:** `venueDealLines()` — same chips (up to six), not a second copy of the marketing paragraph.
- **Back link:** default is “Back to all happy hours” (`/`). If the shopper arrived from this venue’s neighborhood page, it becomes “Back to {neighborhood} happy hours.” If they arrived from another `/neighborhoods/…` URL, it becomes “Back to the neighborhoods page” and returns to that URL.
- **Live badge:** uses `windows[]` when present, including overnight wrap and flyer-stated all-day happy hour (`allDay: true`). A 14-hour unlabeled span without `allDay` is still rejected as operating hours.

---

## Menus we typeset ourselves

Every listing with a transcribable menu gets a board we typeset, and the board is what the page shows.

- **A transcribed board replaces the venue's own flyer.** A scraped flyer is whatever the venue happened to export: a phone photo, a 24-hour clock, 900px of JPEG artifacts. Once we can read a menu into `hhMenu`, our board is more legible, uniform across 611 listings, and restylable without a re-crawl, so it wins. The scraped flyer is only shown when transcription failed — that is the fallback, not the default.
- **Only a times-only happy hour should have no board.** If a venue publishes prices at all, a missing board is a pipeline failure to investigate, not an expected state. `npm run menus:audit` classifies every listing so that gap stays visible.

- **The JSON behind the page is the source of truth, not the DOM.** Menu platforms (Popmenu, and anything else that renders client-side) ship every section in one API response and then render only the section the visitor selected. No viewport height, wait, or tab-clicking gets the rest — Tamarindo's drinks list is simply never in the DOM. The browser fetch records JSON responses and mines them shape-first: any object with a name and a price is an item, and its nearest named ancestor is the section. Zero prices mean sold out, not free. This is why a 17-item menu stopped arriving as 2 chips.
- **A second, menu-only AI pass** runs when the main extract returns no board, on the pages ranked richest in menu text. Chips are a summary; a board should be a transcription.
- **Every customer-facing string is formatted from our own data.** Hours come from `windows[]`, never from a model-transcribed hours line, because those are usually a 24-hour clock copied off the page. 12-hour clock only, always.
- **Copy rules live in normalization, not in the renderer**, so `menus:render` applies rules added after the scrape: strip the `HH` / `Happy Hour` prefixes ordering platforms bake into item names, and drop `.00` so `$6` and `$6.00` don't sit in the same column.
- **Boards are rendered in headless Chrome** at 1080px CSS width and `deviceScaleFactor: 2` (2160px PNG), which is the only way to use the site's real faces (Playfair Display + Outfit) and gradients and to stay sharp. Two columns past 14 items.

```bash
npm run menus:render                    # dry run
npm run menus:render -- --apply         # restyle every generated board, no crawl, no AI spend
npm run menus:render -- --apply --venue=kingfisher,385
npm run menus:audit                     # coverage: which listings still have no board, and why
```

---

## Menus as queryable data

`hhMenu` renders a board; it does not answer "cocktails under $8 in North Park" without loading 611 nested documents. `npm run menus:sync` projects the same data into `happy_hour_menus` / `happy_hour_menu_items` (migration `0018`), which is indexed and full-text searchable.

- **The JSON file stays the source of truth.** The tables are a rebuilt projection, never edited by hand.
- **Deliberately separate from `menu_sections` / `menu_items` (migration `0004`).** Those are the owner's hand-authored menu, editable in the claim dashboard. Sharing tables would let a re-scrape delete an owner's work and an owner's edit corrupt the analysis corpus.
- **A sync replaces a venue's items wholesale**, because a re-scrape is the authority on what a venue no longer offers.
- **Prices are parsed once, in `menu-item-classify.mjs`.** Menus price things in prose (`½ off`, `6/9`, `$2 off draft`), which is fine on a board and useless in a `WHERE` clause, so that module decides what a price means and every consumer agrees. `price_text` keeps the original wording.
- **Categories are a short food/drink split** a reader would agree with, not a cuisine taxonomy. House-invented drink names ("Del Sol") legitimately land in `other`; the venue's own section heading is the fallback signal.

```bash
npm run menus:sync                      # dry run: item counts and category coverage
npm run menus:sync -- --apply
npm run menus:sync -- --apply --venue=398
```

---

## What a run costs

The refresh prints an AI usage breakdown per pass. Measured on Haiku 4.5: **$0.012–0.023 per venue, so roughly $7–14 for a full 611-listing pass.** A text-only venue is at the low end; one with flyer images that also needs the menu-only second pass is at the high end (a 364-venue backfill came to $8.37).

- **~80% of spend is the main extract call, and most of that is input tokens** — the page text we send, 11–14k tokens per venue. Output is minor; vision is close to free (half a cent for a rasterized PDF, `$0` when a listing has no media).
- **So cost scales with venues read, not with menu complexity.** Refresh single listings; don't re-run the full catalog unless the pipeline actually changed. Boards can be restyled with `menus:render` for `$0`.
- **Prompt caching does not help here.** The static prefix is ~1.5k tokens, under Haiku's ~2k cache minimum, and the rest of the payload differs per venue.
- The 80k-char text cap is not the binding constraint (typical payloads are well under it), so trimming it saves little.

---

## What qualifies a venue for import

Discovery admits a venue when Google flags `HAPPY_HOUR` secondary hours, when the cheap regex website read finds one, **or** when the brand's store locator publishes one for that exact address. The locator check is two plain GETs per domain (cached per origin) with no model call, so it costs nothing meaningful per run.

Last, if the site says "happy hour" but nothing cheap could read a schedule out of it, the AI deep extract runs. That gate is the whole cost story: running the model on every enriched candidate is ~`$0.0085 × 4,700 ≈ $40` a run, but only about 2% of sites mention a happy hour we failed to parse, so gating on a plain text search brought the same recall down to **$0.26**. The expense was never the model, it was asking it about thousands of sites with nothing to find. Set `IMPORT_AI_FALLBACK=0` to disable.

A result is only accepted if `hasUsableSchedule` passes. The model will return `found` for a page title reading "Happy Hour" or a line like "Come by for a Happy Hour", and importing those puts a venue on the site with blank times.

Out-of-county places never qualify. `COUNTY_BOUNDS` is a rectangle and the county is not: its northwest corner reaches San Clemente (Orange) and its northern edge reaches Temecula (Riverside). No tighter rectangle fixes this — Temecula sits at 33.494°N in Riverside while Fallbrook at 33.376°N is San Diego. `county.mjs` reads Google's `administrative_area_level_2` instead, falling back to a city-name list only when Google omits it. `npm run audit:county` reports and unlists strays already in the catalog.

---

## How a venue becomes public

1. Import or refresh writes times and/or deals with evidence, **or**
2. An owner claims with a matching domain email or phone code (auto-publish), **or**
3. Admin approves a manual claim (`publishedByClaim`).

Unlisted venues still have a page so owners can find and claim them. They stay out of the sitemap and browse.

### Claimable stubs

Every enriched place that clears 4.0★ / 10 reviews and sits in San Diego County gets a
listing, whether or not we ever found a happy hour for it — otherwise an owner searching
the restaurant dashboard for their own restaurant finds nothing to claim.

A stub is a listing with `hasHappyHourData: false` and **no** `days`, `startTime`,
`endTime`, `deals`, or `dealTypes`. Their absence is the point: the venue page renders any
window it finds as a real happy hour, so a placeholder would publish a time we invented.
`validate-data.js` enforces that a stub carries none of them and is `unlisted`.

`src/pages/venues/[slug].astro` dispatches on `hasSchedule(venue)` — scheduled venues get
`VenueHappyHourPage`, stubs get the much smaller `VenueStubPage`, which is `noindex` and
points at the claim flow. `getPublicVenues()` returns `ListedVenue`, so browse surfaces
can't receive a stub even if a claim publishes one before its owner supplies a window.

Costs nothing to run; every place involved was already enriched.

```bash
npm run import:stubs -- --dry-run
npm run import:stubs
```

---

## Commands

```bash
# Full import (discover → enrich → extract → stage → merge)
npm run import:venues

# Re-read websites (Google times first, domain inventory, one Haiku call)
npm run import:venues:refresh-happy-hour              # dry run
npm run import:venues:refresh-happy-hour -- --apply
npm run import:venues:refresh-happy-hour -- --venue=the-tipsy-crow --browser --apply
npm run import:venues:refresh-happy-hour -- --retry-failed --apply --browser
# If Anthropic credits run out, the job aborts, writes .data/import/refresh-status.json,
# and shows a macOS notification. Rerun with --retry-failed after adding credits.

# Rewrite stored marketing/long deal strings into chips (no recrawl)
npm run import:venues:compress-deals                  # dry run
npm run import:venues:compress-deals -- --apply

npm run audit:venues
npm run validate:data
npm run test:venue-audit
npm run dev:netlify   # http://localhost:8888/
```

AI extraction uses `ANTHROPIC_API_KEY`. The model default is `claude-haiku-4-5` (`VENUE_AI_MODEL` to override).

---

## Worked example: The Tipsy Crow

Specials live at `https://thetipsycrow.com/specials/` as day-tab **images**. A text-only crawl correctly reported “page mentions specials, no quoted prices.” Vision of the flyers produced the weekly rows (Mule Mondays, Taco Tuesday prices, Drink Exchange hours that change by day, Padres game day). Google’s `12:00–02:00` is venue hours, stored as a conflict, not as happy hour.

That listing is why `weeklySpecials` exists: one start/end pair cannot describe it, and the homepage card should not try.

---

## What we used to get wrong

- **“327 no data”** mixed blocked pages, skipped PDFs, truncated HTML, “Taco Tuesday” pages with no times, and true empty sites. Outcomes now split those apart.
- **Confidence-only applies** overwrote Google times. Evidence quotes are required.
- **Domain recrawled per location** wasted time and got inconsistent reads. Inventory is once per domain.
- **Deal chips were truncated in CSS** (“tasty bites & drinks from $3 -”). Long copy is rewritten by Haiku, not clipped.
- **“Deals not listed”** on a card with a verified window felt like a dead listing. The chip is “Happy hour.”
- **Tests overfit a single venue.** New behavior needs a fixture that matches the rule, not only Sushi Lounge.
- **We tried to fix client-rendered menus by driving the browser harder** — taller viewports, longer settles, clicking every tab. It never worked, because the unselected sections are not in the DOM at any point. Reading the page's own JSON responses did.
- **A generated board printed `15:00–17:30` and `10–11:59 PM`.** Model-supplied hours strings and the internal midnight sentinel both reached customers. Boards now format hours only from `windows[]`.
- **We guessed URL paths before reading the ones the site gave us.** Blind guesses burned the crawl budget on 404s and pushed real menu links out. Discovered links and homepage media are ranked first; the guess list is now six genuinely conventional paths, tried only when discovery finds nothing. This moved a pilot batch from 6/25 to 9/25 extracted.
- **A 39MB cocktail book was rasterized and sent to vision.** Size was the visible problem, relevance was the real one: the PDF never mentioned happy hour. PDFs are now checked for happy-hour text before they cost anything.
- **We assumed the bill came from menus and PDFs.** It came from page text on the main extract call, multiplied by 611 listings. Nothing was measured until the refresh started printing per-pass token usage — attribute spend before optimizing it.
- **A model transcribed a broken storefront's error text as a menu item** ("You have no products in your Frontpage collection"). Normalization drops site chrome, and a board made only of chrome is no board.
- **A locator page was fetched and thrown away before anyone looked at it.** Board & Brew publishes "$2 off all pints, everyday 3-6PM" only inside a Storepoint widget on `/locations`. That path scored 0 in both rankers, so it was never queued; when it finally was, it scored 0 again on happy-hour text (the widget renders client-side, so the HTML says "happy hour" zero times) and was dropped before the widget's script tag could be read. Locator detection now runs *before* the score gate. Same lesson as the Popmenu menus: read the page's JSON, not its DOM.
- **One brand's offer is not every location's offer.** In the same payload Mission Valley says "$2 off all beers" where Scripps Ranch says "all pints", and Del Mar, Pacific Beach, Petco Park, and San Clemente publish nothing at all. Matching is by coordinates or street address; a brand-name match alone would have copied one deal onto sixteen storefronts and invented four.
- **We had 1 of 16 San Diego Board & Brews.** Dedupe was innocent — it treats same-name venues 120m+ apart as distinct. The gate was upstream: a venue was only staged if it *already* showed a happy hour, and the only signal discovery consulted was Google's flag, so the 15 locations that publish solely through their locator were dropped before anything read their website. A venue could not qualify without the evidence we refused to go get.
- **The grid only finds what it ranks.** Discovery is a set of nearby-searches, so it returns popular results per circle rather than everything present. Board & Brew has 14 San Diego County locations and the grid found 6 — we were asking Google to discover addresses the brand publishes to us directly. `npm run seed:locators` reads locators for multi-location domains and looks up the unknown addresses by text search. Google still rules on whether a place is real, in-county, and popular enough; only the list of addresses we think to ask about changes.
- **Dedupe was silently matching nothing.** Google sends `displayName` as `{ text }`; the enrich cache flattens it to a plain string. `isDuplicateCandidate` read only `.text`, so every name compared as `undefined`, and the id path was equally dead because no catalog venue has `_import.googlePlaceId` — they store `placeId` at the top level. Staging reported "0 duplicates" against 534 venues it already had, and promoting it would have doubled the catalog. A dedupe that never matches looks exactly like a clean import.
- **A rectangle is not a county.** 54 venues (23 San Clemente, 31 Temecula) were imported and published on a San Diego site because the search grid is a bounding box overlapping Orange and Riverside counties. Google returns the county on every detail call and we were already paying for the field.
- **`Sunday - Thursday` became four days.** The model dropped an interior day that its own evidence quote spelled out. Quoted day ranges now repair an enumerated subset.
