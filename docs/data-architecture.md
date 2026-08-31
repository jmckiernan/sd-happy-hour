# Data architecture: where venues should live

Why the venue catalog is a JSON file committed to git, what that costs as the dataset grows, and
what to do about it. Written in answer to a direct question:

> Why do we need a large JSON file that holds all of the venue data? All of that is in the database,
> right? Can't we just use the database for the JSON file too? Should we really be storing stuff in
> GitHub? I want to make this entire infrastructure relatively scalable so that we can move to
> multiple cities and eventually have many thousands of venues and users. Everything needs to be
> fairly robust as far as time and space complexity.

The short answer to "is it already in the database" is **no** — and that is the single most
important fact in this document. Postgres holds everything *about* venues (claims, publications,
photos, promotions, menus, overrides, saved lists, alerts, activity) and nothing that *is* a venue.
There is no `venues` table. The 55 tables in `migrations/` key on `venue_id integer` with a comment
saying, in `0004_venue_content.sql`:

> Not a foreign key: venues live in happy-hours.json, not in this database.

So this is not a question of consolidating two copies. It is a question of whether to move the
catalog into Postgres for the first time.

Numbers below are marked **measured** or **projected**. Measured values were read off this machine
on 31 August 2026 at commit `c3252db`; projected values state their arithmetic so you can disagree
with the assumption rather than the number. For what each pipeline gate does, see
`docs/venue-pipeline-reference.md`. For the multi-city work this interacts with, see
`docs/porting-to-a-new-city.md` §3.

---

## 1. The honest case for the current design

The JSON file is not an accident, and most of the reasons it exists are still good reasons.

**Prerendering is the product.** `src/pages/venues/[slug].astro` sets `prerender = true` and enumerates
every venue in `getStaticPaths()`. That produces one static HTML file per venue at build time. The
consequence is that the entire SEO surface of the business — the thing that makes a directory
site work at all — is served as flat files from a CDN with **zero database queries at request time,
zero cold starts, and zero possibility of a slow query taking down a venue page**. A directory
whose value is being found in search results wants exactly this. It is the correct architecture for
the read pattern, and no proposal below should be read as disputing it.

To build those pages you need the whole catalog in the build process. A file you can `import` is the
most direct way to have it.

**Version control of the data is a real feature, not a side effect.** Every change to the catalog is
a commit with a diff. That has already earned its keep — the owner has used git history to recover
from a bad merge, and `docs/venue-pipeline-reference.md` §8.2 records 99 venues that went live with
bad deal text, which was diagnosable precisely because the before and after were both in history.
Rollback is `git revert`. There is no equivalent one-command undo for a Postgres `UPDATE` that
touched 3,000 rows.

**The pipeline is offline-capable and cheap to iterate.** `merge.mjs`, `import-claimable-stubs.mjs`,
`purge-chains.mjs`, `clean-deal-text.mjs`, `classify-neighborhoods.mjs` and eight more scripts read a
file, transform an array in memory, and write the file back. No connection string, no transaction
scoping, no migration to run before you can try an idea. You can copy the file, run a
destructive-looking transform against the copy, and diff. That has made the pipeline unusually fast
to develop, and the development speed of the pipeline is where most of the value in this codebase
has come from.

**One write path enforces one contract.** `scripts/validate-data.js` (197 lines, **measured**) runs
after every write and checks the whole file. Because a write is always the whole file, the validator
can assert things a per-row database constraint cannot easily reach — id uniqueness across the
entire catalog, and the stub rules in §11.3 of the reference doc that *forbid* fields rather than
require them.

**It is genuinely simple.** No connection pooling in the build, no N+1, no query planner. `getVenues()`
returns an array.

Any migration has to preserve the first point, and should try hard to preserve the third and fifth.

---

## 2. What actually breaks at scale

### 2.1 The catalog grew 520× in five weeks

This is the fact that reframes everything else. From `git log` on the file itself (**measured**):

| Date | Size on disk |
|---|---|
| 2026-07-25 | 8.9 KB |
| 2026-08-13 | 15.4 KB |
| 2026-08-25 | 16.2 KB |
| 2026-08-26 | 532 KB |
| 2026-08-29 | 2.80 MB |
| 2026-08-30 | **4.63 MB** |

Note the brief given for this review said 2.7 MB and 3,208 listings. The listing count is right; the
file is now **4,634,784 bytes** (**measured**), because the menu and provenance work landed after
that figure was taken. The file grew 66% in the two days it took to notice it had a problem. Every
projection below should be read with that slope in mind: the constraint is not the current size, it
is that nobody has a reliable estimate of next month's.

### 2.2 The 1 MB GitHub limit, already hit

Commit `6a1df4a` fixed this on 30 August. GitHub's Contents API refuses to inline a file over 1 MB,
answering `200` with `encoding: "none"` and `content: ""`, so `venueRepo.fetchVenues()` handed
`JSON.parse` an empty string and every admin venue page died. The Blobs API fallback works and the
100 MB write limit is far away.

But note what the fix bought: it bought headroom, not a solution. The remaining ceilings are

| Limit | Value | Reached at | Basis |
|---|---|---|---|
| Contents API inlining | 1 MB | ~700 listings | Crossed. Now costs one extra request per read. |
| Git blob hard limit | 100 MB | **~69,000 listings** | 4,634,784 B ÷ 3,208 = 1,444 B/listing (**measured**), extrapolated linearly (**projected**) |
| GitHub push warning | 50 MB | ~35,000 listings | Same basis (**projected**) |

At 10 cities and 3,000 venues each, the file is **~43 MB pretty-printed** (**projected**, same
per-listing basis). That is inside the hard limit but past the push warning, and it is 43 MB
rewritten in full for every single-venue edit.

### 2.3 The homepage ships the entire catalog to every visitor

This is the most serious problem in the current design and it is not a future problem.

`src/pages/index.astro:1128`, `src/pages/live-deals.astro:310` and `src/pages/lists/[id].astro:846`
each do `fetch('/data/happy-hours.json')` from the browser. The static asset is served whole.
**Measured** transfer sizes:

| Payload | Rows | Bytes | gzip |
|---|---|---|---|
| As served today | 3,208 | 4.63 MB | **648 KB** |
| Same rows, minified | 3,208 | 3.29 MB | 573 KB |
| Provenance fields dropped | 3,208 | 1.53 MB | 244 KB |
| Only what browse displays | **690** | 0.50 MB | **80 KB** |

The homepage renders published venues that have a happy-hour window. There are **690** of those
(**measured**). It downloads 3,208 rows — of which 2,518 are unlisted stubs that no browse surface
can display, because `getPublicVenues()` filters them out and its `ListedVenue` return type makes
that a type error rather than a policy. So roughly **four fifths of the rows are unusable on the
surface that downloads them.**

It is worse than that, because of what is in each row. Field weight across the file (**measured**,
share of minified bytes):

| Field | Bytes | Share | Displayed on browse? |
|---|---|---|---|
| `lastScrape` | 0.64 MB | 19.6% | No — pipeline diagnostics |
| `hhSources` | 0.33 MB | 10.1% | No — provenance |
| `sourceUrl` | 0.32 MB | 9.8% | No |
| `hhMenu` | 0.22 MB | 6.7% | Venue page only |
| `address` | 0.14 MB | 4.3% | Yes |
| `website` | 0.13 MB | 3.8% | Venue page only |
| `placeId` | 0.08 MB | 2.4% | No |

`lastScrape` and `hhSources` alone are **30% of the file**, and they exist so a later pipeline run
can reason instead of guess. They are the right thing to keep. They are the wrong thing to send to a
phone on a cellular connection.

**The complexity framing the owner asked for applies directly here.** Space shipped is
`O(n)` bytes per visitor, so total egress is `O(n · U)` in venues times users — the one term in this
system that multiplies two growth axes together. At 10 cities the browse-only payload alone is
**~750 KB gzip** (**projected**: 80 KB × 6,500 published ÷ 690). At today's row shape it would be
6 MB gzip. This is the term that has to stop being `O(n)` regardless of which storage option is
chosen.

### 2.4 The catalog is compiled into every serverless function

Because `src/lib/venues.ts` line 1 is a static `import` of the JSON, Vite bundles it. **Measured**
from the build just run:

- `.netlify/build/chunks/happy-hours_C2ApWQNh.mjs` — **3.6 MB** of generated JavaScript
- The same chunk inside the SSR function — **4.1 MB**
- The SSR function directory unzipped — **78 MB** (Netlify's limit is 250 MB unzipped, 50 MB zipped)
- `dispatch-alerts.mjs`, `run-content-engine.mjs`, `dispatch-merchant-reports.mjs` — **14 MB each**,
  and `dispatch-alerts.mjs` contains 2,792 occurrences of `placeId`, so all three embed the catalog

Forty-three source files import `src/lib/venues.ts`, including every `/api/account/*` route. So a
request to log in pays for parsing a venue catalog. **Measured**: `JSON.parse` of the file is
8.5–12.1 ms. That is per cold start, on a function that had no reason to know venues exist.

At 30,000 venues the chunk is ~34 MB (**projected**, linear) and the parse ~100 ms, in a function
directory already at 78 MB. The unzipped function limit stops being theoretical.

### 2.5 Git repository growth — real, but slower than feared

Honesty is worth more than alarm here. **Measured**:

- 37 commits have touched the catalog; 39 distinct blobs exist
- Those blobs total **29.4 MB uncompressed**
- But `git count-objects -vH` reports **in-pack: 13.92 MiB** across 3 packs — for the *entire*
  repository, all files, all history

So git's delta and zlib compression is handling this better than a naive "every edit costs 4.6 MB"
model predicts. The projected steady-state cost is roughly **0.6–1 MB of permanent pack growth per
catalog commit** at today's size (**projected**, from the 648 KB gzip of one snapshot, allowing that
pretty-printed JSON with reordered rows deltas poorly).

There is a separate and more immediate finding: `du -sh .git` reports **719 MB**, but
`git count-objects` shows **3,600 loose objects, 527 prune-packable, and 83 pieces of garbage**
including 83 abandoned `tmp_obj_*` files. Nearly all of that 719 MB is loose objects awaiting
collection, not history. **A `git gc` should reclaim most of it** and costs nothing. Do that before
concluding git bloat is the problem — it is currently a housekeeping problem wearing a scalability
problem's clothes.

The genuine long-term concern stands: history growth is monotonic and unbounded, and at 43 MB per
snapshot a year of daily pipeline runs is a repository nobody can clone. But it is a 2027 problem,
not a this-week problem.

### 2.6 Whole-file read/write, and the lost update

`updateVenue()` in `src/lib/venueRepo.ts` reads all 3,208 rows, mutates one, and commits all 3,208
back. The write is conflict-checked — `createOrUpdateFileContents` takes the blob `sha`, and
`describeGitHubError` has a 409 branch that says "Someone else changed this file first. Reload the
page and try again."

So lost updates are *detected*, not prevented, and the blast radius is the whole catalog. Two admins
editing two unrelated venues in the same minute conflict, and one of them loses their work. Add a
pipeline run committing in the background and every concurrent admin edit fails. During the large
discovery job, the admin editor is effectively unusable — the pipeline holds the lock on all 3,208
rows because there is only one lock.

Complexity: a single-field edit is `O(n)` network transfer in, `O(n)` out, and `O(n)` git storage
forever. It should be `O(1)`.

### 2.7 Build time — measured, and less alarming than expected

**Measured**, `npx astro build` at 3,208 venues:

| Phase | Time |
|---|---|
| Static page generation | 10.04 s |
| Server build total | 21.19 s |
| Wall clock (`real`) | **23.59 s** |

Pages prerendered per venue is **two**, not one — `dist/venues` has 3,208 entries and
`dist/admin/venues` has 3,208 more, because `src/pages/admin/venues/[slug].astro` also sets
`prerender = true` and enumerates every venue. That is **6,416 venue pages in 10.04 s, or ~1.56 ms
per page** (**measured**).

Projected linearly (**projected** — the per-page cost has been stable, but Astro's asset-rearranging
phase and the filesystem cost of hundreds of thousands of small files are not guaranteed linear):

| Venues | Prerendered pages | Static gen | Wall clock |
|---|---|---|---|
| 3,208 | 6,416 | 10 s | 24 s |
| 10,000 | 20,000 | 31 s | ~50 s |
| 30,000 | 60,000 | 94 s | ~2.5–4 min |

A four-minute build is not a crisis. **The crisis is not build duration, it is build coupling**: a
one-word typo fix in one venue's deal text rebuilds 60,000 pages, and until that build finishes the
correction is not live. That is the argument for on-demand rendering of the long tail, not for
abandoning prerendering.

One quiet observation: prerendering 3,208 admin editor pages is nearly half the build, and those
pages immediately discard their build-time values and re-fetch from GitHub once authenticated (per
the comment in the file). That half of the build produces HTML that is overwritten before anyone
reads it.

### 2.8 Multi-city, which the data model cannot currently express

`docs/porting-to-a-new-city.md` §3.2 already documents this and it is unchanged. Restated because
it is the constraint that makes timing matter:

- **One global integer id sequence.** `build-staging.mjs` allocates `max(existing id) + 1` over the
  single file. Max id today is **3,504** with 3,208 rows (**measured**), so 296 ids have been
  retired. Two cities staged independently collide.
- **A flat `/venues/{slug}/` namespace.** `venueSlug.ts` disambiguates by appending neighborhood,
  then street, then id. "The Pub — Downtown" exists in thirty cities.
- **One timezone constant.** `SD_TIME_ZONE` in `sanDiegoTime.ts`, imported by 17 modules.
- **No city column anywhere**, in the file or in the 55 database tables.

The integer id is load-bearing far beyond the catalog. It is the join key in `venue_claims`,
`venue_publications`, `venue_overrides`, `venue_photos`, `promotions`, `live_overrides`,
`saved_spots`, `venue_follows`, `happy_hour_menus`, `venue_managers` and more. Whatever id strategy
gets chosen has to be chosen once.

---

## 3. Time and space complexity of the hot paths

The owner asked explicitly, so this is stated precisely — including where the answer is "this is
fine and not worth changing."

`n` is total venues, `p` published-with-schedule, `k` a result-set size, `U` concurrent users.

### 3.1 Today

| Path | Implementation | Time | Space | Measured at n=3,208 |
|---|---|---|---|---|
| Catalog load (`getVenues`) | Bundled module, parsed once per process | `O(n)` once | `O(n)` resident, per function instance | 8.5–12.1 ms parse; 3.6 MB chunk |
| `slugIndex()` | `buildVenueSlugMap` over all venues, memoized | `O(n)` once | `O(n)` | — |
| `getVenueById` | `Array.find` | `O(n)` | `O(1)` | 0.031 ms |
| `getVenueBySlug` | `filter` + per-row `venueSlug` | `O(n)` | `O(k)` | — |
| `getPublicVenues` | `filter` with `Set.has` on publications | `O(n)` | `O(p)` | 0.07 ms |
| Neighborhood page | `getPublicVenues` then compare `neighborhood` | `O(n)` | `O(k)` | — |
| Claim search (`/api/restaurant/venues`) | Score all rows, **full sort**, `slice(0, 8)` | `O(n log n)` | `O(n)` | — |
| Homepage filter (browser) | `filter` over parsed array, per interaction | `O(n)` per keystroke | `O(n)` in the tab | — |
| Client catalog fetch | Whole static file | `O(n)` transfer | **`O(n · U)` egress** | 648 KB gzip each |
| Single venue edit | Read file, mutate, write file | `O(n)` in + `O(n)` out | `O(n)` git, permanently | 4.63 MB per edit |
| Build | Prerender 2 pages per venue | `O(n)` | `O(n)` | 1.56 ms/page |

**Two honest conclusions from this table.**

First, **the `O(n)` scans are not the problem and fixing them is not the win.** 0.031 ms for a venue
lookup and 0.07 ms for a full public filter are free. Even at 30,000 venues they are 0.29 ms and
0.65 ms — still free. Anyone proposing this migration on the grounds that `Array.find` is `O(n)` is
optimising the wrong term. The array is small and CPU is fast.

Second, **the terms that actually hurt are the ones with a second factor.** `O(n · U)` client
egress, `O(n)` write amplification per edit, `O(n)` resident memory in every function instance
including ones that never touch venues, and `O(n)` git storage per commit forever. Those are the
ones to attack.

The one genuine algorithmic defect is the **claim search**: it sorts all 3,208 scored rows to return
8. That should be a partial selection (`O(n log 8)`) at minimum, and properly it is a text-search
problem that belongs in an index, not a linear scan re-executed per keystroke inside a function that
just parsed 3.6 MB to answer it.

### 3.2 Under each option

| Path | (a) JSON as-is | (b) Postgres canonical + build artifact | (c) Fully dynamic | (d) Sharded / islands |
|---|---|---|---|---|
| Venue page render | `O(1)` static file | `O(1)` static file | `O(log n)` query + cold start | `O(1)` static file |
| Venue lookup by slug | `O(n)` scan | `O(n)` scan at build, `O(log n)` at runtime | `O(log n)` B-tree | `O(n/shards)` |
| Neighborhood filter | `O(n)` | `O(log n + k)` index on `(city, neighborhood, status)` | `O(log n + k)` | `O(n/shards)` |
| Claim search | `O(n log n)` | `O(log n + k)` GIN trigram | `O(log n + k)` | `O(n/shards) log …` |
| Single venue edit | `O(n)` r/w | **`O(1)`** row update | `O(1)` | `O(n/shards)` |
| Client payload | `O(n)` all fields | **`O(p)` projected fields** | `O(k)` per page | `O(k)` or `O(p/shards)` |
| Function memory | `O(n)` embedded | `O(1)` — no import | `O(1)` | `O(n/shards)` |
| Build time | `O(n)` | `O(n)`, one query + N renders | `O(1)` | `O(n)` total, parallel per shard |
| Data history | `O(n)` per commit | `O(δ)` per change (audit rows) | `O(δ)` | `O(n/shards)` per commit |

The column that matters is (b), and the reason is the *third-from-last* row: build time stays `O(n)`
because prerendering is preserved, while every other term drops. You do not have to trade page
performance for write performance. That is the whole argument.

---

## 4. Options

### (a) Keep the JSON file as the source of truth

**Fixes:** nothing, but buys time cheaply. The Blobs fallback works; 100 MB is ~69,000 listings away.

**Costs:** every problem in §2 keeps compounding. The homepage payload gets worse with every venue
added, and it is already 8× larger than it needs to be. Concurrent admin edits stay unreliable and
become impossible during pipeline runs. The catalog stays compiled into every serverless function.
Multi-city stays impossible without a separate deployment per city.

**Migration effort:** zero.

**Verdict:** viable for one city and a few thousand venues. Not viable for the stated goal. But note
that a large part of the pain in §2.3 and §2.4 is fixable *within* option (a) — see §6, because that
is what should happen this week regardless of what gets chosen for the long run.

### (b) Postgres as source of truth, JSON as an uncommitted build artifact

The database becomes canonical. A `prebuild` step queries it and writes `public/data/happy-hours.json`,
which is gitignored. Astro's build reads that file exactly as it does today. Pipeline scripts and
the admin editor write rows, not files.

**Fixes:**
- Single-venue edit becomes an `O(1)` row update with row-level optimistic locking on `updated_at`.
  Two admins editing different venues no longer conflict at all; a pipeline run no longer locks out
  the admin editor.
- The GitHub read/write path for venues disappears, and with it the 1 MB limit, the Blobs fallback,
  the token expiry failure mode, and the rate limit. `src/lib/venueRepo.ts` goes away.
- Git history stops carrying the catalog. Repository growth becomes bounded by source code again.
- The build artifact can be *projected*, so the browse payload carries `p` rows and only the fields
  that render — the 80 KB rather than the 648 KB.
- The artifact does not have to be one file. Per-city and browse-vs-full splits are a query change,
  not an architecture change.
- Claim search, neighborhood filtering and any future faceted search become indexed queries.
- A `city` column, a per-venue `timezone`, and namespaced ids become ordinary schema work.
- The catalog stops being bundled into `/api/account/*`, because runtime venue reads become queries.

**Costs:**
- **The git audit trail has to be deliberately rebuilt.** This is the real loss and it should not be
  waved away. See §5.4.
- Pipeline scripts need a connection. They stop being runnable on a plane. Mitigable with an
  `export` / `import` pair, and worth building for exactly that reason.
- `validate-data.js` splits into database constraints plus a validator that queries. Some of it maps
  cleanly, some does not (§5.3).
- The build gains a hard dependency on database availability. A Neon outage becomes a deploy outage.
  Mitigable by caching the last good artifact.
- One-time correctness risk: 3,208 rows with a loosely-typed nested shape moving into a schema.

**Migration effort:** substantial but decomposable. Estimate 3–5 weeks of focused work across four
phases, each shippable. §5 sequences it.

**Build time and page performance:** unchanged for pages, because prerendering survives intact.
Build gains one query of a few hundred milliseconds and loses the 8–12 ms JSON parse. Page
performance *improves*, materially, because of the projected payload.

### (c) Fully dynamic — runtime queries with caching

Drop `getStaticPaths`. Render venue pages on request, cache at the edge.

**Fixes:** everything (b) fixes, plus decoupling deploys from data entirely — an edit is live
immediately with no build. Build time becomes `O(1)`.

**Costs:** it trades away the thing that is working. Every venue page becomes a function invocation
with a cold-start risk and a database dependency on the request path. Cache misses on the long tail
— which is most of a 30,000-venue directory, and most of the SEO value — are slow. Crawler traffic
hits cold paths by definition, because crawlers visit obscure pages. A Neon incident becomes a
site-wide outage rather than a stale-data problem. Every request costs money.

Prerendering 3,208 pages costs 10 seconds and buys permanent immunity to all of that. Giving it up
to save 10 seconds is a bad trade.

**Verdict:** wrong as a wholesale strategy. Right for specific surfaces — search, live status,
anything personalised — which are already dynamic and should stay that way.

### (d) Hybrid — sharded files, or static shell with dynamic islands

Two distinct ideas often bundled together.

**Sharding the file** (per city, or per neighborhood, or browse-vs-full) fixes payload size and
reduces write amplification by the shard count. It does not fix concurrency (two admins editing
Pacific Beach still conflict), does not fix history growth (just divides it), does not give you
indexes, and introduces cross-shard consistency as a new failure mode — a venue that moves
neighborhood has to be deleted from one file and added to another atomically, which files do not do.
It is the right *output* shape and the wrong *storage* answer.

**Static shell with dynamic islands** — prerender the page, fetch the volatile parts client-side —
is what the codebase already does, and does well. `venue_overrides` patches listings at runtime,
`venue_publications` publishes a claim without a deploy, `live_overrides` drives live status, and
the homepage repaints from `/api/venue-overrides`. This pattern is proven here and should be
extended, not replaced.

**Verdict:** (d) is not an alternative to (b). It describes what (b)'s output should look like.

---

## 5. Recommendation and migration plan

### 5.1 Recommendation

**Option (b), with two refinements that matter more than the choice between options.**

Postgres becomes the source of truth for venues. The JSON file survives as a generated, uncommitted
build artifact, so prerendering — the thing that makes this site fast and cheap and robust — is
preserved exactly. This is the sweet spot the brief guessed at, and having measured the alternatives
I agree with it.

The two refinements:

1. **Separate the record from the payload.** The catalog conflates "everything we know about a
   venue" with "what a browse surface needs to draw a card." Those are different objects with
   different sizes and different audiences. 30% of the file is scrape provenance that no page
   displays. The build should emit a *projection*, not a dump. This is worth more to real users than
   the storage migration is, and — importantly — **it can be done today without touching storage.**

2. **Move search to Postgres regardless.** The claim search is the one path with a genuine
   algorithmic defect, and text search over a growing corpus is what indexes are for. It does not
   need to wait for the rest.

Where I'd push back on the framing in the brief: the case for this migration is *not* time
complexity. The `O(n)` scans measure at 0.03 ms and would be fine at ten times the size. The case is
**write amplification, payload weight, concurrency, and multi-city expressiveness** — and of those,
payload weight is the one costing something today, to real visitors, on every page load.

### 5.2 Phases

Each phase is independently shippable and independently valuable. Each states its preconditions and
its failure modes.

---

#### Phase 0 — Stop the bleeding (days, no schema change)

**Do this before the discovery run.** Nothing here is a migration; it is all fixable inside the
current architecture, and all of it makes the migration easier later.

1. **`git gc --prune=now`.** Reclaims most of the 719 MB of loose objects. Verify against
   `git count-objects -vH`, which currently shows only 13.92 MiB actually packed.
2. **Emit a projected browse payload.** A build step that writes a second file — published rows,
   display fields only — and points the three client `fetch` calls at it. **Measured** effect: 648 KB
   → 80 KB gzip, an 8× reduction on the homepage, `/live-deals`, and shared lists. Roughly a day.
   Keep `happy-hours.json` in place so nothing else moves.
3. **Stop bundling the catalog into functions that do not need it.** The three scheduled functions
   are 14 MB each because of a transitive import. Break the chain, or move the catalog behind a lazy
   accessor.
4. **Decide the id and city strategy, and write it down.** No code required, but see §6 — this is
   the decision that is materially harder to reverse after the discovery run.
5. **Snapshot the catalog into Postgres, read-only.** One table, one loader script, nothing reads
   from it yet. This is the rollback point that is not a 4.6 MB git blob, and it is the fixture the
   next phase validates against.

**Preconditions:** none.
**Risks:** the projected payload could omit a field some client code uses. Mitigate by generating the
projection from an explicit field list and asserting the client bundle references nothing outside
it.

---

#### Phase 1 — Mirror: Postgres learns venues, nothing depends on it

Add the schema and dual-write. The file stays canonical.

- `venues` table matching the `Venue` interface. Scalars as columns (`id`, `name`, `slug`,
  `neighborhood`, `address`, `lat`, `lng`, `listing_status`, `has_happy_hour_data`, `vibe`,
  `verified`, `place_id`, `city`, `timezone`). `windows`, `weekly_specials`, `gallery_images`,
  `hh_menu`, `hh_sources`, `last_scrape`, `features`, `deal_types`, `deals` as `jsonb` — they are
  documents, they are read whole, and normalising them buys nothing until something queries inside
  them. `happy_hour_menus` already exists as a normalised table (`0018`) and should stay the
  canonical menu store, with `hh_menu` as pipeline input.
- `venue_audit` table: `(venue_id, changed_at, changed_by, source, before jsonb, after jsonb)`.
  This is the replacement for the git diff and it is the reason to build it in this phase rather
  than the last one — see §5.4.
- Foreign keys from the existing venue-keyed tables become *possible*. Do not add them yet; adding
  them is a Phase 2 decision that needs the row set to be authoritative first.
- Pipeline scripts write both: file (as today) and database (new).
- A `venues:diff` script that compares the two and exits non-zero on disagreement. Run it in CI.

**Preconditions:** Phase 0 item 4 decided, because the `city` column and the id strategy are in this
schema.
**Risks:** dual-write drift. The diff script is the whole mitigation and it should be written first,
not last. Also: resist the temptation to normalise the jsonb columns now; a wide, boring schema that
round-trips exactly is what makes the cutover verifiable.

**Value shipped on its own:** venue data becomes queryable for admin reporting and analytics for the
first time, without any risk to the site.

---

#### Phase 2 — Cutover: Postgres canonical, file generated

Flip the direction once `venues:diff` has been clean across several pipeline runs.

- `prebuild` script queries Postgres and writes the artifact(s). Per-city, and split into a browse
  projection plus a full record set for venue pages.
- Remove `public/data/happy-hours.json` from git; add to `.gitignore`.
- Admin editor writes to Postgres. `src/lib/venueRepo.ts` deleted. `src/lib/github.ts` keeps only
  the blog and content-engine paths.
- Optimistic locking on `updated_at`, so the 409 becomes per-venue rather than per-catalog.
- Pipeline scripts read and write the database. Keep an `export`/`import` pair so an offline
  transform is still possible — this is worth real effort, because offline iterability is a genuine
  benefit of the current design and losing it silently would be a regression.
- Cache the last good artifact so a Neon outage degrades to a stale deploy, not a failed one.

**Preconditions:** `venues:diff` clean for at least a week of real pipeline activity, including a
merge and a stub import. A tested restore path from `venue_audit`.
**Risks:** this is the irreversible phase and the one to be careful with. The build now depends on
the database. Deploy previews need connection access. Keep the last committed snapshot on a branch
for a month so revert is still a single command.

---

#### Phase 3 — Indexes and dynamic surfaces

- Claim search → Postgres with a `pg_trgm` GIN index on name and address. `O(n log n)` per keystroke
  becomes `O(log n + k)`, and the function stops parsing a catalog to answer it.
- Neighborhood and faceted filtering → indexed queries on `(city, neighborhood, listing_status)`.
- Homepage: keep the static shell and the first screen of cards prerendered; page the tail from an
  endpoint. This is what makes the payload `O(k)` instead of `O(p)`, and it is the last `O(n)` term
  on the client.
- Consider dropping the 3,208 prerendered admin editor pages in favour of one dynamic route. They
  are ~half the build and their content is discarded on load.

**Preconditions:** Phase 2 complete.
**Risks:** low. Each item is independently revertible.

---

#### Phase 4 — Multi-city

- `city` column populated and enforced; per-city build shards.
- Per-venue `timezone` replacing `SD_TIME_ZONE`, across the 17 modules
  `docs/porting-to-a-new-city.md` §9 enumerates.
- `/{city}/venues/{slug}` routing, with redirects from the flat namespace.
- Per-city id namespacing, or opaque ids — whichever was decided in Phase 0.

**Preconditions:** everything above, and the legal and Google-terms questions in
`docs/porting-to-a-new-city.md` §3.1 and §3.3 settled.
**Risks:** the URL migration is the SEO-sensitive one. It wants a redirect map and a slow rollout.

### 5.3 How `validate-data.js` maps onto the database

Most of it becomes constraints, which is strictly better because a constraint cannot be forgotten.
Some of it does not, and pretending otherwise is how a contract quietly stops being enforced.

| Rule (reference doc §11) | Database equivalent | Notes |
|---|---|---|
| `id` unique integer | `PRIMARY KEY` | Free, and stronger — the current check is a `Set` in a script |
| `name`, `neighborhood`, `address`, `vibe` non-empty | `NOT NULL` + `CHECK (length(trim(…)) > 0)` | Direct |
| `lat`/`lng` in range | `CHECK` | Direct |
| `verified` boolean | `boolean NOT NULL` | Direct |
| `lastVerifiedAt` key present even when null | Column exists, nullable | The rule becomes meaningless, which is the point — it exists because JSON cannot distinguish absent from null |
| `sourceUrl` is `http(s)` | `CHECK (source_url ~ '^https?://')` | Direct |
| `listingStatus ∈ {published, unlisted}` | `CHECK … IN (…)` or an enum | Direct |
| `startTime`/`endTime` are `HH:MM` | `time` columns | Better — the format becomes unrepresentable rather than checked |
| `days` valid day names | `CHECK` over a `text[]`, or a day-of-week `smallint[]` | Direct |
| `publishedByClaim` not set when unlisted | Table `CHECK` across two columns | Direct |
| **Stub rules (§11.3)** — must *not* have `days`, `deals`, `dealTypes`; must be `unlisted` | Table `CHECK` on the stub predicate | Expressible, and the interesting one: the validator *forbids* fields, and a `CHECK` can too |
| `windows`, `weeklySpecials`, `galleryImages`, `imageCrop` shape | `jsonb` + a `CHECK` calling a validation function, **or** keep in application code | **This is where the mapping gets ugly.** A recursive shape check in SQL is unpleasant to write and worse to change |
| `imageCrop` requires `image` | Table `CHECK` | Direct |

Recommendation: put every scalar rule in the schema, where it is unforgettable, and keep the nested
`jsonb` shape validation in TypeScript as a single shared validator that both the write path and a
`npm run validate:venues` sweep call. That keeps one implementation of the shape rules and stops
`validate-data.js` and `src/lib/validation.ts` from drifting, which is a live risk today — they
already contain two hand-synchronised copies of the `imageCrop` rule, with a comment in
`validate-data.js` explaining that it cannot import the other because one is plain Node and one is
TypeScript.

### 5.4 Keeping the history of data changes

This is the genuine loss and it deserves a deliberate answer rather than a shrug. Three mechanisms,
and I would do all three:

1. **`venue_audit` table** — `(venue_id, changed_at, changed_by, source, before jsonb, after jsonb)`,
   written by every mutation path. Storage is `O(δ)` per change rather than `O(n)` per commit, and it
   is *better* than the git diff in two ways: it attributes the change to a user or a pipeline run,
   and it is queryable ("what changed on this venue", "what did that merge touch"), which a git diff
   over a 43 MB file is not.
2. **Periodic snapshot export, committed.** A weekly or per-pipeline-run export to a separate
   repository, or to Blobs with a retention policy. Gives the "diff two points in time" capability
   without putting a 43 MB file in the deployment repo's history. This is what preserves the
   recovery workflow the owner has actually used.
3. **Neon's own point-in-time restore**, which exists and covers the "we broke everything at 3am"
   case better than either.

The thing to be honest about: none of these reproduces the *ergonomics* of `git log -p` on a data
file. That is a real regression, and it is the strongest argument for option (a). It is outweighed —
but it should be outweighed knowingly, and mechanism 2 is what makes it survivable.

### 5.5 How multi-city should fit

A **`city` column**, not separate databases and not a schema per city.

- Separate databases mean N connection strings, N migrations to run, and cross-city features (one
  account, one claim dashboard, one saved list spanning a trip) become integration work. The user
  model is already single and global; splitting the venue model away from it creates a join across
  databases for the most valuable features.
- Schema per city is the worst of both — the operational cost of N schemas and the query complexity
  of dynamic schema names, in exchange for isolation nobody asked for.
- A `city` column with an index on `(city, …)` gives per-city queries that are as fast as separate
  databases (the index prefix does the partitioning), keeps one migration path, and leaves the door
  open to real Postgres partitioning by city if a table ever gets big enough to need it. At tens of
  thousands of rows it will not.

`docs/porting-to-a-new-city.md` §3.2 frames this as a choice between one-deployment-per-city and one
app with a city dimension, and notes the migration is much cheaper while there is one city in
production. That is still right, and it is why the id decision belongs in Phase 0.

---

## 6. Right now versus later

The owner is about to run a large discovery job that could add thousands of venues.

### 6.1 Before the discovery run

**1. Decide the id strategy. This is the one genuinely irreversible item.**

`build-staging.mjs` allocates ids as `max(existing) + 1` over the catalog. A run that adds 3,000
venues mints 3,000 permanent integer ids. Those ids become URLs (via slugs), and they become the
join key in a dozen tables — `venue_claims`, `venue_publications`, `venue_overrides`, `venue_photos`,
`promotions`, `live_overrides`, `saved_spots`, `venue_follows`, `happy_hour_menus`, `venue_managers`.

If the eventual answer is per-city id ranges, or opaque ids, then renumbering 6,000 venues afterwards
means rewriting every one of those tables plus every URL that has been indexed by Google or saved by
a user. Renumbering 3,200 is bad. Renumbering 6,200 is worse, and by then some of the new ones will
have claims and saved-list entries attached.

The cheap move, if there is no appetite to decide now: **have the run allocate San Diego's ids from a
reserved band** (say 1–999,999) so a second city can take a different band without collision. That
costs one constant and preserves the option.

**Done.** `VENUE_ID_BAND` in `scripts/import-google-venues/lib/constants.mjs` reserves 1–99,999 for
San Diego; `build-staging.mjs` and `import-claimable-stubs.mjs` allocate through
`lib/venue-ids.mjs`, which starts after the highest id already in the band and throws rather than
allocating past the end of it. No existing venue was renumbered and San Diego's next id is
unchanged. A second city sets its own band and nothing else about this decision has been made.

**2. Write a `city` value on every new row.** Even as a hardcoded `"san-diego"`. Retrofitting city
attribution onto 6,000 rows later means inferring it from coordinates, which is exactly the Cardiff
failure mode from `docs/venue-pipeline-reference.md` §6 — silent mislabelling, no error. Writing it
at import is free and unambiguous.

**3. Fix the client payload.** The run roughly doubles the catalog. The homepage currently ships all
of it, and 80% of the rows it ships are stubs it cannot display. After the run that is a
~1.3 MB gzip download to draw ~700 cards. This is a one-day fix (§5.2, Phase 0 item 2) with a
**measured** 8× improvement, and it is the only item on this list that real visitors will notice.

**4. `git gc`, and decide the commit policy for the run.** Reclaim the 719 MB of loose objects first.
Then decide deliberately how many times the run commits — at ~0.6–1 MB of permanent pack growth per
catalog commit (**projected**), a run that commits after each of its dozen stages is meaningfully
more expensive than one that commits once at the end. There is no way to reclaim it afterwards
without rewriting history.

**5. Snapshot the current catalog into Postgres before the run starts.** Not as a migration step —
as a rollback point and a baseline. If the run goes wrong, "restore the 3,208 rows we had at
commit `c3252db`" should not depend on git surgery on a file that will by then be 9 MB.

**6. Consider a provenance decision.** `lastScrape` and `hhSources` are 30% of the file
(**measured**) and the discovery run will add them for thousands of rows. They are worth keeping —
they are what lets a later run reason instead of guess. But if they are going to be 30% of a 9 MB
file, that is the moment to decide whether they belong in the catalog or in a sidecar the pipeline
reads and the site never loads. Moving them later is a migration; deciding now is a config change.

### 6.2 What is materially harder after the run

| Item | Why it gets harder |
|---|---|
| Id strategy / renumbering | 2× the rows, and new rows will have accumulated claims, photos and saved-list entries |
| City attribution | Has to be inferred from coordinates rather than written at import; silent failure mode |
| Splitting provenance out of the catalog | 2× the data to migrate, and the file crosses the push-warning threshold sooner |
| Git history of the catalog | Unreclaimable without rewriting history, and every collaborator's clone |
| Deciding not to commit the file at all | Easiest before thousands of rows land in history |

### 6.3 What can safely wait

Everything else. Phases 1 through 4 are all easier with a bigger dataset to validate against, not
harder — a diff script that agrees across 6,000 rows is better evidence than one that agrees across
3,200. The Blobs fallback holds. The 100 MB limit is ~69,000 listings away (**projected**). Build
time at 6,000 venues is roughly 40 seconds (**projected**).

There is no need to rush the migration. There is a need to not mint 3,000 permanent identifiers
under an undecided scheme.

---

## 7. Open questions

- **Do the 3,208 prerendered admin editor pages need to exist?** They are ~half the build and they
  discard their build-time content on load. Nobody has checked whether a single dynamic route would
  be better in every respect.
- **Should `hhMenu` remain in the catalog at all**, now that `happy_hour_menus` (`0018`) is a
  normalised table? Two stores for the same thing is how they drift.
- **What is the right shard boundary for the build artifact** — city, neighborhood, or
  browse-vs-detail? Probably all three, but nobody has measured which one buys the most.
- **How much of the `O(n)` client filter can move server-side** without losing the instant-feel
  filtering that is currently a genuine product strength? The homepage filter responds in
  microseconds because the data is local. An indexed query over the network will not.
- **Does the pipeline actually need offline capability**, or is that a benefit we would list in a
  review and never use? Worth answering honestly before spending a week preserving it.
- **What does `validate-data.js` catch today that a constraint would not?** The stub rules look
  expressible. The nested shapes look like they want to stay in TypeScript. Nobody has gone through
  all 197 lines and classified them, and that classification is Phase 1's real design work.
