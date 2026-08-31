# Where the browser crawl is wired in, and what we missed by not wiring it

The owner was right that this capability already existed. Nothing here was
built; this records which extraction paths used it, why one did not, and how
many listings were affected.

## The mechanism already had the fallback

`createCachedFetch` in `lib/fetch-page.mjs` already implements the pattern worth
having: plain fetch first, browser only where the cheap path visibly failed. The
predicate `needsBrowser()` fires on a known SPA menu host (Popmenu, Toast,
Square, BentoBox), a Popmenu page with no prices in it, a Cloudflare block, a
timeout, a 401/403/429/503, or fewer than 500 characters of text — the empty
shell case exactly.

So the answer to "should we try plain and fall back to the browser on an empty
shell" is that this is already what the code does. The gap was never the design.

The gap was one line:

```js
if (needsBrowser(entry) && gatedBrowser) {
```

`gatedBrowser` is null unless the caller passes `browserFetch`. A caller that
omits it gets the detection and none of the remedy: the code correctly concludes
the page is unreadable and then returns the blank page anyway, with `ok: true`.

## Which paths passed it

| Path | Passes `browserFetch` | Verdict |
| --- | --- | --- |
| `refresh-happy-hour.mjs` (main extract) | yes, `browser: 'auto'` → on when a warmed profile exists | correct |
| `audit-venues.mjs` | yes, behind `--browser`, exits if no profile | correct — opt-in is right for an audit |
| `experiments/features-field/crawl.mjs` | yes, when `hasBrowserState()` | correct |
| `rescrape-capped-menus.mjs` | **no** | oversight, now fixed |

Only one omission, and it was mine. The three pre-existing paths were all wired
correctly, so this was not a systemic hole in the pipeline — it was a new script
that did not copy an existing idiom.

## Why it is not simply always on

The real reason is the warmed profile, not cost or speed. `createBrowserFetch`
launches headless with `storageState` from `.data/browser-state.json`, which only
exists after a human runs `npm run browser:warm -- --auto` headed and clears
Cloudflare by hand. Without that file the browser path launches but gets served
the same challenge page, so it buys nothing and costs 30s a URL.

`refresh-happy-hour.mjs` handles this well: `browser: 'auto'` turns the browser
on precisely when the profile exists, and warns when asked for it without one.
That is the right arrangement and I would not change it.

Speed is a genuine secondary cost — a browser read is roughly 5–7s against
~0.3s for a plain fetch — but since the fallback only pays it where the plain
fetch already failed, it is bounded by the number of unreadable sites, not by
the size of the run.

## What the 16 "could not be re-read" listings actually contain

Read both ways by `probe-browser-gain.mjs`, no model calls:

| | count |
| --- | --- |
| Browser recovered materially more text | 5 |
| ...of which name a happy hour *and* carry prices | 3 |
| No better either way | 11 |

**My earlier write-up was wrong about these.** It said "almost all are a
JavaScript shell". Only five were. Four of those returned a 16-character body to
the plain fetch — the unmistakable empty shell — and the browser read thousands:

| Listing | plain | browser | prices found |
| --- | --- | --- | --- |
| Hapa J's | 16 | 4,295 | 30 |
| Nick & G's Restaurant | 16 | 12,992 | 0 |
| Meze Greek Fusion | 16 | 17,687 | 0 |
| Eddie V's Prime Seafood (×2) | 0 | 9,293 / 9,650 | 0 |

The other eleven plain-fetched perfectly well — STK Steakhouse returned 20,654
characters with ten prices in it. Their re-scrape failure was downstream of the
fetch: the page ranker chose the wrong page, or the transcription found nothing
it would call a happy-hour menu. Those are separate bugs and the browser does
not touch them. Only Hapa J's was worth re-transcribing, and it was.

## The catalog-wide number

Two distinct populations, and conflating them would overstate the browser's
share of the blame.

**Listings we did read and came away empty from.** 77 have a `lastScrape` whose
outcome leaves their emptiness unexplained. Re-fetching each: **6 (7.8%)** have a
site the cheap path cannot read — 4 empty shells, 2 blocked. `wrong_website` and
`other_location` outcomes are excluded because those are correct answers reached
on evidence, not absences.

**Listings never read at all.** 2,396 have no `lastScrape` whatsoever — imported
from Google and never crawled — of which 2,181 have a usable website. Their "no
happy hour" rests on no evidence at all. Sampling 250 of them: **62 (24.8%)**
have a site a plain fetch cannot read (41 blocked, 19 empty shell, 2 SPA host).
Extrapolated, **roughly 540 of the 2,181**.

So the deliverable, stated honestly:

- **6 listings** are miscategorised *today* by the browser gap, out of the 610 we
  actually scraped.
- **~540 listings** would be miscategorised by a plain-fetch-only scrape of the
  2,181 that were never attempted — and would be read correctly with the warmed
  browser profile.
- The far larger fact is that **2,396 listings (80% of the catalog) have never
  had their website read at all.** Their emptiness is not a browser problem; it
  is an unattempted problem, and no amount of browser wiring fixes it. That is
  the number the owner should weigh.

The window-only audit's 124 listings with no provenance are mostly this
never-scraped population rather than the JavaScript one.

## The fix that matters more than any re-read

An unreadable page now records itself as unreadable. Where `needsBrowser()` is
true and no browser is configured, the entry is marked `ok: false`,
`needsBrowser: true`, `reason: 'needs_browser'`, and the URL is collected on
`cachedFetch.unreadable`.

Before this, a JavaScript-only site returned `ok: true` with a valid, blank page,
and every downstream step treated the blank as a truthful answer — the "silent
success" the lessons doc names. A venue we could not read was indistinguishable
from a venue with nothing to read. Now the two are different states, and a run
can report which sites it was not equipped to read instead of quietly filing them
as venues without a happy hour.

`pageNeedsBrowser(url)` is exported from the same module so an audit can count
these without reimplementing the rule and drifting from it.
