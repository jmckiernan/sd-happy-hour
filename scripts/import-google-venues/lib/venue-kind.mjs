/**
 * What kind of place a venue is — the field the catalog stores as `vibe`.
 *
 * This replaces `inferVibe()`, which read Google's whole `types` array through
 * a chain of unanchored regexes and fell through to the literal `Restaurant`.
 * Measured against the primary type Google itself assigns, that produced a
 * label that was right 3% of the time on `Cocktail bar` (17 of 506 rows) and
 * 9% on `Nightlife spot`, because `/cocktail|bar/` matches `barbecue_restaurant`
 * and every second bar carries `night_club` somewhere in its type list. See
 * docs/vibe-field-audit.md for the full measurement.
 *
 * Two rules come out of that audit and both are load-bearing here:
 *
 * 1. **The primary type, never the array.** Google's `types` array is a bag of
 *    everything a place might conceivably be — every 7-Eleven in the enrichment
 *    cache carries `restaurant`, `cafe`, `coffee_shop` and `pizza_restaurant`.
 *    `primaryType` is one label Google committed to, and it is
 *    `convenience_store` on all 155 of those same 7-Elevens.
 * 2. **No fallback.** A venue whose kind cannot be read off the primary type or
 *    off the name the owner chose has no kind, and every surface is built to
 *    say nothing rather than guess. `Restaurant` on a third of the catalog was
 *    not a finding, it was the absence of one wearing a label.
 *
 * The name patterns are the second source rather than the first only because
 * the primary type is a single committed answer and a name is a word match;
 * where a name is distinctive enough to appear here it agreed with the type on
 * every row that had both. Every pattern below was hand-checked against the
 * published venues it matches (docs/vibe-field-audit.md §5) — `lounge` was
 * dropped at that check, because "Sushi Lounge" and "Vincenzo Cucina and
 * Lounge" are restaurants.
 */

/**
 * The closed vocabulary, most specific first. Order is the precedence: a place
 * called "Rosati's Pizza Pub and Sports Bar" is a sports bar rather than a pub,
 * and "Belching Beaver Brewery Tavern and Grill" is a brewery rather than a
 * tavern.
 *
 * `types` are Google `primaryType` values; `name` is matched against the venue
 * name. A row matches a kind if either says so.
 */
const VENUE_KIND_RULES = [
  { kind: 'Rooftop bar', types: [], name: /\brooftop\b/i },
  { kind: 'Sports bar', types: ['sports_bar'], name: /\bsports (?:bar|grill|pub)\b/i },
  { kind: 'Brewery', types: ['brewery', 'brewpub'], name: /\b(?:brewing|brewery|brewhouse|brew co|taproom|tap room)\b/i },
  { kind: 'Beer garden', types: ['beer_garden'], name: /\bbeer garden\b/i },
  { kind: 'Winery', types: ['winery'], name: /\b(?:winery|vineyard)\b/i },
  { kind: 'Wine bar', types: ['wine_bar'], name: /\bwine bar\b/i },
  { kind: 'Tiki bar', types: [], name: /\btiki\b/i },
  { kind: 'Speakeasy', types: [], name: /\bspeakeasy\b/i },
  { kind: 'Arcade bar', types: [], name: /\barcade bar\b/i },
  { kind: 'Nightclub', types: ['night_club'], name: null },
  { kind: 'Cocktail bar', types: ['cocktail_bar'], name: /\bcocktail (?:bar|lounge|room)\b/i },
  { kind: 'Gastropub', types: ['gastropub'], name: /\bgastropub\b/i },
  { kind: 'Pub', types: ['pub', 'irish_pub'], name: /\b(?:pub|tavern|alehouse|ale house)\b/i },
  { kind: 'Bar and grill', types: ['bar_and_grill'], name: null },
  { kind: 'Bar', types: ['bar', 'lounge_bar', 'hookah_bar', 'karaoke_bar'], name: null },
  { kind: 'Cafe', types: ['cafe', 'coffee_shop', 'tea_house'], name: null },
];

/** Every kind this module can produce. */
export const VENUE_KINDS = VENUE_KIND_RULES.map((rule) => rule.kind);

/**
 * The kind of place, or `undefined` when neither source answers.
 *
 * `undefined` is the common case and is the correct one: on the catalog as it
 * stands this answers for roughly a third of rows, and the two thirds it
 * declines are restaurants Google typed by cuisine, which is what they serve
 * rather than what kind of room they are.
 */
export function deriveVenueKind({ name = '', primaryType = '' } = {}) {
  const type = String(primaryType || '').toLowerCase();
  const label = String(name || '');
  for (const rule of VENUE_KIND_RULES) {
    if (type && rule.types.includes(type)) return rule.kind;
    if (rule.name && rule.name.test(label)) return rule.kind;
  }
  return undefined;
}
