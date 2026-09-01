# Proprietary venue attributes — starting with character

**Status, 1 September 2026 — character vibe spike FAIL. Do not ship a character `vibe` pill; keep
`venueKind` as the honest establishment field. Catalog was not written.** Step 1 in §5 was run on
1 September 2026 (`scripts/experiments/venue-character/`): 40 published venues, closed vocabulary of
twelve, one Haiku pass, hand verdicts on every row. **Among 19 labelled: 15 true (78.9%), 4 false
(21.1%)** — below the ≥85% true / ≤10% false gate. Model spend **$0.3882**. Absence behaved well
(21/21 absent-correctly, 0 absent-miss). Failures are the features-experiment mode again: quotes
that appear in the packet but support the wrong conclusion (street address → waterfront; "RESTAURANT
+ BAR" → gastropub; chain Brewhouse beer list → brewery taproom; restaurant happy-hour cocktail copy
→ cocktail lounge). Recommendation: **stop.** Do not rename `vibe` → `venueKind` for a character
field; do not bulk-write character labels. Prefer HH price band / signature deal / freshness (§3.1)
next. Counts below were read from `public/data/happy-hours.json` on 31 August 2026 (3,006 rows, 686
published, 313 with `hhMenu`, 410 published with deal text, 330 with gallery images). How to tell
this page has rotted: if character labels appear in the catalog after this fail, or if the status
line no longer matches `scripts/experiments/venue-character/results.json`.

**This is not a wishlist.** §4 cuts candidates that fail the features experiment's bar. §5 was the
spike; §7 records the autopsy.

---

## 1. Two different questions that have been sharing one field name

`docs/vibe-field-audit.md` settled what the current `vibe` field is allowed to answer: **what kind
of establishment is this** — brewery, sports bar, wine bar, pub — derived from Google's committed
`primaryType` and the venue's own name, absent when neither speaks. That is a real question, it is
cheap, and it is honest for about a quarter of the catalog.

It is not the question the owner is asking now. The seed listings already showed the other one in
hand-typed values that survived re-derivation: *Speakeasy, Tiki bar, Arcade bar, Neighborhood
gastropub, Rooftop vibes, Vegan metal bar, Beach brewery.* Those describe the **character of the
room** — the thing a visitor uses to choose between two bars on the same block at 4pm — and they
came from a person who had been there, not from Google's type taxonomy.

| | Establishment kind (today's `vibe`) | Character (proposed) |
|---|---|---|
| Question | What sort of place is this on paper? | What is it *like* to drink there? |
| Evidence that works | `primaryType`, name tokens | Menus, deal text, website copy, our boards, neighbourhood context |
| Evidence that fails | Deal text (audit §5), Google's `types` bag | Google's primary type alone, marketing adjectives |
| Coverage expected | ~25% published, by design | Whatever evidence supports; absent otherwise |
| Failure mode if forced | Confident "Cocktail bar" on a Korean BBQ | Confident "dive" on a hotel lobby |

The audit already measured that deal text does not describe the room (four trivia mentions, three
tiki, nothing else useful across 410 published deal strings). Character assessment therefore has to
read a richer packet than kind derivation does — and it has to be allowed to say nothing, for the
same §2.1 / §2.2 reasons that killed filler on `features` and on the old vibe.

The owner's aside about vibe stock-photo fallbacks is noted and accepted: every published happy hour
should carry its own menu board, and `vibeImageFor()` already falls through cleanly. Character work
is not justified by photography. It is justified only if the label itself helps someone choose.

---

## 2. Redesign: proprietary character as a browsing field

### 2.1 Proposed vocabulary

Closed list. Twelve values. Each has to change a visitor's decision between two open happy hours;
if two labels would send the same person to the same chair, they are merged. Marketing adjectives
(`trendy`, `upscale casual`, `chef-driven`) are out — the features experiment already showed those
are unique per venue and unfilterable, and `lounge` was rejected at the name-check in the vibe audit
for decorating restaurant names.

| Value | Why a visitor cares | What would merge into it |
|---|---|---|
| **Dive** | Cheap, no-frills, locals — different trip from a cocktail lounge | Cash-only dive, divey sports bar → sports bar wins if TVs are the pitch |
| **Sports bar** | Watching the game is the reason to go | Sports grill, sports lounge |
| **Neighborhood pub** | Casual local hang, not a destination bar | Tavern, alehouse when the room is the point rather than brewing |
| **Brewery taproom** | Beer-first, often patio; San Diego's densest HH category | Brewhouse, brewpub when brewing is on-site or branded as such |
| **Wine bar** | Wine-forward, usually quieter and smaller | Wine bistro when wine is the draw |
| **Cocktail lounge** | Crafted cocktails, dressier room, sit-down pace | Craft-cocktail bar, hotel bar when the room reads lounge rather than lobby |
| **Rooftop** | View and elevation are the product | Any "rooftop vibes" wording; patio alone does **not** qualify |
| **Waterfront** | Bay / ocean / marina setting — San Diego-specific decision | Beach bar, harbor bar; cuisine prefixes ("waterfront Mexican") are dropped |
| **Gastropub** | Food-forward bar; the menu is why you stay | Neighborhood / Italian gastropub seed values |
| **Tiki** | Thematic tropical cocktails — a deliberate mood | — |
| **Speakeasy** | Hidden / intimate / reservation-leaning cocktail room | — |
| **Arcade bar** | Games are the premise, drinks follow | Game hall, pinball bar |

**Rejected as vocabulary entries, with reasons:**

- **Restaurant, Cafe, Pizza spot, Seafood spot** — cuisine or service format. Useful as `venueKind`;
  they do not answer "what is the room like."
- **Nightlife / nightclub** — rarely a 3–6pm happy-hour destination; when it is, the useful label is
  usually cocktail lounge or something more specific.
- **Upscale / trendy / modern / chef-driven** — adjectives. Pass 1 of the features experiment
  produced a hundred of these and none repeated.
- **Dog-friendly patio, beach brewery, vegan metal bar** — compound claims. Split into character
  plus an amenity or cuisine note; do not mint a vocabulary row per conjunction.
- **Live music bar** — we already store Google's `liveMusic` boolean. A second field that means the
  same thing is how `features` got mushy.

Twelve is enough to browse. It is small enough that a filter facet could exist later without the
silent-omission problem that killed `features` — **provided absence stays visible as absence**, and
the facet is never implied to be complete.

### 2.2 How an AI assessment would work

Copy the features experiment's shape exactly. That method is the one thing that document proved
valuable even though the field died.

**Evidence packet per venue**, assembled from what we already hold, in precedence order:

1. Structured `hhMenu` (section titles, item names, prices / offer kinds) — 281 of 686 published
2. Deal chip text and `weeklySpecials` where present
3. Frozen website page text from the existing crawl cache (same `inventoryWebsite()` budget as
   refresh), clipped around about / vibe / bar / patio language rather than around happy hour alone
4. Captions and filenames of `galleryImages` we own (menu boards are weak character evidence; scraped
   venue photos are stronger but rare — 20 of 391 gallery entries)
5. Name and neighbourhood — context only, never sufficient alone
6. Featured photo — **last and optional.** 597 of 599 are Google Places bytes
   (`docs/google-photo-exposure.md`). Do not make the spike depend on them; if a later pass uses
   vision on our own boards only, meter it separately at the image-block rate ($0.05–$0.10/call),
   not the text rate.

**Prompt contract** (closed vocabulary, one call per venue on the spike):

- Choose **at most one** value from the twelve, or **`none`**.
- Require a **verbatim quote** and a **source id** (menu section, deal string, page URL) for any
  non-`none` answer.
- Forbid inference from establishment kind alone ("it is a brewery, therefore brewery taproom" is
  only allowed when the name or copy actually supports taproom character — and even then kind
  already covers it).
- Forbid marketing-adjective leaps ("family atmosphere" ≠ dive; "upscale dining" ≠ cocktail lounge).
- When two values compete, prefer the one the visitor would use to *filter*, and say so; do not
  invent compounds.

**Absence.** `none` / key omitted is the default. Thin evidence — a stub with no menu, no deals, and
a chain location-picker shell — must not produce a label. The Applebee's-Anchorage and Players
Sports Grill failures in the features experiment are the template: refuse to invent, accept a hole.

**Grounding is not correctness** (`docs/lessons-and-invariants.md` §2.1 / §2.11). Automated check:
every quote must appear in the frozen packet (the features run hit 40/40). Hand check: every
non-`none` label judged `true` / `false` / `uncertain` against the same packet and, where ambiguous,
the live site. A grounded false — "late night" from a midnight close — is still a fail.

### 2.3 Cost at catalog scale

All figures use measured Haiku text rates. Vision on Google photos is out of scope for the first
pass.

| Run | Method | Cost |
|---|---|---|
| Features experiment, 30 venues × 2 passes | Measured | **$0.41** ($0.0137/venue) |
| Character spike, ~40 venues × 1 closed pass | 40 × ~$0.007–0.017 | **~$0.30–$0.70** |
| Published venues with usable website or menu (~600) | 600 × $0.0169 | **~$10** |
| All 3,006 catalog rows with a website (~2,800) | 2,800 × $0.0169 | **~$47** |
| Annual refresh of published, single pass | 4 × 600 | **~$40/year** |

Crawl wall-clock dominates money, as before: a few hours at concurrency 8 against a warm page
cache. The binding constraint is hand acceptance, not dollars — same lesson as
`docs/data-sourcing-plan.md` §6.3.

### 2.4 Validation before trusting the rest

| | Proposal |
|---|---|
| Sample size | **40 published** venues, deterministic SHA-1 draw like the features sample, stratified across current `venueKind` / name patterns, over-weighting rows that have both a menu and deal text (the evidence we claim is decisive) |
| Must include | ≥5 with menu+deals+own website; ≥5 with deals but no menu; ≥5 stubs/thin sites; ≥3 chain location-picker domains; ≥2 of the hand-typed seed vibes as gold controls |
| Automated gate | 100% of quotes found in the frozen packet |
| Hand-check gate | Every non-`none` label reviewed; **pass if ≥85% `true`, ≤10% `false`, and `uncertain` does not ship** |
| Coverage expectation | Not a pass criterion. If only 12 of 40 earn a label and those 12 are true, that is success — the field is a sentence, not a filter yet |
| Kill criteria | Open-vocabulary pass yields mostly one-offs again; closed pass accuracy &lt;80% true; model leans on establishment kind; labels would not change a visitor's pick between two open windows |

Forty rather than thirty because character has a larger vocabulary than the kind field and the
gold-control seeds need room. Still small enough to hand-check completely.

### 2.5 Coexistence with today's `vibe`

**Rename the current field; reclaim `vibe` for character.**

| Field | Meaning | Source |
|---|---|---|
| `venueKind` | Establishment kind (brewery, sports bar, wine bar, …) | Today's derivation — `primaryType` + name, absent when unknown |
| `vibe` | Room character from the vocabulary above | AI assessment + owner claim + admin; absent when evidence is thin |

Reasons to rename rather than add `character` beside `vibe`:

1. **The UI already says "vibe"** on cards and heroes. Visitors read that word as character. Keeping
   establishment kind under that label forever teaches the wrong thing.
2. **The audit already admitted** that `Bar` and `Bar and grill` are thin subtitles. Character is
   what those surfaces actually want when evidence exists; kind remains useful in search and as a
   quiet fallback subtitle when character is absent.
3. **Two fields with overlapping English names** (`vibe` + `character`) will be confused in every
   prompt, form and doc. `venueKind` is ugly and precise on purpose.

Migration rule for the spike: **do not write either field from the spike.** Freeze verdicts beside
the scripts, as `features-field` did. A rename of the existing key is a separate, mechanical PR once
the spike passes — and it must preserve the 19 hand-typed seed values by mapping them into the new
vocabulary or leaving them as owner overrides outside the closed list (same survival rule as
`testHandWrittenVenueKindsSurviveTheDerivation`).

Display rule if both ship: show `vibe` (character) when present; else `venueKind`; else nothing.
Never concatenate ("Brewery · Dive") on the card — that is two answers to two questions fighting for
one pill.

Owner claim form: picker seeded with the twelve, plus "something else" free text, optional. An
owner's answer outranks the model and permanently drops that venue from the refresh budget
(`docs/data-sourcing-plan.md` §1).

---

## 3. Other proprietary fields — keep, defer, or cut

Honest filter: evidence we hold or can cheaply gather, reliability, cost, and whether a happy-hour
visitor's choice changes. "Interesting" is not enough. The features experiment is the prior for
anything extracted from websites.

### 3.1 Keep — build or already almost have

**Happy-hour price band (not restaurant `priceLevel`).**
Google's `priceLevel` / `priceRange` describe the restaurant. A visitor choosing a 4pm stop cares
what the *discounted* pint and the *discounted* taco cost. We now store structured menu offers
(`docs/menu-price-model.md`) — absolute amounts on ~85% of priced items, plus amount-off and
percent-off without inventing a regular price. A band derived only from absolute HH prices we
actually hold (e.g. median absolute item in `$` / `$$` / `$$$` buckets defined against the published
corpus) is proprietary, decision-changing, and mostly rules rather than AI. Absent where the menu is
all discounts with no absolute anchors — do not invent. **First field to schedule after the vibe
spike**, because the evidence is already on disk.

**Signature drink or signature deal.**
Extract the single most distinctive priced line from `hhMenu` / deals — "\$5 Mexican Mules", "half-off
rolling wine list", "\$2 tacos". One string per venue, quote-backed, absent when nothing stands out.
Cheap (can often be rules over item names + prices; AI only for disambiguation). Changes the card
and the meta description in a way Google Maps never will, because Google has no offer text.
**Spike-eligible as a tag-along** on the same frozen packets as character.

**Recency / last-verified as a displayed fact.**
`lastVerifiedAt` sits on 419 rows (363 published) and `lastScrape` on 610, while `verified` is
`true` on zero rows (`docs/data-sourcing-plan.md` §2.4). No AI. Fix the contradiction, then show
"Menu checked 12 Aug 2026" on the venue page. This is the trust move Google and Yelp bury. **Do
this regardless of the vibe spike** — it is product work on fields we already own.

### 3.2 Defer — real question, wrong time or wrong source

**Best for (groups, dates, solo, game).**
We already bought `goodForGroups` and `goodForWatchingSports`. "Good for a date" and "good for solo"
are not on websites in checkable form (features experiment: family-friendly failed on marketing
adjectives). Owner claim checkboxes later; do not AI-extract.

**Deal strength vs peers.**
Needs the price band first, a defined peer set (neighbourhood + kind), and absolute prices. Relative
"% off" without a regular price cannot enter the ranking (`menu-price-model.md` rule: never convert
kinds). Revisit after price band exists on a few hundred menus.

**Kid-friendly / dog-friendly *during HH*.**
`allowsDogs` is already Google Atmosphere. HH-specific policy almost never appears on sites. Owner
claim only.

**Reservation needed vs walk-in culture.**
`reservable` is already present on 1,975 rows. Walk-in-during-HH is rarely published. Surface the
boolean we have; do not invent culture.

**Outdoor / patio quality beyond the boolean.**
`outdoorSeating` was the correct buy after features died. "Quality" needs photos and taste. Our
featured photos are mostly Google's bytes; scoring them with vision buys legal exposure and a
subjective label. Owner photos or a simple "heated / covered / view" claim form later — not an AI
field now.

### 3.3 Cut — not worth it

**Crowd / scene (loud vs quiet date spot).**
Websites lie or stay silent; a model will ground quotes and still guess. High trust damage when
wrong. Cut.

**Hidden gem / tourist-trap signals.**
Editorial judgment without a stable evidence rule. Attractive in a pitch deck; poisonous in a
catalog that already earned a lesson about confident wrong labels. Cut.

**Reviving a multi-value `features` array from websites.**
Already measured. Dead. Do not reopen.

---

## 4. What would make someone choose this site over Google Maps or Yelp

Google and Yelp answer "what restaurants are near me and what did strangers think." They do not
answer "what is discounted between 3 and 6, for how much, in what kind of room, and when did a human
last check."

| Field | Why it wins a visit here | If we owned it and nobody cared |
|---|---|---|
| Character `vibe` | Pick dive vs rooftop vs taproom without reading reviews | Cut — kind alone is enough for the quarter we can name |
| HH price band | Compare *afternoon* cost, not dinner `$$` | Cut |
| Signature deal line | The reason to go, on the card | Cut |
| Last verified date | Trust that the \$5 mule is still \$5 | Still worth showing; trust compounds |
| Deal chips + menu boards | Already our wedge | Protect; do not dilute with soft adjectives |
| Crowd, hidden gem, HH-specific dog policy | Nowhere | Already cut above |

The wedge is not "more attributes than Google." It is **attributes Google cannot have** because they
come from the venue's own happy-hour page and our transcription of it. Character only joins that
list if the spike shows it can be read from that evidence without becoming another confident wrong
subtitle.

---

## 5. Recommended sequence

### Step 0 — display freshness (no spike, no model)

Resolve `verified` vs `lastVerifiedAt`, and put an observed date on published venue pages that have
one. Cost: engineering time. Failure mode: none that resembles the features experiment.

### Step 1 — character vibe spike — DONE, FAIL (1 September 2026)

Ran as designed. Scripts: `scripts/experiments/venue-character/`. Frozen pages and full extraction
live under `.data/experiments/venue-character/` (gitignored); committed summary in
`results.json` + `verdicts.json`.

| Gate | Result |
|---|---|
| Sample | 40 published; strata met (6 deals-no-menu, 5 thin, 29 menu+deals+web, 4 chain, 4 gold seeds) |
| Quote grounding | 17/19 verbatim, 2/19 partial (still in packet); source ids matched |
| Labelled | 19/40 |
| True among labelled | **15/19 (78.9%)** — need ≥85% |
| False among labelled | **4/19 (21.1%)** — need ≤10% |
| Absent | 21/21 absent-correctly; 0 absent-miss |
| Gold controls | False Idol → tiki ✓; Coin-Op → arcade bar ✓; Raised by Wolves / Coasterra → absent on thin packets ✓ |
| Cost | **$0.3882** (40 × Haiku, $0.0097/venue) |
| Catalog writes | **None** |

**Kill criterion hit.** Same autopsy shape as features: the model can quote the page and still
mis-name the room. See §7. Do not tune-and-rerun the catalog.

### Step 2 — blocked by Step 1 fail

- Do **not** rename `vibe` → `venueKind` in order to reclaim `vibe` for character.
- Do **not** ship an owner-claim character picker as a catalog field until (if ever) a new evidence
  rule beats this spike — owner free-text on individual venues remains fine as editorial.
- **Do** schedule rules-first HH price band and signature deal line from absolute menu offers (§3.1);
  those do not depend on this spike.
- Freshness display (Step 0) remains unblocked.

### Step 3 — do not schedule yet

Deal-strength scores, patio quality, crowd, tourist-trap, HH-specific family policy. Re-open only
with new evidence, not with enthusiasm.

---

## 6. What this page is not asking anyone to do

- No catalog writes from the failed spike; no rename in code driven by character.
- No dependence on the in-flight menu WebP / price-model / browser-fetch work; those land on their
  own. Price band *consumes* the offer model once it exists; it does not need character.
- No filter facet for character. Coverage would have been sparse even on a pass; on a fail it must
  not exist.

The owner's instinct is still right: the valuable data is what Google will never publish about a
happy hour. The spike showed character-from-websites is not yet that data. Kill it; spend the next
proprietary dollar on prices and freshness.

---

## 7. Spike autopsy (1 September 2026)

### Sample (40)

Deterministic SHA-1 draw (`venue-character:{id}`) from published rows with a website, strata reserved
before kind fill so menu+deals could not crowd out thin / deals-only / gold / chain slots.

Gold seeds pinned: Raised by Wolves (Speakeasy), False Idol (Tiki), Coasterra (Waterfront Mexican),
Coin-Op Game Room (Arcade bar).

Evidence classes in the draw: 29 menu+deals+own-website, 6 deals-no-menu, 5 thin. 33/40 yielded
pages on the first inventory crawl; the rest were hydrated from warm page cache or plain GET where
possible. Raised by Wolves remained empty (host down) — correctly labelled absent.

### Per-venue summary

Full table and quotes: `scripts/experiments/venue-character/results.json`. Hand notes:
`verdicts.json`. Headline:

| Hand verdict | Count |
|---|---|
| true | 15 |
| false | 4 |
| absent-correctly | 21 |
| absent-miss | 0 |

**False labels (scored harshly):**

| Venue | Model said | Why false |
|---|---|---|
| Tom Ham's Lighthouse | waterfront | Quote was only the Harbor Island street address — context, not character copy |
| BJ's Restaurant & Brewhouse | brewery taproom | Chain full-service restaurant with a branded beer list ≠ taproom room |
| Nolita Hall | gastropub | Quote was only "RESTAURANT + BAR"; dinner menu ≠ gastropub self-claim |
| Bellamy's Restaurant | cocktail lounge | Upscale-restaurant happy-hour cocktail marketing ≠ lounge character |

**True labels that worked** were almost always *self-descriptions*: "classic dive bar", "#1 Sports
Bar", "award-winning rooftop", "Must-Visit Gastropub", "candlelit cocktail lounge", "$10 tiki
cocktails", "part bar, part arcade". When the venue names the room, the model is fine. When it has
to infer, it invents with a citation.

### Pass / fail

**FAIL.** 78.9% true and 21.1% false miss both numeric gates. Cost under budget is irrelevant once
accuracy fails. Recommendation in one sentence: **keep `venueKind` only; do not write character
vibes into the catalog; next proprietary build is HH price band + signature deal + freshness.**
