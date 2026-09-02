# Infrastructure scalability: what breaks first

Every storage, build, read, write and media path in this system, what it costs today, what it costs
at ten cities, and the order in which it stops working. Written in answer to a direct question:

> Why do we need a large JSON file that holds all of the venue data? All of that is in the database,
> right? Can't we just use the database for the JSON file too? Should we really be storing stuff in
> GitHub? I want to make this entire infrastructure relatively scalable so that we can move to
> multiple cities and eventually have many thousands of venues and users. Everything needs to be
> fairly robust as far as time and space complexity.

`docs/data-architecture.md` answered the first half of that question — where the venue catalog should
live — and its recommendation still stands. This document is the second half: the owner asked to step
back and look at the entire infrastructure, and the venue JSON file turns out not to be the largest
problem in it. **This document supersedes `docs/data-architecture.md` where the two disagree**, and
§10 lists the four places they disagree and why. It is a new file rather than a rewrite because the
venue-storage argument in that doc is long, correct, and worth keeping intact for someone who only
wants that question answered.

Numbers are marked **measured** or **projected**. Measured values were read off this machine on
31 August 2026 at commit `7349656`; projected values state their arithmetic so you can disagree with
the assumption rather than the number. Pipeline mechanics are in `docs/venue-pipeline-reference.md`.
Multi-city groundwork is in `docs/porting-to-a-new-city.md`.

**Image-egress addendum, 1 September 2026:** §14 measures the current homepage's cold-scroll image
transfer, models the cost at city scale, and defines the image-delivery work that is a prerequisite
for a second city. It also records when moving image delivery from Netlify to Cloudflare R2 should
be evaluated.

---

## 1. The answer in one page

**What is in the database today:** everything about a venue and nothing that is a venue. 55 tables
(**measured**, `rg -c 'CREATE TABLE' migrations/*.sql`) with 102 indexes (**measured**) hold claims,
publications, photos, menus, promotions, overrides, saved lists, alerts, users and activity. There is
no `venues` table. Every one of those tables keys on a bare `venue_id integer` with no foreign key,
because — as `0004_venue_content.sql` says out loud — venues live in `happy-hours.json`. So this is
not two copies of the same data. It is one dataset in a file and its entire relational context in
Postgres, joined by an integer nobody enforces.

**What is actually going wrong, in order of severity:**

| # | Problem | Status | Breaks at |
|---|---|---|---|
| 1 | **717 MB of images committed to git**, 1,209 files, 240 MB of it exact duplicates | Already broken. `.git` is 722 MB for a site with 13.9 MB of real history | Now. Every clone. |
| 2 | **The pipeline's extract stage is serial**: 8.1 s per venue, 8.95 h for one city | Already painful | Now. A second city is a second overnight run you cannot parallelise. |
| 3 | **Client ships the whole catalog**: 643 KB gzip to draw 690 cards | Already wasteful, 11× larger than needed | Now, on every phone. Worse every import. |
| 4 | **GitHub is the venue write path**, whole-file, one lock for 3,208 rows | Works, fragile | Second concurrent editor, or any admin edit during a pipeline run. |
| 5 | **Four prerendered pages per venue**, two of which throw their content away | Fine | ~40,000 venues (build) / 54,000 (Netlify's per-directory file cap). |
| 6 | **No pagination on three admin list endpoints** | Fine | ~2,000 claims or ~5,000 photos. |
| 7 | **Catalog compiled into every serverless function**, including `/api/account/login` | Fine | ~50,000 venues. |
| 8 | **The catalog JSON file itself** | Fine | ~35,000 listings (GitHub push warning). |

The headline is that **the JSON file is the least urgent item on its own list.** It is honestly fine
to 20,000 listings and probably to 35,000. What is not fine is what has grown up around it: the
images beside it in the repository, the pipeline that fills it, and the payload it becomes in a
browser. Those three would still be problems if the catalog moved to Postgres tomorrow.

**What to do now, at the next city, and later** is §11. If you read nothing else, read that and §12.

---

## 2. Media and images — the largest problem, and the one nobody has named

This section is first because it is the only one where the system is already outside its budget
rather than approaching it.

### 2.1 What is there

**Measured**, `public/images/`:

| | Files | Bytes | Average |
|---|---|---|---|
| Venue photos (`{id}-{slug}.jpg/png`) | 651 | 321.8 MB | 494 KB |
| Happy-hour menu boards (`{id}-{slug}-hh-menu.*`) | 536 | 374.2 MB | 698 KB |
| Vibe stock photos | ~14 | 6.6 MB | — |
| Hero and backdrop | 2 | 296 KB | — |
| **Total `public/images`** | **1,209** | **717 MB** | |

By format (**measured**, venues directory only):

| Format | Files | Bytes | Average |
|---|---|---|---|
| PNG | 357 | 399.8 MB | **1,147 KB** |
| JPEG | 822 | 295.1 MB | 368 KB |
| WebP | 8 | 1.0 MB | 133 KB |

**All 1,209 files are tracked in git and present in `HEAD`** (**measured**,
`git ls-tree -r HEAD --name-only public/images | wc -l` → 1209).

### 2.2 Three separate defects, stacked

**Menu boards are stored as PNG.** `render-menu-boards.mjs` typesets a menu with `@napi-rs/canvas`
and writes it out. A typeset menu board is flat colour and text — the one image class where PNG is
not absurd — but at 1,147 KB average these are being written at full canvas resolution with no
quantisation. The same boards as WebP at quality 85 would be roughly 60–120 KB
(**projected**: the 8 existing WebP files average 133 KB, and they are photographs, which compress
worse than flat text). Call it **an 8–15× reduction on 400 MB**.

**206 menus exist twice, once as PNG and once as JPEG.** **Measured**: 206 basenames have more than
one extension, and the redundant copies total **239.9 MB**. `101-waterbar-hh-menu.png` and
`101-waterbar-hh-menu.jpg` are both committed. Nothing in the code reads both. That is a third of the
image payload, and a third of the repository, spent twice.

**They are in git.** This is the part that cannot be undone cheaply. `git count-objects -vH` reports
722 MB in `.git`, of which **13.92 MiB is packed** and the rest is 3,752 loose objects. Breaking that
down by type (**measured**, `git cat-file --batch-all-objects --batch-check`):

```
commit:  227 objects,   0.1 MB
tree:   1356 objects,   0.5 MB
blob:   2483 objects, 700.9 MB
```

`docs/data-architecture.md` §2.5 looked at the same 719 MB and concluded it was "a housekeeping
problem wearing a scalability problem's clothes" that `git gc` would reclaim. **That is wrong, and
it is the most important correction in this document.** The loose objects are not garbage awaiting
collection; they are the 1,209 committed image blobs, which have simply not been packed yet. `git gc`
will pack them. JPEG and PNG are already entropy-coded, so zlib will recover almost nothing and delta
compression across unrelated photographs recovers nothing at all. The realistic outcome of `git gc`
is a ~700 MB packfile in place of ~700 MB of loose objects, and a repository that is exactly as large
but now harder to fix. Run `git gc` if you like — it will tidy the 83 abandoned `tmp_obj_*` files and
227 KB of genuine garbage — but do not expect it to change the number.

### 2.3 What this costs, now and later

**Now (measured or arithmetic on measured values):**

- Clone: 722 MB. On a 50 Mbit connection that is roughly two minutes; on hotel wifi it is a coffee
  break. Every CI run, every new machine, every collaborator.
- Netlify deploy: `dist/` is **1.1 GB**, of which `dist/images` is **900 MB** — `public/` copied
  verbatim plus filesystem block overhead. Netlify uploads only changed files, so steady-state deploys
  are fine; the first deploy after any image batch is not.
- Serving: these are plain static assets on the CDN, which is the one part of the media story that is
  correct. Bandwidth is still a direct usage cost: edge caching avoids repeated transformation and
  origin work, but bytes delivered from the edge to each browser count as egress. §14 measures the
  current exposure and defines the multi-city gate.

**At ten cities**, holding the per-published-venue rate constant (**projected**; today 690 published
venues carry 717 MB, so 1.04 MB per published venue, and image coverage tracks the published set —
598 of 690 published venues have a photo, **measured**):

| Scale | Published venues | Image bytes | `.git` |
|---|---|---|---|
| Today | 690 | 717 MB | 722 MB |
| 3 cities | 2,070 | 2.2 GB | 2.2 GB |
| 10 cities | 6,900 | **7.2 GB** | **7.2 GB** |

A 7 GB git repository is not a repository anyone clones. GitHub soft-warns at 1 GB and asks you to
stop at 5 GB. This is the first hard wall in the entire system and it arrives at **city three**.

**Does Git LFS help?** No, and it is worth being precise about why, because it is the obvious
suggestion.

- LFS moves blob *content* out of the packfile and replaces it with a 130-byte pointer. It fixes
  clone size **only for new files**. The 717 MB already in `HEAD` stays in history unless you rewrite
  it with `git lfs migrate import`, which changes every commit sha, breaks every existing clone, and
  invalidates Netlify's build cache.
- It moves the cost, it does not remove it. GitHub's LFS quota is 1 GB storage and 1 GB/month
  bandwidth free; beyond that it is $5 per 50 GB data pack, and **every CI checkout that fetches LFS
  objects consumes bandwidth quota**. A Netlify build that pulls 7 GB of LFS objects per deploy is a
  bill, not a fix.
- It makes the images *harder* to serve. They are currently static assets on the CDN, which is the
  right answer. Behind LFS they are an artifact the build has to fetch first.

The correct answer is not LFS. It is **do not put binaries in git at all**: the same conclusion the
code already reached for owner-uploaded photos, which go to Netlify Blobs through
`src/lib/imageStore.ts` and are served by `/api/images/[key]` behind a `durable, immutable` CDN cache.
There are two image systems in this codebase — one correct, one committed to git — and the pipeline
uses the wrong one.

### 2.4 The fix, and what it is worth

Three steps, in order, all independently valuable:

1. **Delete the 206 duplicate copies.** Frees 239.9 MB on disk immediately. Does *not* shrink git
   history. One afternoon, and it stops the problem doubling again.
2. **Re-encode menu boards to WebP** in `render-menu-boards.mjs` and re-encode the existing 357 PNGs.
   **Projected** 400 MB → 30–50 MB. `@napi-rs/canvas` already encodes WebP, so this is a one-line
   change plus a re-render pass.
3. **Move pipeline images out of the repository** onto Netlify Blobs, behind the `/api/images/`
   route that already exists and is already correctly cached. New images stop entering history.
   Then, once, `git filter-repo` the `public/images` path out and force-push — which is a genuinely
   disruptive operation, but it is a one-time 700 MB recovery and it gets cheaper the sooner it
   happens.

Steps 1 and 2 are worth doing this week and are not migrations. Step 3 is the one that has to happen
before city three, and it is much cheaper at 1,209 files than at 12,000.

---

## 3. The import pipeline — 9 hours per city, and it does not parallelise

The second problem the storage discussion has been hiding.

### 3.1 Measured cost of the San Diego run

Timings recovered from the `detailsFetchedAt` and `happyHourCheckedAt` stamps in the caches under
`.data/import/google/` (**measured**). Gaps over 120 s are treated as the operator being asleep and
excluded, so these are active machine time:

| Stage | Items | Per item (mean) | Active total | Cache file |
|---|---|---|---|---|
| Discover | 5,714 candidates | ~250 ms (fixed delay) | ~0.4 h | 2.3 MB |
| Enrich | 5,357 places | **327 ms** | **0.49 h** | 19.4 MB |
| Extract | 3,977 venues | **8,099 ms** | **8.95 h** | 26.8 MB |
| Stage + merge | 3,804 qualified | — | seconds | 19.0 MB |

Extract is **95% of the wall clock** and it is 25× slower per item than enrich, because enrich makes
one Google API call while extract crawls the venue's own website: up to 6 pages and 8 fetches with a
400 ms delay between them, an optional Playwright browser session, and an optional model call. The
p90 is 16.5 s (**measured**). None of that is unreasonable per venue. The problem is the loop around
it.

### 3.2 Why it does not parallelise, and what that costs

`extract-happy-hour.mjs` is a bare `for (const place of todo)` with `await resolveHappyHour(place)`
inside it. Concurrency is **one**. `enrich.mjs` is the same shape. This is not an oversight elsewhere
in the codebase — `lib/fetch-page.mjs` exports a `mapPool`, `refresh-happy-hour.mjs` defaults to
concurrency 10 and groups by domain so it never hammers one host, and `audit-missed-happy-hours.mjs`
uses 8. The main pipeline is the one path that never got it.

The domain-grouping in `refresh-happy-hour.mjs` is the important precedent: politeness is a
*per-host* constraint, and extract is crawling 3,977 *different* hosts. Running 10 of them at once is
not rude to anybody. **Projected** effect of adopting `mapPool` with the existing domain grouping at
concurrency 10: **8.95 h → roughly 1.0–1.5 h**, sublinear because a handful of slow hosts dominate
the tail. That is the single highest-leverage change in this document measured in hours saved per
unit of engineering effort — perhaps a day's work for an 8-hour-per-city saving, forever.

**Can you run several cities in parallel today?** Mechanically, no. Every stage reads and writes a
fixed path from `lib/constants.mjs` (`.data/import/google/candidates.json` and friends). Two
concurrent runs would interleave writes into the same file and the last checkpoint would win. Making
the cache directory a per-city parameter is a small change and should happen at the same time as the
`city` column, because both are the same decision: the pipeline currently assumes there is one city
and it is San Diego.

### 3.3 The checkpoint quadratic

`enrich.mjs` checkpoints every 25 places and `extract-happy-hour.mjs` every 10, and both checkpoints
are `writeJson(PATH, { meta, places })` — a `JSON.stringify` of the *entire* accumulated store,
pretty-printed, written whole.

Extract checkpoints 398 times over a run that grows the file from empty to 26.8 MB. Mean file size
across the run is about half the final size, so total bytes written is
`398 × 13.4 MB ≈ 5.3 GB` (**projected**, from the measured checkpoint interval and final file size),
plus 398 full serialisations of a structure that ends at 4,033 objects. Enrich adds
`214 × 9.7 MB ≈ 2.1 GB`. Together roughly **7.4 GB of disk writes to produce 46 MB of cache.**

Formally this is `O(n²/k)` bytes for `n` items and checkpoint interval `k`. It is invisible today
because 5 GB of SSD writes disappears inside a nine-hour run. It stops being invisible the moment
extract gets 10× faster, because then the checkpoints are a meaningful share of the remaining time,
and it gets four times worse at double the catalog. The fix is append-only NDJSON, or checkpointing
only the delta — neither is hard, but neither is worth doing before the concurrency fix, because
right now it is not the bottleneck.

### 3.4 Resumability and cost, which are genuinely good

Credit where it is due, because these are the parts that already scale:

- `--resume` is on by default and keys on `detailsFetchedAt` / `happyHourCheckedAt`, so a run that
  dies at hour six resumes at hour six. It also records the stamp on failure, so a broken place is
  not retried forever.
- `--requalify` recomputes verdicts over the cache with **zero** network calls, so moving a threshold
  costs nothing.
- The enrich prefilter (§2.1 of the pipeline reference) drops candidates below 4.0★/10 reviews before
  buying Place Details, which is the gate that keeps the API bill proportional to useful venues rather
  than to everything Google mentions. 5,714 candidates became 5,357 details calls became 3,804
  qualified.

Per-city API cost is not a scaling problem; it is a linear, budgeted, well-understood cost documented
in `docs/places-api-cost-analysis.md`. Per-city *wall clock* is the scaling problem, and it is
entirely §3.2.

---

## 4. Venue data storage — the JSON file, honestly assessed

### 4.1 Current measurements

**Measured**, `public/data/happy-hours.json`:

| | Value |
|---|---|
| Rows | 3,208 |
| Bytes on disk (pretty-printed) | 4,506,949 |
| Per row, pretty | 1,405 B |
| Minified | 3,376,318 B |
| gzip, as served | **643,210 B** |
| Published with a happy-hour window | **690** |

The figure in `docs/data-architecture.md` (4,634,784 B) was taken four days ago; the file has since
*shrunk* slightly as the `features` field was removed and deal text was compressed. The panic-slope
reading of "66% growth in two days" in that document does not survive a second data point. Growth is
driven by import runs, not by time.

Field weight, share of the pretty-printed file (**measured**):

| Field | Bytes | Displayed on browse? |
|---|---|---|
| `lastScrape` | 0.65 MB | No — pipeline diagnostics |
| `sourceUrl` | 0.36 MB | No |
| `hhSources` | 0.34 MB | No — provenance |
| `hhMenu` | 0.22 MB | Venue page only |
| `address` | 0.17 MB | Yes |
| `website` | 0.16 MB | Venue page only |
| `placeId` | 0.11 MB | No |

Provenance (`lastScrape` + `hhSources` + `sourceUrl` + `placeId`) is **1.46 MB, 32% of the file**, and
no browse surface reads any of it. It is worth keeping — it is what lets the next pipeline run reason
instead of guess — but it is not worth sending to a phone.

### 4.2 Where the ceilings actually are

| Limit | Value | Reached at | Basis |
|---|---|---|---|
| GitHub Contents API inlining | 1 MB | ~710 listings | **Crossed**, fixed in `6a1df4a`. Costs one extra Blobs request per read. |
| GitHub push warning | 50 MB | **~35,000 listings** | 1,405 B/row (**measured**), linear (**projected**) |
| Git blob hard limit | 100 MB | **~71,000 listings** | Same basis |
| Netlify per-directory file cap | 54,000 | **~54,000 venues** | Netlify's documented limit; `dist/venues/` is one flat directory |

At ten cities and 3,000 venues each, the catalog is **~42 MB pretty-printed** (**projected**). That is
under the hard limit and just under the push warning. It is survivable. **The JSON file is honestly
fine to 20,000 listings and probably to 35,000, and anyone telling you otherwise is looking at the
wrong number.**

What is *not* fine at 42 MB is rewriting it in full to change one venue's phone number, and that is
§6, not this section.

### 4.3 What the live-override layer tells you

`src/lib/listingVisibility.ts` and `LIVE_LISTING_FIELDS` in `src/lib/venueContent.ts` exist because an
admin's edit must be visible before the next deploy, and the catalog is only read at build time. The
mechanism is: fourteen fields (`days`, `openTime`, `closeTime`, `startTime`, `endTime`, `deals`,
`dealTypes`, `vibe`, `website`, `phone`, `address`, `image`, plus the admin-only `imageCrop`) are
stored as a `jsonb` patch in `venue_overrides` and spread over the static row at runtime by
`/api/venue-overrides`, on the server by `mergeVenue()`, and in the browser by the homepage's
`mergeOwnerEdits()`.

This is genuinely well built. It is filtered on the way out rather than trusting the stored patch, the
comment explaining why is correct, and the field list is a deliberate boundary rather than an
accident. But read what it *is*: a second, mutable, per-venue copy of a third of the venue record,
living in Postgres, joined to the file at read time in three separate places. `imageCrop` is in that
list purely because a saved crop "looked like it had done nothing" until the next deploy — that is a
storage problem being solved at the presentation layer.

The right reading is not "this is a hack." It is: **the database has already, quietly, become the
source of truth for every venue field that anyone actually edits.** The file is authoritative only
for fields nobody changes by hand — coordinates, name, provenance, `verified`. The migration in §7 is
therefore less of a leap than it looks; it mostly consists of admitting what has already happened and
deleting the merge layer.

### 4.4 Complexity of the catalog read paths, and why they are not the problem

`n` = total venues, `p` = published-with-schedule, `U` = concurrent users.

| Path | Implementation | Time | Space |
|---|---|---|---|
| `getVenues()` | Static `import`, parsed once per process | `O(n)` once | `O(n)` resident per instance |
| `getVenueById` | `Array.find` | `O(n)` | `O(1)` |
| `getPublicVenues` | `filter` + `Set.has` | `O(n)` | `O(p)` |
| `getVenueBySlug` | `filter` + memoised slug map | `O(n)` | `O(k)` |
| Claim search | Score all rows, **full sort**, `slice(0, 8)` | `O(n log n)` | `O(n)` |
| Homepage filter (browser) | Chained `.filter()` per interaction | `O(n)` per keystroke | `O(n)` in the tab |
| Client catalog fetch | Whole static file | `O(n)` transfer | **`O(n · U)` egress** |
| Single venue edit | Read file, mutate, write file | `O(n)` in + `O(n)` out | `O(n)` git, permanently |
| Build | Prerender **4** pages per venue | `O(n)` | `O(n)` |

**The `O(n)` scans are not the problem and rewriting them is not the win.** A linear scan of 3,208
objects is tens of microseconds; at 30,000 it is a fraction of a millisecond. If the owner's instinct
is that `Array.find` needs an index, the measurement says otherwise and the effort belongs elsewhere.

The terms that hurt are the ones with a second factor: `O(n · U)` client egress (§5), `O(n)` write
amplification per edit (§6), and `O(n)` permanent git storage per commit. Plus exactly one genuine
algorithmic defect — the claim search in `/api/restaurant/venues` sorts every scored row to return
eight, which should be a partial selection and properly wants a text index (§9).

---

## 5. Read paths — the client payload is the one costing real users something today

### 5.1 What every visitor downloads

Four surfaces fetch the entire static catalog in the browser: `index.astro:1119`,
`live-deals.astro:310`, `lists/[id].astro:846`, and `account.astro:408`. **Measured** transfer sizes:

| Payload | Rows | Bytes | gzip |
|---|---|---|---|
| As served today | 3,208 | 4.51 MB | **643 KB** |
| Same rows, minified | 3,208 | 3.38 MB | 584 KB |
| **Only published rows, only display fields** | **690** | **340 KB** | **58 KB** |

**11.1× more bytes than the page needs.** Two independent reasons, both fixable without touching
storage:

- **Row count.** The homepage draws published venues with a happy-hour window. There are 690. It
  downloads 3,208, of which 2,518 are unlisted claimable stubs that `getPublicVenues()` filters out
  and whose `ListedVenue` return type makes displaying them a type error rather than a policy.
- **Row width.** 32% of each row is scrape provenance no browse surface reads (§4.1).

Complexity: space shipped is `O(n)` per visitor, so total egress is `O(n · U)` — the only term in this
system that multiplies two growth axes. **Projected** at ten cities: 6,900 published venues at today's
projected shape is **579 KB gzip**; at today's *actual* shape it is **6.0 MB gzip**. The difference
between those two numbers is one build step.

### 5.2 The browser-side costs nobody has measured

Beyond transfer, the homepage does real CPU work over the full array:

- `getFilteredData()` chains six `.filter()` passes over `happyHours` on every keystroke, day change,
  neighborhood change and deal-type change (`index.astro:1260–1268`). `O(n)` per interaction. At 3,208
  rows this is imperceptible and it is a genuine product strength — the filtering feels instant
  because the data is local. At 30,000 rows across ten cities it is still only a few milliseconds,
  *provided the rows are the narrow projected shape*. Over full 1.4 KB rows it starts to be felt.
- `refreshVenueDirectory()` compares `JSON.stringify(refreshed) === JSON.stringify(happyHours)` — two
  full serialisations of the entire catalog — every time the page becomes active again
  (`index.astro`). That is 6.8 MB of string building per tab focus today (**measured** from the
  minified size × 2), and 60 MB at ten cities. `buildVenueStates()` and `venueStateSignature()` do the
  same over a map of every venue. These are `O(n)` string operations on the main thread and they are
  the reason a big catalog would feel sluggish long before it felt slow to download.

None of this is urgent. All of it disappears if the client is handed 690 narrow rows instead of 3,208
wide ones, which is why the projected payload is the highest-value change on the read side.

### 5.3 The neighborhood build quadratic

`getNeighborhoodProfiles()` in `src/lib/neighborhoods.ts` maps 54 profiles and, for each, filters the
full public venue set: `O(P · p)`. `neighborhoods/[slug].astro` calls it once in `getStaticPaths()`
and again at module scope for every page it generates, so the build does `O(P² · p)` work.

Today: 54² × 690 ≈ 2.0 million comparisons. Free. At ten cities with, say, 500 neighborhood profiles
and 6,900 published venues: **1.7 billion comparisons** (**projected**), perhaps 5–15 seconds of build
time doing nothing but re-deriving the same 500 lists 500 times. Hoisting it to a single grouped pass
(`Map<neighborhood, Venue[]>`, `O(p + P)`) is a ten-line change. It is not urgent, but it is the
cheapest algorithmic win in the codebase and it should be done when city two lands, not investigated
in a panic when a build slows down.

### 5.4 Alert matching

`runAlertDispatch()` in `src/lib/notify.ts` runs every 15 minutes. It loads all merged public venues,
filters to live ones, then for each user runs `liveVenues.filter(alertMatchesVenue)` per saved alert:
`O(A · L)` for `A` alert rules and `L` live venues, plus an `O(L)` `.find()` per list subscription
inside the per-user loop.

`L` is small and bounded — it is only venues live *right now*, so it barely grows with the catalog;
it grows with cities and time-of-day overlap. `A` grows with users. At 10,000 users averaging two
alerts and 300 live venues that is 6 million cheap predicate evaluations per dispatch: **projected**
well under a second, and irrelevant next to the network cost of actually sending the messages.

The real dispatch ceiling is not the matching. It is that the whole thing runs inside one 15-minute
scheduled function with a serial `await sendEmail(...)` per user. **Projected**: at 200 ms per
provider call, one function invocation can send roughly 3,000 messages before Netlify's function
timeout. The batching, leasing and dedup infrastructure to fix that already exists in
`0007_live_promotions_foundation.sql` (`notification_deliveries` with `notification_deliveries_lease_idx`)
— it is just not what `notify.ts` uses. **You will know it is time when a dispatch run starts timing
out or `usersNotified` stops tracking the number of matching users.** That is a five-figure-user
problem, not a today problem.

---

## 6. GitHub as a storage layer — specific failure modes

`src/lib/venueRepo.ts` reads and writes the whole catalog through the GitHub Contents API. This works
and it has earned its keep. Here is precisely where it stops.

### 6.1 The mechanism

`fetchVenues()` → `readRepoFile()` → `repos.getContent()`; over 1 MB, GitHub answers 200 with
`encoding: "none"` and empty content, so `github.ts` falls through to `git.getBlob()`. That fallback
was added in `6a1df4a` after every admin venue page died on `Unexpected end of JSON input`. It is
correct and the 100 MB blob limit is far away.

`commitVenues()` → `repos.createOrUpdateFileContents()` with the blob `sha`, so the write is
conflict-checked. `describeGitHubError()` turns the 409 into "Someone else changed this file first."

### 6.2 Rate limits, with the arithmetic

A personal access token gets **5,000 REST requests per hour** (primary). That is not the constraint.
The constraint is GitHub's **secondary** limit on content-generating requests: **no more than 80 per
minute and 500 per hour**, documented, and applying to REST, GraphQL and the web UI together.

Every venue edit is one content-generating request. So:

- **Ceiling: 500 venue edits per hour, site-wide, across all admins and all pipeline commits.**
- A pipeline run that commits after each of its stages competes for the same 500.
- Exceeding it returns 403 or 429 with a `retry-after` header. `describeGitHubError()` handles the
  rate-limit 403 correctly (it checks `x-ratelimit-remaining`) but **there is no retry and no queue** —
  the admin sees an error and their edit is lost.

500 edits/hour is not close today. It becomes close during a bulk cleanup, and it is a hard ceiling on
any future "approve 200 pending claims" batch operation.

### 6.3 Latency

Each edit is two or three round trips to GitHub: `getContent`, possibly `getBlob`, then
`createOrUpdateFileContents` with a 4.5 MB base64 body (6.0 MB after base64 expansion). **Projected**
from typical GitHub API latency plus payload size: 1.5–4 seconds per save today, and roughly 10–30
seconds at ten cities when the body is 42 MB and base64 makes it 56 MB. GitHub terminates any request
it has not processed in 10 seconds, which means **a 42 MB catalog write is at genuine risk of timing
out on GitHub's side** — a failure mode that does not exist today and appears somewhere around
20–30 MB, or roughly 15,000–20,000 listings. That is the real GitHub ceiling, and it arrives well
before the 100 MB blob limit that §4.2 measures.

### 6.4 Concurrency — the failure modes, specifically

**There is one lock and it covers all 3,208 rows.** Consequences, in increasing order of how much they
will annoy someone:

1. **Two admins editing two unrelated venues in the same minute:** the second `createOrUpdateFileContents`
   409s because the sha moved. The second admin is told to reload and try again. Their form data is
   still in the browser, so they lose seconds, not work. Annoying, survivable.
2. **An admin editing anything while a pipeline run commits:** the pipeline writes the file from the
   command line, the admin's stale sha 409s. During a large discovery job that commits per stage, the
   admin editor is unusable for the duration. Nobody has hit this yet because runs happen overnight.
3. **A pipeline run and an admin edit interleaving on the same second:** the pipeline does not read
   through `venueRepo`; it reads the local working tree and commits with git. It has no sha check
   against what the admin just wrote through the API. **An admin edit committed via the API during a
   run is silently reverted by the run's own commit.** This is the one genuine lost-update path and it
   is invisible — no error, no conflict, the edit simply is not there afterwards. Two agents editing
   the catalog concurrently, which is the situation in this repository *right now*, is exactly this
   scenario.
4. **`appendVenue()` allocates `max(id) + 1`** over the file it just read. Two concurrent submission
   approvals both read the same max and both mint the same id. The second write 409s, so this is
   caught today — but it is caught by the coarse lock, not by anything about ids, and it is the reason
   the id strategy cannot be decentralised while the file is the store.

Failure mode 3 is the argument that matters. It is not "this is inelegant"; it is "there is a data
loss path with no error message and you have already created the conditions for it."

### 6.5 Complexity

A single-field edit costs `O(n)` bytes in, `O(n)` bytes out, and `O(n)` git storage forever. It should
cost `O(1)`. At 3,208 rows that is a 4.5 MB round trip to change a phone number. At 30,000 it is 42 MB.

---

## 7. The database — what is there, and what it would cost to make it canonical

### 7.1 What Postgres holds today

55 tables, 102 indexes, no `venues` table. Connection pool `max: 5` per function instance
(`src/lib/db.ts`), against Neon's pooled endpoint, which is the correct shape for serverless.

The indexing is good. `users_status_created_idx (account_status, created_at DESC, id DESC)`,
`promotion_campaigns_active_window_idx`, `notification_deliveries_lease_idx`, GIN indexes on
`alerts.filters` and `happy_hour_menu_items.search` — somebody has thought about query plans. This is
not a database that is about to fall over.

### 7.2 What it would cost to move the catalog in

`docs/data-architecture.md` §5 lays out a four-phase migration (mirror, cutover, indexes, multi-city)
and estimates 3–5 weeks. Having now looked at the rest of the infrastructure I would keep the phases
and revise the framing in two ways:

**The migration is smaller than that doc thinks**, because §4.3 above is true: the override layer has
already migrated the fields that change. What remains to move is the immutable spine of a venue —
identity, coordinates, provenance — which nobody edits and which therefore has no concurrency problem
to design around.

**But it is also less urgent than that doc implies**, because the file is not the binding constraint
(§4.2), and three of the four things it would fix are fixable without it:

| What the migration fixes | Can you get it without migrating? |
|---|---|
| `O(1)` single-venue edits, no whole-catalog lock | No. This needs row storage. |
| Client payload 643 KB → 58 KB | **Yes** — a build step emitting a projection. Days. |
| Catalog out of every serverless function | **Yes** — a lazy accessor behind `getVenues()`. Days. |
| Git history stops carrying the catalog | Partly — and the images are 150× more history than the catalog is. |
| Indexed search and faceted filters | **Yes** — search can move to Postgres alone (§9). |
| `city` column, per-venue timezone, namespaced ids | Mostly. Multi-city is a schema problem eventually. |

So the honest recommendation is: **the Postgres migration is right, and it should not be first.** Do
the payload projection, the function unbundling, the image cleanup and the pipeline concurrency first
— all of which are days rather than weeks, all of which pay off immediately, and none of which are
wasted work if the migration happens.

### 7.3 Users and writes

**Pagination.** `/api/admin/users` is correctly keyset-paginated with a `(created_at, id)` cursor
after the fix in `e31b8f2`. It is the only paginated list endpoint in the codebase. The others are
not broken in the same way — they are not paginated at all:

| Endpoint | Behaviour | Fine until |
|---|---|---|
| `/api/admin/restaurants` | `listVenueClaims()` returns **every** claim ever filed, then does a per-claim `getMerchantEntitlement()` — an `N+1` of one query per verified claim | ~1,000–2,000 claims |
| `/api/admin/photos` | Unbounded photo list | ~5,000 photos |
| `/api/admin/submissions` | Unbounded submission list | ~5,000 submissions |
| `/api/restaurant/venues` | Scores all `n` venues, full sort, `slice(0, 8)` | Works; wasteful (§9) |

The `/api/admin/restaurants` `N+1` is the one to watch, because it is `1 + V + C` queries for `V`
distinct users and `C` verified claims and the claim table is the one that grows with commercial
success. **You will know** when the admin restaurants page takes more than two seconds to load.

**A latent index mismatch worth checking.** `adminUsers.ts` orders by
`date_trunc('milliseconds', u.created_at) DESC, u.id DESC`, but the supporting index
`users_status_created_idx` is on `(account_status, created_at DESC, id DESC)` — the raw column, not
the truncated expression. Postgres will not match an index to a function of an indexed column, so
this almost certainly plans as a full sort of the filtered user set on every page load, keyset cursor
notwithstanding. That is invisible at hundreds of users and a full sort of 100,000 rows per "Load
more" click at scale. This is **reasoned from the schema, not measured** — I did not run the query.
Confirm with:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT u.* FROM users u
ORDER BY date_trunc('milliseconds', u.created_at) DESC, u.id DESC
LIMIT 51;
```

If it says `Sort` rather than `Index Scan`, the fix is an index on the expression, or dropping
`date_trunc` and widening the cursor to microsecond precision. The `date_trunc` is there because a JS
`Date` cursor only carries milliseconds, which is a real problem with a cheaper solution.

---

## 8. Build and deploy

### 8.1 Measured, at 3,208 venues

`npx astro build` on this machine, 31 August 2026 (**measured**):

| Phase | Time |
|---|---|
| Static page generation | 15.34 s |
| Rearranging server assets | 20.07 s |
| Server build total | 31.14 s |
| **Wall clock** | **34.86 s** |

Output: **12,935 `index.html` files** (**measured**, `find dist -name index.html | wc -l`), of which
12,832 are venue pages. That is **four pages per venue**, not two:

| Route | Pages | Prerendered because |
|---|---|---|
| `/venues/{slug}/` | 3,208 | The product. Correct. |
| `/admin/venues/{slug}/` | 3,208 | `getStaticPaths` over all venues — and the page discards its build-time values and re-fetches from GitHub once authenticated |
| `/restaurant/manage/{slug}/` | 3,208 | `getStaticPaths()` returns `getVenues().map(...)` |
| `/restaurant/manage/{slug}/users/` | 3,208 | Same |

**Three quarters of the prerendered pages are authenticated dashboards whose content is fetched
client-side after login.** 15.34 s ÷ 12,935 = **1.19 ms per page** (**measured**), so roughly 11.5
seconds of every build produces HTML that no logged-out visitor will ever request and no logged-in
user will read before it is replaced. Converting those three routes to `prerender = false` would cut
static generation by ~75% and remove 9,624 files from every deploy. It would also be a small security
improvement, since those routes currently emit a static page per venue to a public CDN.

### 8.2 When does the Netlify build time out?

Netlify's default build time limit is **15 minutes**, raisable to 30 via the API and to 60 by asking
support. Post-processing and upload get additional time beyond that.

**Projected**, holding 1.19 ms/page and scaling the fixed ~20 s of bundling and asset rearranging:

| Venues | Pages (4/venue) | Static gen | Wall clock | Pages (1/venue) | Wall clock |
|---|---|---|---|---|---|
| 3,208 | 12,832 | 15 s | **35 s** (measured) | 3,208 | ~24 s |
| 10,000 | 40,000 | 48 s | ~1.5 min | 10,000 | ~45 s |
| 30,000 | 120,000 | 143 s | ~4–6 min | 30,000 | ~1.5–2 min |
| 100,000 | 400,000 | 476 s | ~12–20 min | 100,000 | ~4–6 min |

So the **build timeout is reached somewhere around 80,000–100,000 venues at four pages each, or well
past 200,000 at one page each** — and both estimates should be treated as optimistic, because Astro's
asset-rearranging phase (20 s of the current 35 s) is not obviously linear and hundreds of thousands
of small files stress the filesystem in ways this extrapolation does not model. Raising the limit to
30 minutes is one API call, so the practical answer is that **build duration is not the constraint
anyone should be planning around.**

**What breaks first in the build is not time.** It is:

1. **Netlify's 54,000-files-per-directory limit.** `dist/venues/` is one flat directory. At ~54,000
   venues the deploy fails. Per-city routing (`/{city}/venues/{slug}/`) removes this entirely, which
   is another reason the city dimension is worth deciding early.
2. **Deploy size.** `dist/` is already 1.1 GB, 900 MB of which is images (§2). Netlify uploads only
   changed files, so this is a first-deploy and image-batch problem rather than a per-deploy one — but
   it is why §2 comes first in this document.
3. **Build coupling.** This is the real cost and it is not a threshold. A one-word typo fix in one
   venue's deal text currently rebuilds 12,832 pages, and the correction is not live until that
   finishes. The live-override layer (§4.3) exists precisely to route around this for the fields
   people edit most, which is the system telling you the answer.

### 8.3 Serverless function size — a correction

`docs/data-architecture.md` §2.4 reports the SSR function directory at 78 MB and calls Netlify's
250 MB unzipped limit "no longer theoretical." **That is measuring the wrong thing.**
`.netlify/v1/functions/ssr/` is 78 MB locally, but 64 MB of that is `.data/images/`, the
gitignored local-disk fallback that `imageStore.ts` uses under `astro dev` and which does not exist
in a Netlify build. **Measured**, excluding it:

| | Size |
|---|---|
| SSR function, unzipped, excluding `.data/` | **10.5 MB** (limit 250 MB) |
| SSR function, zipped | **2.56 MB** (limit 50 MB) |

That is 4% of the unzipped limit and 5% of the zipped one. **There is no function size problem.** The
78 MB and 47 MB figures in the older document are local development artifacts.

What *is* real:

- `chunks/happy-hours_*.mjs` is **3.71 MB** of generated JavaScript inside that 10.5 MB, because
  `src/lib/venues.ts` line 1 is a static `import` of the JSON and Vite inlines it. 43 source files
  import `venues.ts`, including every `/api/account/*` route, so signing in parses a venue catalog.
  **Measured** `JSON.parse` cost: 8–12 ms per cold start.
- The three scheduled functions are **13.9 MB, 13.9 MB and 14.1 MB** (**measured**,
  `.netlify/functions-serve/*/netlify/functions/*.mjs`) and `dispatch-alerts.mjs` contains 2,792
  occurrences of `placeId`, so all three embed the whole catalog through a transitive import.
  `dispatch-merchant-reports` has no business knowing what a venue's Google place ID is.

**Projected** at 30,000 venues: the chunk is ~35 MB, parse ~100 ms, SSR function ~42 MB unzipped.
Still inside 250 MB. This is a tidiness problem and a cold-start-latency problem, not a limit problem.
Fixing it — a lazy accessor behind `getVenues()` so the JSON is imported only where it is used — is
worth a day for the cold-start win and for breaking the transitive chain, not because anything is
about to fail.

---

## 9. Search

`src/lib/venueSearch.ts` is a token-containment scorer: normalise, drop stopwords, require every token
to appear in `name + neighborhood + address`, score 10 for a name hit and 1 otherwise, +20 for a
collapsed substring match on the name. `/api/restaurant/venues` runs it over every venue, sorts all
scored rows, and returns eight.

**What is good about it:** it is 38 lines, it has no dependencies, it is deterministic, and it is
correct for the job it does — finding your own restaurant in a claim dashboard, where you know the
name. Nobody should replace it with Elasticsearch.

**What is wrong with it:**

- `O(n log n)` to return 8 results, re-executed per keystroke, inside a function that just parsed a
  3.7 MB catalog to answer it. The sort is pure waste — a partial selection is `O(n log 8)`.
- **No fuzzy matching.** `venueMatchesQuery` requires *every* token to be a substring. "Ironside Fish"
  finds Ironside Fish & Oyster; "Ironsyde" finds nothing; "Fish Oyster Ironside" finds it (order does
  not matter) but "Ironsides" does not. For a claim dashboard where the owner knows their own name,
  that is acceptable. For any consumer-facing search it is not.
- **It does not search deals.** The homepage's `matchesSearch` is separate, client-side, and also
  substring-based.

**Does it survive multi-city?** Mechanically yes — it is linear and linear over 30,000 rows is
sub-millisecond. Semantically no: with ten cities, "The Pub" matches thirty venues in thirty cities
and the scorer has no notion of proximity or locality to rank them. **The thing that breaks about
search at multi-city scale is relevance, not speed**, and no amount of indexing fixes relevance
without a city or location filter to scope it. That filter is the `city` column again.

**Realistic options, in order of increasing cost:**

1. **Partial selection instead of a full sort.** Ten lines. Do it whenever someone is in the file.
2. **Postgres `pg_trgm` GIN index on name and address.** Gives fuzzy matching and `O(log n + k)`
   lookup, removes the catalog parse from the search path, and — importantly — this is the one part
   of the venue record that would have to live in Postgres for it to work, which makes it a natural
   first slice of the §7 migration rather than a detour. `happy_hour_menu_items` already has a GIN
   search index, so the pattern exists in this codebase. A few days.
3. **A hosted search index** (Algolia, Typesense, Meilisearch). Better relevance, typo tolerance,
   faceting and geo-ranking out of the box. Costs money, adds a sync path that can drift, and adds a
   third place venue data lives. **Not worth it until consumer-facing search is a product priority**,
   and probably not until several cities are live.

Recommendation: (1) now, (2) as the opening move of the database migration, (3) only when someone can
name a user complaint it solves.

---

## 10. Where this document disagrees with `docs/data-architecture.md`

That document is largely right and its recommendation — Postgres canonical, JSON as an uncommitted
build artifact, prerendering preserved — is the recommendation here too. Four corrections:

| Claim there | Correction |
|---|---|
| "`git gc` should reclaim most of the 719 MB. A housekeeping problem wearing a scalability problem's clothes." | The 700 MB of loose objects is 1,209 committed image blobs, not garbage. `git gc` will pack them, not remove them, and JPEG/PNG do not compress. It is a scalability problem wearing housekeeping clothes. §2.2 |
| "The SSR function directory unzipped — 78 MB (Netlify's limit is 250 MB)... the unzipped function limit stops being theoretical." | 64 MB of that is the local-only `.data/images` fallback. The real function is 10.5 MB unzipped, 2.56 MB zipped. No limit is in sight. §8.3 |
| "Pages prerendered per venue is two." | Four. `restaurant/manage/[slug]` and `restaurant/manage/[slug]/users` also enumerate every venue. 12,935 HTML files total. §8.1 |
| "The file grew 66% in two days... nobody has a reliable estimate of next month's." | The file has since shrunk to 4.51 MB. Growth is driven by import runs, not elapsed time, and import runs are scheduled by a human. The slope argument does not hold. §4.1 |

One thing that document flagged as an open question is now answered: `SD_TIME_ZONE` is imported by
**two** modules (`sanDiegoTime.ts`, `promotionClientTime.ts`), not seventeen (**measured**). The
per-venue timezone work for multi-city is much smaller than feared.

---

## 11. Recommended sequence

### 11.1 Now — this week, before the next import run

Nothing here is a migration. All of it is days, all of it pays off immediately, and none of it is
wasted if the database migration happens later.

1. **Delete the 206 duplicate images.** 239.9 MB, one afternoon, no risk. §2.2
2. **Switch menu-board rendering to WebP and re-encode the 357 PNGs.** **Projected** 400 MB → 30–50 MB.
   `@napi-rs/canvas` already does it. §2.4
3. **Emit a projected browse payload** — published rows, display fields only — and point the four
   client `fetch` calls at it. **Measured** effect: 643 KB → 58 KB gzip, an 11× reduction on the
   homepage, `/live-deals`, `/lists/*` and `/account`. Roughly a day. Leave `happy-hours.json` exactly
   where it is. §5.1
4. **Add `mapPool` concurrency to `extract-happy-hour.mjs`**, grouped by domain, following the pattern
   `refresh-happy-hour.mjs` already uses. **Projected** 8.95 h → 1.0–1.5 h per city. Perhaps a day of
   work for a permanent 8-hour saving per city. §3.2
5. **Write a `city` value on every new row**, even hardcoded `"san-diego"`. Free at import; a
   coordinate-inference exercise with a silent failure mode afterwards. §12
6. **Decide the commit policy for the next import run.** Every catalog commit is ~0.6–1 MB of
   permanent pack growth and one of GitHub's 500 hourly content-generating requests. Commit once at
   the end, not once per stage.

### 11.2 Before city two

**Complete the image-egress gate before beginning a second city.** The current homepage inserts
every matching card into the DOM and relies only on native image lazy-loading. A weekday can produce
more than 600 cards, so a deep scroll can turn one session into hundreds of image deliveries. Before
multi-city expansion:

- scope the browse dataset and results to the selected city;
- render the first 24–36 cards, then append bounded pages or virtualized batches;
- generate responsive 400px, 600px and 800px card sources and declare `srcset`/`sizes`;
- keep ordinary card variants in a 50–100 KB target range, with larger hero variants loaded only on
  venue pages;
- use immutable, content-addressed asset URLs with long browser cache lifetimes;
- ensure every stored image path can use the optimized delivery path rather than serving an original
  Blob or full-resolution upload directly;
- measure images and transferred bytes per session, alert on image bandwidth, and rate-limit abusive
  crawlers; and
- evaluate the R2 image architecture in §14 before projected image delivery exceeds 1 TB/month, or
  earlier if image egress becomes a material share of the Netlify bill.

7. **Move pipeline images to Netlify Blobs**, behind the existing `/api/images/` route. New images
   stop entering git history. Then `git filter-repo` the old ones out, once, deliberately. This is
   the item that must not slip past city three. §2.4
8. **Parameterise the pipeline cache directory by city** so two runs can proceed at once. Same change
   as item 5, really. §3.2
9. **Drop `prerender` from the three admin and merchant venue routes.** Removes 9,624 files and ~11 s
   from every build, and stops publishing a per-venue page for authenticated dashboards. §8.1
10. **Break the catalog out of the scheduled functions** with a lazy accessor. Three functions at
    14 MB become three functions at a few hundred KB. §8.3
11. **Hoist the neighborhood grouping** out of the `O(P²·p)` shape. Ten lines. §5.3
12. **Partial selection in the claim search** instead of a full sort. Ten lines. §9

### 11.3 The database migration, when the above is done

13. **Phase 1 — mirror.** A `venues` table plus a `venue_audit` table, dual-written by the pipeline,
    with a `venues:diff` script in CI. Nothing reads from it. Ships value on its own: venue data
    becomes queryable for the first time.
14. **Phase 2 — search first.** `pg_trgm` GIN index on name and address; point `/api/restaurant/venues`
    at it. This is the smallest possible slice that proves the mirror is trustworthy in production,
    and it fixes a real defect. §9
15. **Phase 3 — cutover.** `prebuild` generates the artifact from Postgres; the file leaves git; the
    admin editor writes rows with optimistic locking on `updated_at`; `venueRepo.ts` is deleted.
    `docs/data-architecture.md` §5.2 has the detailed sequencing and it is right.
16. **Phase 4 — multi-city.** `city` column enforced, per-city routing, per-venue timezone (a
    two-module change, not seventeen), per-city build shards.

### 11.4 Defer indefinitely

- Replacing the `O(n)` array scans with indexes for their own sake. Measured at microseconds.
- A hosted search product. §9
- Sharding the catalog file. It is the right *output* shape and the wrong storage answer, and it fixes
  none of the concurrency problems.
- Dropping prerendering for venue pages. Ten seconds of build buys permanent immunity to cold starts,
  database outages and slow queries on the entire SEO surface. It is the best trade in the system.

---

## 12. How you will know

The observable symptom that should trigger each deferred piece of work. Check these rather than
re-litigating the analysis.

| Watch for | Means | Do |
|---|---|---|
| `du -sh .git` over 1.5 GB, or a clone taking over 3 minutes | Images are compounding | §11.2 item 7, urgently |
| GitHub emails about repository size, or a push warning | Past 5 GB soft limit | Same, and it is now expensive |
| An import run over 12 hours | Extract concurrency still 1, and the catalog has grown | §11.1 item 4 |
| Two people report "someone else changed this file first" in a week | Concurrent-editor ceiling reached | Bring the Phase 3 cutover forward |
| An admin edit that vanishes with no error | Failure mode §6.4(3): a pipeline commit overwrote an API write | Stop running the pipeline while anyone is editing; prioritise cutover |
| A venue save taking over 5 seconds, or a 502 from GitHub on save | Catalog write approaching GitHub's 10 s request ceiling — expect this near 20–30 MB, ~15,000 listings | Cutover is now urgent, not optional |
| 403 with `x-ratelimit-remaining: 0` on save | Past 500 content-generating requests/hour | Batch pipeline commits; cutover |
| `happy-hours.json` over 35 MB | Push warning territory | Cutover; the file is genuinely at its limit |
| Netlify build over 10 minutes | Page count, or the asset phase going non-linear | Raise the limit to 30 min (one API call), then §11.2 item 9 |
| A deploy failing on file count | 54,000 files in `dist/venues/` | Per-city routing, §11.3 item 16 |
| `/admin/restaurants` taking over 2 seconds | The `N+1` over verified claims | Paginate it |
| "Load more" on `/admin/users` slowing as the table grows | The `date_trunc` index mismatch in §7.3 | Run the `EXPLAIN`; index the expression |
| Homepage payload over 300 KB gzip | The projection was never built, or it regressed | §11.1 item 3 |
| A dispatch run timing out, or `usersNotified` plateauing | Serial sends in one scheduled function | Move to the `notification_deliveries` leasing queue that `0007` already provides |
| Users searching and not finding venues they can see on the map | Substring matching, not a speed problem | `pg_trgm`, then consider a search product |

---

## 13. Open questions

- **Should `hhMenu` remain in the catalog** now that `happy_hour_menus` (`0018`) is a normalised table?
  310 venues have both. Two stores for one thing is how they drift.
- **Are the 536 menu board images worth 374 MB** given that the underlying menu is already structured
  data in Postgres? Rendering them at request time, or at CDN edge, may be strictly better than storing
  them.
- **Does the pipeline actually need offline capability**, or is it a benefit we would list in a review
  and never use? It is the main thing the Postgres migration costs. Worth answering honestly before
  spending a week preserving it.
- **What is the right shard boundary for the build artifact** — city, neighborhood, or
  browse-versus-detail? Probably all three, but nobody has measured which one buys the most.
- **Is `/restaurant/manage/{slug}/` prerendering a disclosure problem** as well as a build cost? It
  emits a page per venue to a public CDN. Somebody should read what is actually in that HTML.
- **What does `validate-data.js` catch that a database constraint would not?** The stub rules look
  expressible as a table `CHECK`; the nested `jsonb` shapes look like they want to stay in TypeScript.
  Classifying all 197 lines is the real design work of migration Phase 1.

---

## 14. Multi-city gate: image egress

This section is a prerequisite, not a future optimization. It was measured on 1 September 2026 in
response to the decision to own and serve durable venue images rather than pay a third party for
each live photo render.

### 14.1 What the homepage does today

`src/pages/index.astro` renders every venue that survives the current filters into one
`grid.innerHTML`. There is no pagination, incremental batch size or virtualization. Images do have
native `loading="lazy"`, so a browser normally fetches only a margin around the viewport and then
continues as the visitor scrolls. That prevents an immediate full-catalog download, but a complete
scroll eventually loads almost every unique image in the result set.

The card path requests one 800px-wide, quality-80 Netlify Image CDN transform. It does not provide
`srcset` or `sizes`, so a small phone and a high-density desktop card request the same nominal width.
Two published Blob-backed images currently bypass the transform and can deliver original-resolution
bytes. The fallback chain does not normally duplicate requests: original and stock fallbacks load
only after an error.

Measured against the current published catalog:

| Session shape | Cards in results | Unique image requests on complete scroll | Approximate optimized card bytes |
|---|---:|---:|---:|
| Tuesday | 620 | 524 | 39.9 MB |
| Saturday | 254 | 206 | 15.2 MB |
| Typical visitor viewing about 20 cards | 20 | roughly 20 | 1.5–2 MB |

The representative transform was 800px WebP at quality 80 over the exact current unique source set.
Its median was 73.8 KB and p90 was 118.7 KB. Netlify may serve AVIF to capable browsers, so production
transfer can be lower; direct originals and remote images can make it higher.

The page also fetches the entire catalog before rendering. `happy-hours.json` is currently 6.73 MB
uncompressed, about 0.67 MB gzip or 0.44 MB Brotli. That is egress too, and it grows with every city
even when a visitor only wants one market. City-scoped browse payloads are therefore part of the
image-egress fix rather than a separate cleanup.

### 14.2 Cold-session scale model

The useful equation is:

```
monthly image GB = sessions × images actually loaded × average transferred KB / 1,000,000
```

Browser caching can make repeat visits on one device cheaper. These figures deliberately model cold
sessions so expansion planning does not depend on repeat visitors retaining a cache:

| Monthly activity | Approximate image egress |
|---|---:|
| 10,000 ordinary sessions at 2 MB | 20 GB |
| 100,000 ordinary sessions | 200 GB |
| 1,000,000 ordinary sessions | 2 TB |
| 10,000 complete Tuesday scrolls | 399 GB |
| 100,000 complete Tuesday scrolls | 3.99 TB |

On Netlify's current credit-based plans, bandwidth consumes 20 credits/GB and web requests consume
2 credits per 10,000. Pro starts at $20/month with 3,000 credits; additional 1,500-credit packs are
$10. On that model, 100,000 ordinary 2 MB sessions are roughly a $30/month total-plan shape if image
delivery dominates usage; one million are roughly $300/month. Deep-scroll and crawler traffic can be
materially higher because hundreds of requests accompany the extra bytes. These are planning
figures, not a quote: HTML, JSON, JavaScript, functions and deployments use the same pool.

Accounts created before 4 September 2025 may still use legacy pricing. Legacy Pro includes 1 TB of
bandwidth before overage, while the newer plans use credits. Check the actual team billing dashboard
before changing plans; moving from a legacy plan is irreversible.

Current pricing references:

- [Netlify pricing and included credits](https://www.netlify.com/pricing/)
- [How Netlify credits and bandwidth are measured](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/)
- [Netlify legacy-plan details](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-legacy-plans/legacy-pricing-plans/)

### 14.3 Required implementation before expansion

1. **City-scope the browse payload.** A visitor gets only the selected city's published display
   fields, not the national catalog.
2. **Bound card creation.** Render 24–36 results initially and append another bounded page when the
   visitor approaches the end. Preserve filters and result count without keeping thousands of card
   elements alive.
3. **Generate variants at ingestion.** At minimum: 400px, 600px and 800px card widths plus a dedicated
   hero. Prefer AVIF/WebP where supported and enforce the 50–100 KB ordinary-card budget.
4. **Declare responsive intent.** Add `srcset` and `sizes`; do not make a 360px phone download an
   800px asset by default.
5. **Make caching durable.** Use content-hashed paths and `public, max-age=31536000, immutable` for
   stored variants. A replacement produces a new URL instead of invalidating the old object.
6. **Unify the media path.** Static, pipeline and owner-uploaded photos must all receive the same
   variants. Do not send full-resolution Blob originals to cards.
7. **Remove avoidable work.** Eliminate the homepage's duplicate startup grid render and debounce
   search/filter rebuilds. Browser caching limits repeat bytes, but it does not fix the DOM, CPU or
   aborted-request cost.
8. **Instrument and defend.** Record image requests and bytes per session, watch Netlify bandwidth,
   and rate-limit crawlers that enumerate the full catalog or image namespace.

### 14.4 When and how to move images to Cloudflare

Netlify is acceptable for the first cities once the preceding controls are in place. Re-evaluate the
delivery layer when any of these is true for two consecutive months:

- image delivery exceeds 1 TB/month;
- image bandwidth is more than roughly 25% of the platform bill;
- crawler traffic is producing a material share of transfers; or
- the next-city forecast would require repeatedly purchasing bandwidth credits.

The scale architecture keeps the application on Netlify and moves only media:

1. Store originals in a private Cloudflare R2 bucket.
2. Generate the standard card and hero variants during ingestion, rather than paying to transform
   arbitrary widths on every request.
3. Publish immutable variants through a dedicated asset hostname such as `images.example.com`.
4. Store the asset key, dimensions, checksum, provenance and rights record with the venue.
5. Keep the existing local vibe fallback available if the media host is unavailable.

R2 currently charges for storage and operations but not internet egress. Its Standard tier includes
10 GB storage and 10 million Class B reads monthly, after which reads are $0.36 per million. For a
few thousand pre-generated assets, storage is negligible and requests—not transferred bytes—become
the principal media-delivery meter. Cloudflare Images can sit in front when dynamic transformation
is needed; the first 5,000 unique transformations are currently free and later transformations are
$0.50 per 1,000 unique variants, not per delivery.

- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare Images pricing](https://developers.cloudflare.com/images/pricing/)

Do not migrate merely because R2 advertises zero egress. First make the application request fewer,
smaller and cacheable images. Otherwise the move hides an inefficient homepage behind a cheaper
meter while leaving its browser-performance problem intact.
