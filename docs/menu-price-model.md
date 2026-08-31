# Prices and discounts on a happy-hour menu

## The problem

`hhMenu.sections[].items[].price` was named and typed as though every menu line
states what an item costs. Plenty do not. A happy hour published as "$2 off all
draft pints" is a complete, ordinary offer — not a half-recorded price — and the
field held hundreds of them.

Confirmed counts across 3,572 priced items:

| Kind | Count | Share |
| --- | --- | --- |
| absolute — the item costs this | 3,025 | 84.7% |
| amount_off — this much off the regular price | 239 | 6.7% |
| percent_off — this share off the regular price | 179 | 5.0% |
| unclassified | 115 | 3.2% |
| multi — several prices, undistinguished | 7 | 0.2% |
| range — a printed span | 4 | 0.1% |
| bundle — a quantity deal | 3 | 0.1% |

**418 items are a saving rather than a cost**, and 547 are not absolute prices.
The lessons doc estimated ~480; the true discount figure is 418.

Two consequences, neither visible from the page:

- The board typeset "$2 off" in the slot built for "$8" — bold, accent-coloured,
  right-aligned — so it read as a price. It rendered plausibly, which is why
  nobody noticed.
- Anything reasoning numerically saw "$2" where the item may well cost $10.

## The model

The printed text stays exactly as the venue wrote it, in `price`. A sibling
`offer` says what that text means:

```json
{
  "name": "Draft pints",
  "price": "$2 off",
  "offer": { "kind": "amount_off", "amountOff": 2 }
}
```

Kinds: `absolute` (`amount`), `amount_off` (`amountOff`), `percent_off`
(`percentOff`), `range` (`min`, `max`), `multi` (`amounts`), `bundle`
(`quantity`, `amount`, `forQuantity`, `freeQuantity`).

Why this shape:

- **`price` is untouched**, so nothing that displays it can regress, and the
  venue's own wording is never paraphrased into our vocabulary.
- **The numeric fields only exist where they mean something.** There is no
  `amount` on a discount, so no caller can accidentally treat a saving as a
  price — the field simply is not there to read.
- **Absent `offer` means unknown**, never absolute.

### The rule that governs everything

**Never convert between kinds.** We do not know the regular price, so a discount
yields no absolute figure, and an absolute figure yields no saving. `½ off` is
stored as `percent_off: 50` because half off *is* fifty percent off — the same
statement, not an inference about what anything costs.

`absoluteAmountOf()` returns a figure only for `absolute`, and for `range` and
`multi` the lowest price the venue actually published. For every discount it
returns `null`, so sorting and filtering get nothing rather than a wrong number.

## Display

A saving and a cost sit in the same right-hand column a printed menu uses, but
are set differently, so scanning the column distinguishes "this costs $8" from
"this is $2 cheaper than usual":

- Absolute, range, multi, bundle: bold, sunset accent — unchanged.
- `amount_off` / `percent_off`: lighter weight, italic, cool off-white on the
  board and `--night-soft` on the page.

Applied in both places that render a menu: `lib/menu-board-image.mjs`
(`.item-discount`) and `VenueHappyHourPage.astro`
(`.hh-menu-price--discount`). Discounts are phrases rather than short figures,
so the price cell is `white-space: nowrap` to stop "half price" breaking across
lines mid-phrase.

## Extraction

The transcription prompt now asks for `priceKind` alongside `price`, with the
kinds spelled out and an explicit instruction not to convert between them, and
to omit the kind rather than choose the nearest when the printed text is unclear.

The model's answer is **not** the source of truth. `normalizeMenuBoard` parses
the printed text and uses that; `priceKind` is a second opinion, and where the
two disagree the text is genuinely unclear and **neither** reading is stored.
Storing a kind the text does not support is worse than storing none, because the
board then typesets a confident lie.

## Downstream

`seo.ts` publishes `offers.price` only for `kind: 'absolute'`. It previously
guarded with a strict `^\$\d+$` regex, which was accidentally correct; it now
reads the kind, which says why. Emitting a discount's figure would tell Google
an item costs $2 when it costs $2 less than usual.

No other code in `src/` parses a menu price numerically, so there was no sorting
or filtering to correct — but the model is now in place before any is written.

## Migration

`backfill-menu-offers.mjs` classified 3,458 items. It rewrites no price text and
infers nothing; an item whose text fits no kind is left with no `offer` and
reported. It re-derives from the copy on disk at write time, since the catalog is
shared with other long-running jobs.

## Left for a human: 115 items, 75 distinct strings

These were deliberately not guessed. Roughly a hundred are **not prices at all** —
a separate bug where ingredient descriptions leaked into the price field, which
this surfaced rather than papered over:

| Listing | stored "price" |
| --- | --- |
| Coasterra (11 items) | `avocado, red onion, toma`, `local fish, pico de gall`, `bud light, victoria, pac` |
| C Level Lounge (4 items) | `cutwater vodka, passionf`, `ask your server for toda` |

All are truncated at 24 characters, which is `normalizeMenuBoard`'s price cap —
so the description was landing in `price` at transcription time. Worth a targeted
re-transcription of those two listings.

The genuine but unparseable remainder are real offers in shapes too varied to
pattern-match safely, and should be read by a person:

- `$6/5 Wings` (Phil's BBQ) — plausibly $6 for 5 wings, but not certain enough.
- `$3 for 8oz / $5 for 16oz` (Tom Ham's Lighthouse) — two sizes.
- `$3 Each (Min Order 2)` (Local Tap House)
- `priced fair`, `fair prices` (Waterfront Bar & Grill) — not prices.

## Tests

`tests/menu-price.test.mjs`, in `npm test`:

- Each kind parses as itself.
- **A discount never yields an absolute price**, and an absolute price is never
  reported as a discount.
- Ambiguous text stays unclassified rather than being guessed.
- Transcription stores the offer beside the untouched printed text.
- A model `priceKind` contradicting the text is discarded.
- Every stored price in the catalog agrees with its recorded offer, and the
  catalog contains many discounts — so the discount path cannot rot into dead
  code guarded by a test that passes on an empty set.
