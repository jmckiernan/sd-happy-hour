# Venue data pipeline playbook

This is the working description of how SD Happy Hours finds, verifies, stores, and displays happy hour listings. Update it whenever a gate, outcome, or display rule changes.

The public site is a directory of **substantiated** happy hours. Every venue we know about stays in `public/data/happy-hours.json` so an owner can claim it. Only listings we can stand behind appear on the homepage, map, and neighborhood pages.

---

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

Homepage cards show at most three chips and pin the address/Details footer to the bottom of the row. The venue page shows the same chips (up to six) plus the weekly specials section when that data exists.

---

## Display rules

- **Homepage / map / neighborhoods:** `cardSpecials()`. Prefer today’s named night + exchange; otherwise weekly headlines or the stored deal chips. Fallback: `Happy hour`.
- **Venue page deal grid:** `venueDealLines()` — same chips (up to six), not a second copy of the marketing paragraph.
- **Back link:** default is “Back to all happy hours” (`/`). If the shopper arrived from this venue’s neighborhood page, it becomes “Back to {neighborhood} happy hours.” If they arrived from another `/neighborhoods/…` URL, it becomes “Back to the neighborhoods page” and returns to that URL.
- **Live badge:** uses `windows[]` when present, including overnight wrap and flyer-stated all-day happy hour (`allDay: true`). A 14-hour unlabeled span without `allDay` is still rejected as operating hours.

---

## How a venue becomes public

1. Import or refresh writes times and/or deals with evidence, **or**
2. An owner claims with a matching domain email or phone code (auto-publish), **or**
3. Admin approves a manual claim (`publishedByClaim`).

Unlisted venues still have a page so owners can find and claim them. They stay out of the sitemap and browse.

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
