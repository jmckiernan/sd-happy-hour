# Re-reading the menus the four-section cap may have cut

72 listings sat on exactly four menu sections. Four was the old cap, so each of
them was either a genuine four-section menu or a longer one trimmed to fit, and
nothing in the data distinguishes the two. This is what re-reading them from
source found.

## The cap was in three places, not one

Worth recording, because two of the three were fixed before this pass and the
third would have quietly reproduced the problem:

1. `normalizeMenuBoard` dropped sections past the fourth and items past the
   24th. Fixed last week; the bounds are now 12 and 60.
2. The board renderer assumed one page. Fixed by pagination.
3. **The extraction prompts capped the model itself.** The main prompt said
   "Max 4 sections, 20 items each" and the menu-only prompt ended "Max 4
   sections, 24 items each" — each directly contradicting its own instruction
   two lines earlier to transcribe every line and treat a missing item as a
   failure. A re-scrape against those prompts would have returned four sections
   and confirmed the truncation as genuine.

The menu-board call's output budget was also raised from 4096 to 8192 tokens: a
twelve-section menu does not fit the smaller budget, and the failure mode is
JSON cut off mid-item.

## The split

Six were re-read and applied in a first pass; the rest were re-read three times
each under the consensus rule below. Counted against the original 72:

| Outcome | Count |
| --- | --- |
| Stored a fuller menu — **19 of them past the old cap**, so demonstrably truncated | 29 |
| Confirmed genuinely four sections | 12 |
| Needs a human look | 15 |
| Could not be re-read at all | 16 |

The 29 recover **+57 sections and +267 items**.
The largest gains: O'Sullivan's Irish Pub Escondido and La Puerta both 4→12
sections, Hooleys Public House 4→12, Puesto La Jolla 4→11, Bier Garden
Encinitas 4→9.

So about a quarter of the cohort was demonstrably truncated, a sixth was
genuinely four sections, and the remaining 43% could not be settled by
re-reading — a JavaScript-only site or two reads that disagreed.

## One read is not a verdict

The important methodological finding. Asked three times for the same already
fetched pages, the model returned:

| Venue | Stored | Three reads |
| --- | --- | --- |
| Karl Strauss | 4 sections | 5, 5, 6 |
| The Blind Burro | 4 sections | 6, 6, 6 |
| The Rabbit Hole | 4 sections | 5, 6, 3 |
| Hooleys Public House | 4 sections | 12, 12, 12 |
| Trattoria da Sofia | 4 sections | 7, 7, 7 |

The spread on The Rabbit Hole is wider than the question being asked. Karl
Strauss was classified "+3 sections, +13 items" on one call and "lost 4 items"
on the next. A single re-read therefore cannot decide whether a menu was
truncated, which is why the pass requires two of three reads to agree on the
section count before believing any of them, and takes the fullest of the
agreeing reads.

Item counts still wobble inside an agreeing group — Hooleys came back as twelve
sections three times running with 45, 47 and 49 items. That spread is recorded
per venue in `.data/capped-menu-rescrape.json` rather than used to reject the
read, because the variation is in what the model omits, never in what it adds.

## Two guards that earned their place

**Matching items by name was too strict.** The first pass compared stored items
against re-read items individually and rejected any read that had dropped one.
That put 28 venues in "ambiguous" mostly wrongly: a truncated menu often stored
a catch-all line — "drafts", "wines", "apps" — where a complete read lists the
actual beers. The catch-all disappearing is the improvement. The test is now on
totals: a read that comes back shorter is still refused, but a rewording is not
mistaken for a loss.

**Prices catch a menu that is the wrong menu.** Trattoria da Sofia's happy-hour
page is rendered in JavaScript and its text comes back nearly empty, so the page
ranker — which ranks by how many prices a page holds — handed the model the
dinner and wine-list pages instead. It transcribed a $165 Barolo and a $190
bottle as happy-hour items, 53 items where 22 were stored. The cap used to limit
the blast radius of that; nothing does now. A menu with three or more items over
$60 is refused as a wine or dinner list, and Trattoria's stored menu was left
alone. It was the only one of the 30 affected — every other recovered menu tops
out at $48.

## What could not be re-read (16)

Herb & Wood (both listings), STK Steakhouse, Meze Greek Fusion, Bencotto Italian
Kitchen, Eddie V's Prime Seafood, Kettner Exchange, Zama San Diego, Lighthouse
Oyster Bar & Grill, Hapa J's, Amalfi Cucina Italiana San Marcos, Pal Joey's
Cocktail Lounge, Waverly, California English, Nick & G's Restaurant, Red Tail
Bar & Grill.

All are "no menu came back" rather than a dead link.

**Correction, after re-reading these with the browser crawl.** This section
originally claimed almost all were JavaScript shells needing browser-mode
fetching. That was wrong, and the re-scrape script's failure to pass
`browserFetch` was only part of the story. Read both ways, five of the sixteen
were genuinely unreadable by a plain fetch — Hapa J's, Nick & G's, Meze Greek
Fusion and both Eddie V's listings, four of which served a 16-character body.
Hapa J's yielded 30 prices through the browser and was re-transcribed.

The other eleven fetched fine: STK Steakhouse returned 20,654 characters with ten
prices in it. Their failure was downstream of the fetch — the page ranker picking
the wrong page, or the transcription finding nothing it would call a happy-hour
menu. See `docs/browser-fetch-coverage.md`.

## Needs a human look (15)

Fifteen listings. Reads disagreed too widely to trust, came back shorter than
what is stored, or produced prices that were not happy-hour prices:
Rockin' Baja Lobster Oceanside, Jimmy's Famous American Tavern Point Loma,
Gossip Grill, El Pueblo Mexican Food Carlsbad, The Rabbit Hole, Pacific Catch,
Bellamy's Restaurant, Bayside Landing, Sushi Lounge Encinitas, Mangia e Bevi,
Shores Bar + Kitchen, Rare Society, Sky Deck at Del Mar Highlands, Chauncey's
Pizza & Bar, Trattoria da Sofia.

Sky Deck is a different failure: the only page found is the shopping centre's
own, `delmarhighlandstowncenter.com`, which `conflictsWithVenue` rejects as a
different location. Sushi Lounge Encinitas is the starkest of the rest — the
re-read came back 40 items shorter than the 42 on file, so the stored menu is
much the better record and was kept.

None of these had anything written to them.

## Provenance

Every recovered menu now records the page it was read from and the date. That
was not true before: only 2 of the 72 had a `sourceUrl` at all, because
`normalizeMenuBoard` rebuilt each board from `note` and `sections` alone and
dropped provenance on every re-render.

That same bug orphaned 255 scraped flyer images, which looked at first like
fallout from the chain purge. They are not: each is named for a listing that
still has a menu but no `sourceImages`, so they are the images those menus were
transcribed from. They are reattached as `menuCandidateImages` rather than
deleted — see `relink-orphan-menu-flyers.mjs` for why that field and not
`sourceImages`.

## Cost

195 model calls for the three-read pass over 67 venues, plus 73 for the first
pass and the variance probe: **$4.53 in total**, about $0.016 a call. Re-reading
the whole 611-listing catalog this way would cost roughly $30.

## Reproducing

```
node scripts/import-google-venues/rescrape-capped-menus.mjs              # report
node scripts/import-google-venues/rescrape-capped-menus.mjs --apply
node scripts/import-google-venues/rescrape-capped-menus.mjs --reads=5    # stricter
```

Findings land in `.data/capped-menu-rescrape.json`. Re-render afterwards with
`render-menu-boards.mjs --apply --venue=...`, which the script prints for you.
