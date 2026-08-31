# Google photos: what we are exposed to, and what the alternatives cost

The featured photo on almost every venue that has one is a Google Places photo, downloaded and
served from our own domain with no attribution anywhere on the page. This page establishes what is
actually true, what the terms actually say, what the realistic risk is, what each way out costs,
and what a forced purge would do to the site tomorrow.

**Status, 31 August 2026 — assessment only. Nothing here is implemented and no application code
changed.** Every count was read out of `public/data/happy-hours.json`, the image files on disk and
the rendering code on 31 August 2026. The catalog stood at **3,006 rows, 686 published**. Documents
quoting 3,208 rows or ~690 published predate the chain purge and should not be trusted. The terms
in §2 were read off Google's own pages on 31 August 2026, not carried over from
`docs/places-api-cost-analysis.md` §2.6, which is older and slightly less specific than what Google
now publishes. How to tell this page has rotted: re-run the census in §1.5, and check that
`fetch-photos.mjs` still discards `authorAttributions` and that `getListingImage` still falls back
to a vibe stock photo.

**Owner decision, 31 August 2026 — venue-site photos are the chosen long-term path; deferred, not
now.** The right destination is §4.2 (retrieve hero photos from each venue's own website) rather
than continuing to depend on Google Places photo bytes or spending engineering on attribution
recovery for those bytes. That work is **explicitly not scheduled in this pass**: do not scrape
venue-site photos yet, and do not recover Google `authorAttributions` as a substitute. Until that
path ships, Google bytes remain on disk as the dated, known exposure this document already
describes. Owner uploads through the claim flow (§4.3) stay the permanent end-state for venues that
never publish a usable site photo.

**This is an engineering read, not legal advice.** Where a statement is a reading of published terms
it says so; where it is an observation about how those terms get enforced in practice it says that
instead, and the two are kept apart on purpose.

---

## 1. The facts

### 1.1 How many, and where the bytes are

| | Count |
|---|---|
| Catalog rows | 3,006 |
| Published | 686 |
| Rows carrying an `image` | 599 |
| — Google Places photo bytes under `public/images/venues/` | **597** |
| — owner/admin uploads served from `/api/images/` | 2 |
| Google-photo rows that are **published** | **483** |
| Google-photo rows that are unlisted | 114 |
| Published rows with no `image` at all | 201 |
| Disk footprint of the 597 files | **312 MB**, inside an 802 MB directory it shares with menu boards |

So the exposed surface is 597 files, of which 483 are on pages a visitor can reach through browse or
search. The other 114 sit on unlisted stub pages, reachable by direct URL and by the claim search.

### 1.2 How they got there and how they are served

`scripts/import-google-venues/fetch-photos.mjs` calls `downloadPlacePhoto()` in
`lib/google-places.mjs`, which does a Place Details call with a `photos` field mask, takes
`photos[0].name`, requests `/media?maxHeightPx=1200&skipHttpRedirect=true`, and then fetches the
returned `photoUri` and writes the bytes to `public/images/venues/{id}-{slug}.{ext}`. The catalog row
gets a local path. From that moment there is no link back to Google in the data at all — the file is
a static asset in the repository, served from our domain through the Netlify Image CDN like any other
image.

Three consequences of that shape, all load-bearing later:

- **`authorAttributions` is discarded.** The photo response carries it, `downloadPlacePhoto()` never
  reads it, and nothing is stored. We therefore do not currently know which of the 597 photos
  required attribution and which did not, and we cannot know without asking Google again.
- **`placeId` is on only 382 of the 597 rows.** The other 215 were matched to a place at fetch time
  through `match-places.mjs` against `.data/import/google/enriched.json`, which is gitignored and is
  a working cache rather than a durable record. Any re-fetch for those rows depends on that cache
  still existing and still matching.
- **The bytes are indistinguishable from ours on the page.** They carry no marker, no attribution and
  no link. That is exactly what makes them identifiable as Google's to anyone who looks — see §2.4.

### 1.3 Where they render

Everything goes through `getListingImage()` in `src/lib/venues.ts`, which is why a single field drives
four surfaces:

| Surface | Uses |
|---|---|
| Venue page hero, and its OG/social image | `getListingImage(venue, 'hero')` |
| Homepage cards | `getListingImage(venue, 'card')` |
| Live Deal cards | same card path |
| Neighborhood pages and neighborhood index tiles | same card and tile paths |
| `venueSchema()` structured data | the hero URL is emitted as the schema `image` |

That last row matters more than it looks: the hero URL is published in JSON-LD and in Open Graph tags,
which means Google's own crawler is told, on 483 pages, that this image belongs to this venue page on
this domain.

### 1.4 Attribution rendered today: none, for photos

The only Google attribution anywhere on the site is one line on the venue page attributes section —
`Amenity details from Google. Absent items just mean nobody has told us.` There is:

- no author attribution on any photo,
- no link to the source photo on Google Maps,
- no Google Maps logo or text attribution on any surface displaying Places content,
- and no embedded Google Map anywhere. The site links out to `maps.google.com` for directions; it
  never renders a map.

### 1.5 Reproducing the census

```
node -e "const r=require('./public/data/happy-hours.json');const g=r.filter(v=>v.image&&v.image.startsWith('/images/venues'));console.log(r.length, r.filter(v=>v.listingStatus!=='unlisted').length, g.length, g.filter(v=>v.listingStatus!=='unlisted').length, g.filter(v=>v.placeId).length)"
```

Expected on 31 August 2026: `3006 686 597 483 382`.

---

## 2. What the terms actually say

Read on 31 August 2026 from the Places API policies page, the Place Photos (New) reference, and the
Maps Platform Service Specific Terms. Quotations are close paraphrases; the sources are listed at the
end.

### 2.1 Caching and storage

- **Place IDs are exempt and may be stored indefinitely.** This is stated explicitly and is the only
  documented exemption.
- **Places API §14.3 of the Service Specific Terms permits temporarily caching latitude and longitude
  for up to 30 consecutive calendar days**, after which they must be deleted. That is the only
  content-specific caching permission the Places section grants.
- **Everything else falls under the general prohibition**: "You must not pre-fetch, cache, or store
  Places API content" beyond the allowed exceptions. There is no photo-specific caching allowance and
  no stated period for photo bytes. Storing 597 image files in a git repository for months is
  therefore outside a plain reading, and the reading is not a close call. This is the strictest thing
  on the page, and it applies to names, addresses, hours, phone numbers and the amenity block too —
  photos are not a special category for *caching*, they are a special category for *attribution*.

### 2.2 Attribution, which is more specific than the repo's docs suggested

The Place Photos reference is more nuanced than "photos always need attribution", and the nuance cuts
in our favour and against us at the same time:

> Photos returned by Place Photos are sourced from a variety of locations, including business owners
> and user contributed photos. In most cases, these photos can be used without attribution, or will
> have the required attribution included as a part of the image. However, if the returned `photo`
> element includes a value in the `authorAttributions` field, you must include the additional
> attribution in your application wherever you display the image.

So attribution is conditional on `authorAttributions` being non-empty for that specific photo. The
policies page then adds requirements that are not conditional:

- **Credit the author** with avatar, name and profile link where space allows. For photos
  specifically, attribution may be omitted in a gallery or thumbnail **provided the user can reach a
  larger version that carries the full attribution**. A hero image at 1600px is not a thumbnail.
- **End users must always be able to view the source photo on Google Maps** via the photo's
  `googleMapsUri`.
- **Displaying Places content without a Google Map requires the Google Maps logo** (or the text
  "Google Maps" where space is tight), positioned within the same visual container as the content.
- Places API §14.2: **content must not be used in conjunction with a non-Google map.** We render no
  map at all, so this clause is not currently tripped, but it forecloses the obvious "add a Leaflet
  map" upgrade to the venue page while any Google content is on it.

**The honest position on our 597:** we do not know how many of them carried `authorAttributions`,
because we threw the field away. Google's own wording suggests "in most cases" they can be used
without it, which means the attribution problem is probably smaller than the storage problem — but
"probably" is doing real work in that sentence and it is cheap to replace with a fact (§4.1).

### 2.3 The parts we are clean on

- Place IDs stored indefinitely: explicitly permitted.
- `reviews`, `reviewSummary`, `generativeSummary` and `neighborhoodSummary` were excluded from both
  Details masks deliberately, and the comment in `lib/google-places.mjs` says why. Confirmed: none of
  those fields appears anywhere in the catalog or in any rendering code.
- `editorialSummary` **is** in the full-capture mask and was bought — it came back for 46% of the
  2,787 backfilled venues — but it lives only in `.data/import/google/atmosphere.json`, which is
  gitignored. **It is on zero catalog rows and no surface renders it.** The Atmosphere capture did
  what it said it did; nothing slipped in.
- `galleryImages` is 391 entries and **not one of them is Google-sourced** — 371 are menu boards we
  typeset, 20 are scraped from venue sites. `menuCandidateImages` on 211 rows comes from venue-site
  scraping via `relink-orphan-menu-flyers.mjs`. The menu-image work happening in parallel is not
  adding to this exposure.

### 2.4 What else carries the same terms, ranked by how visible it is

Photos are the sharpest instance, not the only one. In descending order of how identifiable the
content is as Google's:

1. **Photo bytes, 597 files.** Served from our domain, byte-identical to what Google served, and
   announced to Google's crawler through OG tags and JSON-LD. Uniquely *provable* from the outside.
2. **The amenity block**, 11 fields across up to 2,561 rows, displayed on venue pages under a line
   that says it came from Google. Not identifiable byte-for-byte, but we label it ourselves.
3. **Names, addresses, coordinates and phone numbers** on 3,006 rows, committed to git. Facts about
   businesses, individually unremarkable and available from a dozen sources, but sourced from Google
   here and stored well past 30 days. The coordinates are the one field with an explicit, named,
   30-day term attached, and we are outside it on every row.
4. **`vibe`**, derived from Google's type taxonomy on 3,006 rows. A derivation of Google content
   rather than the content itself, which is a weaker but not empty exposure.
5. **`priceLevel` / `priceRange`**, ~2,100 rows, displayed. Same category as the amenity block.

Nothing in the catalog carries review text or Google-generated prose. That decision has held.

---

## 3. The real risk

The owner's question — how would Google realistically enforce storage terms on publicly available
data — deserves a straight answer rather than either reassurance or alarm. The answer has two halves
that point in different directions.

### 3.1 What the terms permit Google to do (a reading of the contract)

The Maps Platform agreement is a contract, not copyright law, and the remedies in it are contractual:
suspend or terminate the project's API access, require deletion of the cached content, and in
principle claim damages. Separately, the photographs themselves are somebody's copyrighted work —
usually a Google Maps contributor or the business owner, licensed to Google — so a photographer or an
owner could in principle send a DMCA notice to our host about a specific image. That is a different
mechanism from the Maps terms and it does not involve Google at all.

### 3.2 What actually happens in practice (observation, not law)

Enforcement against small directories is, as far as anyone can observe, overwhelmingly automated and
account-level rather than legal. The realistic sequence, in descending order of likelihood:

1. **Nothing happens, indefinitely.** This is the most likely single outcome and pretending otherwise
   would be dishonest. Google does not crawl the web looking for its own photo bytes on hobby sites,
   and 597 restaurant photos on a San Diego happy-hour directory is not a commercial threat to
   anybody.
2. **A takedown or a complaint arrives from a venue or a photographer**, not from Google. This is
   more likely than Google acting, because the people who notice are the people in the photo's
   subject — and this site actively invites venue owners to look at their own page through the claim
   flow. An owner who dislikes the photo we chose is a support email, not a lawsuit.
3. **API key suspension or project termination.** The plausible Google-side action, and it arrives by
   email with a compliance window. Its practical cost to us is not the photos: it is losing discovery
   and `businessStatus` for the next city, which `docs/data-sourcing-plan.md` §5.1 identifies as the
   part of Google we genuinely cannot replace.
4. **A bill.** Effectively zero risk. There is no retroactive metering for cached content; the SKUs
   bill per call.
5. **Litigation.** Not a realistic scenario at this scale and worth naming only to close it off.

### 3.3 What raises the odds

The risk is not static, and three things move it, all of which are on the roadmap:

- **Traffic and index presence.** An unindexed site nobody visits is invisible. A site ranking for
  "happy hour san diego" with 483 hero images is not. The exposure grows precisely as the project
  succeeds.
- **Scaling to more cities.** Five cities at this rate is ~3,000 stored photos, and volume is what
  turns a judgement call into a pattern.
- **Owner contact.** Every claim email points a business owner at a page showing a photo we did not
  take, which is the single most likely trigger for a complaint.

### 3.4 The proportionate summary

The storage of photo bytes is **outside a plain reading of the terms, at low but non-zero and slowly
rising practical risk, with a realistic worst case that is a compliance email and a scramble rather
than a bill or a lawsuit.** The reason to act is not fear of Google. It is that the photos are also
the site's largest single dependency on a source we do not own, and §5 shows the cost of that
dependency is smaller than it looks — which makes this a cheap problem to shrink and a silly one to
leave sitting.

---

## 4. The options, with costs

### 4.1 Add the required attribution and keep using them

**What compliant looks like.** Three things, and only the first is conditional:

1. For any photo whose `authorAttributions` is non-empty: the author's name, their Google Maps
   profile link, and where space allows their avatar, positioned so it is clearly associated with the
   image. On a full-width hero there is space, so the "omit on thumbnails" allowance does not apply to
   the venue page. It does apply to homepage cards and neighborhood tiles, **provided** clicking
   through reaches a larger version carrying the attribution — which is exactly what the venue page
   is, so cards and tiles need nothing.
2. For every photo: a way for the visitor to open the source photo on Google Maps, via the photo's
   `googleMapsUri`.
3. On any surface showing Places content without a Google Map: the Google Maps logo or text
   attribution, in the same visual container. On our pages that means the hero and the amenity
   section, and it would replace the current hand-written "Amenity details from Google" line with
   Google's specified treatment.

**What it costs.** The metadata we need — `authorAttributions`, `googleMapsUri`, `flagContentUri` —
comes from a Place Details call with a `photos` field mask, which is the **Essentials (IDs only) SKU:
unlimited and free**. So recovering attribution for all 597 photos is **$0 in API spend** and roughly
an hour of script time, plus a re-match for the 215 rows with no stored `placeId` against the local
enrich cache. Rendering it is a small change to the hero, the lightbox and the attributes section.

**What it does not fix.** Attribution answers the display requirement. It does nothing about the
storage prohibition, which is the larger of the two problems. Attribution is necessary if we keep the
photos and it is not sufficient. Worth saying plainly: doing this makes us *more visibly* a consumer
of Google photos, which is honest and is arguably the point, but it is not a way to become compliant
overall.

**Verdict:** cheap, correct as far as it goes, and it should happen whether or not we keep the photos
long-term, because it is free and it is the difference between an oversight and a decision.

### 4.2 Replace them with photos from each venue's own website

**Feasibility, measured rather than guessed.** A 60-venue random sample of the published venues
currently carrying a Google photo, fetched on 31 August 2026 with the throwaway script recorded in
§8:

| | Of 60 |
|---|---|
| Site reachable | 58 |
| Has an `og:image` or `twitter:image` at all | 37 (62%) |
| That image is over 20 KB and at least 800px wide | 28 (47%) |
| Eyeballed as an actual photograph of the venue, its food or its interior | **12–15 (20–25%)** |

The gap between the last two rows is the finding. Most of what passes a size check is a logo, a
wordmark on a coloured square, a generic brand social card (both Chili's in the sample returned the
same national `chilis-og-default.png`) or licensed stock — one venue's `og:image` was an Unsplash
photo and another was a Getty image. A pipeline that trusts `og:image` would replace 483 real
photographs of San Diego bars with several hundred logos, which is worse than the vibe stock photo it
would be competing with.

**The version that would actually work** is the one the codebase is already shaped for: crawl the
site as the menu pipeline does, harvest candidate `<img>` elements above a size floor, and have the
model pick the one that best depicts the venue — the same job `menu-flyers.mjs` does for menu boards,
against a different question. `lib/playwright-browser.mjs` handles the JavaScript shells that return
nothing to a plain fetch, and `fetch-page.mjs`, `sitemap-discover.mjs` and `media.mjs` already do
discovery, fetching and format sniffing.

**Cost of that version**, extrapolated from the measured rates in `docs/data-sourcing-plan.md` §6.3:

| Line | Estimate | Method |
|---|---|---|
| Crawl, 597 venues, ~4 fetches each | **$0** | Bandwidth and local CPU, as with every other scrape |
| Model pick, one call per venue with 3–6 image blocks | **$30–$60** | Image blocks put this near the PDF-raster rate of $0.05–$0.10 per call, not the $0.017 text rate |
| Expected usable hit rate | **35–50%** | The 20–25% `og:image` floor, plus what a whole-page harvest adds. Unmeasured above the floor; this is the honest guess |
| Venues recovered | **210–300 of 597** | |
| Human review | **several hours** | At `lessons-and-invariants.md` §2.11's 12-of-22 acceptance rate, a photo choice is exactly the kind of judgement a model gets plausibly wrong, and a wrong hero is visible in a way a wrong deal line is not |

**The catch nobody should skip:** a photo on a venue's website is the venue's copyright or their
photographer's, and taking it is not automatically better-licensed than taking Google's. It is *more
defensible* — a business publishing photos of itself on its own site has an obvious interest in those
photos being how it is seen elsewhere, and the site links back — and it is the same posture we already
take with menu images and deal text, which is the strongest argument for it. But it trades a clear
terms problem for a softer copyright question rather than eliminating the question.

**Verdict:** worth building, at roughly a day of engineering plus $30–$60 and an afternoon of review,
for a bit under half the coverage. Not a complete answer on its own.

### 4.3 Owner-supplied photos through the claim flow

Correct by construction, no licensing question, no refresh cost, permanently removes the venue from
this problem. Two rows carry an owner upload today. The claim flow already accepts a featured photo
and framing.

**Coverage today: 2 of 599, or 0.3%.** This is the right long-term answer and it contributes nothing
to the next twelve months. Treat it as the destination, not the plan.

### 4.4 A fallback that looks intentional

The site already has a fallback and §5 shows it is the weakest part of the whole picture: 20 vibe
stock photos, of which one — `speakeasy.jpg` — absorbs every venue whose vibe is not on the list.
Because `vibe` is Google's type taxonomy, the most common values (`Cocktail bar`, `Restaurant`,
`Brewery`, `Nightlife spot`, `Cafe`, `Pizza spot`) are **none of them keys in `vibeImages`**, so they
all land on the same picture.

Two cheap improvements, independent of everything else on this page:

- **Add the missing vibe keys.** Six new stock photos covering `Cocktail bar`, `Restaurant`,
  `Brewery`, `Nightlife spot`, `Cafe` and `Pizza spot` would move 389 of the 483 exposed pages off
  the single default. Cost: sourcing six properly licensed images.
- **Design a photoless card and hero deliberately** — a typographic treatment using the venue name,
  neighborhood and deal chips, rather than a stock photograph pretending to be the venue. A card that
  is honestly not-a-photo reads better than the same bar interior 557 times, and it is the only
  option here with no licensing question of any kind.

**Verdict:** the highest ratio of appearance-improvement to effort on the page, and it is what makes
every other option on this list survivable.

### 4.5 Some combination

The combination that falls out of the costs above, and the one §7 recommends: attribution now because
it is free, fallback design because it is cheap and it de-risks everything else, website scraping for
the venues where it works, claims collecting the rest slowly, and Google photos kept in the meantime
as a known, dated, written-down decision rather than an accident.

### 4.6 Doing nothing

A legitimate choice, stated honestly: keep 597 stored photo bytes with no attribution, accept that
this is outside a plain reading of the terms, and accept the §3.2 risk profile — most likely nothing,
plausibly an owner complaint, occasionally a compliance email that costs us the API key we need for
the next city. What makes doing nothing worse than it looks is not the risk. It is that the two
cheapest fixes — recovering attribution at $0, and fixing the fallback — are cheap enough that
choosing not to do them is hard to defend as anything but inertia.

---

## 5. What a purge would actually cost

Suppose the photos had to disappear tomorrow. Delete the 597 files and clear the field.

**Nothing breaks.** `getListingImage()` falls straight back to `getVenueImage(venue.vibe)` on every
surface, the venue page's `restoreStockHero()` already handles a failed image at runtime, and the
data contract requires no `image`, so `validate-data.js` passes. There is no blank page and no broken
layout anywhere. That is the single most important fact in this document and it is worth stating
before the damage: **the exposure is aesthetic, not structural.**

**What it looks like:**

| | Today | After a purge |
|---|---|---|
| Published pages with a real photo of the venue | 485 | **2** |
| Published pages on a vibe stock photo | 201 | **684** |
| Published pages showing `speakeasy.jpg` specifically | ~167 | **557** |
| Published pages on one of the other 19 vibe photos | ~34 | 129 |

So the honest answer to "how exposed are we" is: **557 of 686 published pages would show the same
photograph of the same bar.** Homepage cards, neighborhood tiles and Live Deal cards all read off the
same field, so the homepage becomes a grid of one repeated image. The site would not look broken. It
would look like a template with the sample content left in, which for a directory whose entire pitch
is local knowledge is arguably worse than looking broken.

**How fast could it be repopulated?**

| Path | Recovers | Elapsed |
|---|---|---|
| Fix the vibe fallback first (§4.4) | Nothing, but 389 pages stop sharing one image | An afternoon, plus sourcing six photos |
| Website scrape (§4.2) | 210–300 of 597 | A day of engineering, a few hours of crawl, an afternoon of review |
| Re-fetch from Google | All 597, at ~$4 for 597 Photos calls | An hour — and it recreates exactly the problem being purged, so it is only an answer if the purge was voluntary |
| Owner claims | Unbounded, eventually | Months to years |

**Realistic worst case, then:** roughly a week from purge to a site where about half the published
venues carry a real photograph and the other half carry a deliberate photoless treatment. That is a
bad week, not an existential one — and most of that week is work worth doing anyway.

---

## 6. Recommendation

**Keep the photos for now, and spend the two cheap fixes immediately so that keeping them is a dated
decision with a stated risk rather than an oversight. Build the website-photo path before the next
city, because a second city triples the exposure and the fix does not get cheaper by waiting.**

The reasoning in one paragraph: the storage of photo bytes is outside a plain reading of the terms
and always has been; the practical risk today is low and rising with traffic; the cost of a forced
purge is a week of ugly pages rather than a broken site; and the two things that most reduce both the
risk and the purge cost — recovering attribution metadata and fixing the stock-photo fallback — cost
$0 in API spend and an afternoon each. Ripping out 597 photos today would make the site materially
worse in exchange for eliminating a risk that is small, which is a bad trade. Leaving all of it
untouched keeps a known problem growing at the exact rate the project succeeds, which is a worse one.

**Sequence.**

*Now, this week:*

1. **Recover and store the photo metadata.** One script, the free IDs-only SKU, writing
   `authorAttributions`, `googleMapsUri` and `flagContentUri` onto each row alongside the file path.
   This costs nothing, and until it runs we cannot even state how many photos require attribution.
2. **Render the attribution that turns out to be required**, plus a link to the source photo on Google
   Maps, plus the Google Maps text attribution on surfaces displaying Places content.
3. **Write the decision down** — in this file, with a date — that we are storing Google photo bytes
   knowingly, and that a compliance request is answered by deleting `public/images/venues/*` for the
   597 known files and letting the fallback take over.

*Before the next city:*

4. **Fix the fallback (§4.4):** stock photos for the six missing vibes, and a photoless card and hero
   treatment that looks deliberate. This is the insurance policy that makes every other decision
   reversible.
5. **Build the venue-site photo path (§4.2)**, run it over the 597, accept 35–50%, and stop fetching
   Google photos for new venues. From that point the exposure shrinks with every scrape instead of
   growing with every import.
6. **Add a photo upload prompt to the claim flow's first screen.** An owner claiming a listing is the
   one moment they are most willing to hand over a photo.

*Can wait:*

7. Backfilling the 215 rows with no `placeId` beyond what the enrich cache can match. If the cache
   cannot resolve a row, that photo is simply a candidate for §4.2 or for deletion.
8. Any re-fetch cadence for photos. Refreshing a stored Google photo every 30 days would be a literal
   reading of the caching term and it would cost $4 a month, but it satisfies the letter while making
   the storage more deliberate, not less. Not recommended without a clearer reason.

*Explicitly not recommended:*

- A pre-emptive purge. It costs the site more than it buys.
- Hotlinking Google's photo URIs instead of storing bytes. The media URLs are short-lived and
  unstable, every page load becomes a paid call at $7/1k, and 483 pages break the day a URL expires.
- Adding a non-Google map to the venue page while any Places content is displayed on it. Places API
  §14.2 forbids exactly that, and it is the kind of change that would otherwise look like an
  improvement.

---

## 7. What this does not settle

- **Whether venue-site photos are meaningfully better licensed than Google's.** §4.2 argues they are
  more defensible and does not claim they are free of question. Someone should decide that
  deliberately rather than inheriting it from this page.
- **How many of the 597 actually carried `authorAttributions`.** Unknown until step 1 runs, and the
  whole of §4.1's scope depends on it.
- **The 35–50% hit rate in §4.2 above the measured 20–25% floor.** That upper half is a guess. The
  first 50-venue run turns it into a number.
- **Everything in §2.4 other than photos.** Names, addresses, coordinates and the amenity block sit
  under the same caching prohibition and are not addressed here. `docs/data-sourcing-plan.md` §5 is
  the plan for shrinking them; this page deliberately does not restate it.

---

## Sources

Repository artifacts read on 31 August 2026: `public/data/happy-hours.json`, the files in
`public/images/venues/`, `scripts/import-google-venues/fetch-photos.mjs`,
`lib/google-places.mjs`, `lib/match-places.mjs`, `lib/media.mjs`, `lib/playwright-browser.mjs`,
`src/lib/venues.ts`, `src/lib/vibeImages.ts`, `src/lib/venueAttributes.ts` and
`src/components/VenueHappyHourPage.astro`.

The §4.2 measurement was a throwaway script: for 60 randomly sampled published venues currently
carrying a Google photo, fetch the site, read `og:image` or `twitter:image`, fetch that image, and
record its byte size and pixel dimensions. It was not committed; the counts are in the table and the
method is one paragraph, which is enough to re-run it.

Google pages read on 31 August 2026:

- [Policies and attributions for Places API](https://developers.google.com/maps/documentation/places/web-service/policies)
  — the caching prohibition and the place ID exemption, the photo author-attribution requirements and
  the thumbnail allowance, the `googleMapsUri` access requirement, and the Google Maps logo and text
  attribution rules for displaying content without a map.
- [Place Photos (New)](https://developers.google.com/maps/documentation/places/web-service/place-photos)
  — the `authorAttributions` field, and the "in most cases these photos can be used without
  attribution" wording that §2.2 turns on.
- [Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
  — §3 Google ID Caching, and Places API §14.2 (no use with a non-Google map) and §14.3 (latitude and
  longitude, 30 consecutive calendar days).

Companion documents: `docs/data-sourcing-plan.md` for the field-by-field sourcing map this page drills
into one row of, `docs/places-api-cost-analysis.md` §2.6 for the earlier and less specific reading of
the same terms, `docs/venue-pipeline-reference.md` §11.4 for the image and framing contract, and
`docs/lessons-and-invariants.md` §2.11 for the human-acceptance rate that bounds §4.2.
