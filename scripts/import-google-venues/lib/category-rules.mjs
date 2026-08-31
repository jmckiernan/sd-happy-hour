/**
 * Kinds of place that cannot be a happy-hour venue, whoever owns them.
 *
 * The brand axis lives in chain-blocklist.mjs. This is the category axis, and
 * the two must not be argued from each other's evidence: Starbucks is out and a
 * local coffee shop is in, so `coffee_shop` is deliberately absent from here
 * despite a 1.9% hit rate.
 *
 * A category earns a place on this list only by failing all three of the
 * owner's tests at once — no location of any brand in it would ever run a
 * special, and no owner would ever claim the page. That is a much shorter list
 * than "categories that yield no happy hours". A quiet boba shop is inventory;
 * a 7-Eleven is pollution. Both score 0%.
 *
 * Measured against the catalog on 31 August 2026: every type below holds zero
 * happy hours across 3,208 listings. See docs/venue-category-audit.md for the
 * per-category reasoning and for the categories that look like candidates and
 * are not.
 *
 * Match on `primaryType` only, never on `types` membership. This is
 * load-bearing: `manufacturer` appears in the `types` of 204 catalog listings
 * at an 18.1% hit rate, because Google tags a brewery as a manufacturer.
 * Excluding on `types` would delete a fifth of the breweries.
 */
export const EXCLUDED_PRIMARY_TYPES = new Set([
  // Shops. You buy here and drink somewhere else.
  'convenience_store',
  'gas_station',
  'grocery_store',
  'supermarket',
  'asian_grocery_store',
  'department_store',
  'shopping_mall',
  'store',
  'wholesaler',
  'supplier',
  'book_store',
  'gift_shop',
  'toy_store',
  'home_goods_store',
  // No storefront to sit in and no window to discount. Only `meal_delivery`,
  // and only because the listings under it really are Michaela's Meals and
  // Meal Prep Sunday. `fast_food_restaurant`, `meal_takeaway`, `pizza_delivery`
  // and `catering_service` were on the proposed list and came off it: checked
  // against the catalog they are mostly Google mistyping local independents —
  // Angelo's Burgers, Mariscos Gonzalez, It's Raw Poke Shop, Leucadia Pizza —
  // each of which passes the owner's third test on its own. The brand list is
  // the right tool for the corporate half of that type. See the audit doc.
  'meal_delivery',
  // Services and institutions that are not venues at all. Individually one or
  // two listings; collectively a guaranteed zero and a page a visitor can land
  // on.
  'nail_salon',
  'beauty_salon',
  'spa',
  'art_gallery',
  'art_studio',
  'government_office',
  'educational_institution',
  'non_profit_organization',
  'community_center',
  'coworking_space',
  'tour_agency',
  'travel_agency',
  'indoor_playground',
  'athletic_field',
  'fitness_center',
  'gym',
  // Lodging as a building. `hotel` is deliberately absent — the hotel bar is
  // real, and The Pearl, TOWER23 and La Valencia are in the catalog under it.
  'lodging',
  'motel',
  'rv_park',
]);

/**
 * Names that keep a place regardless of its type.
 *
 * Google's `primaryType` is sometimes simply wrong, and the failure is not
 * hypothetical: SD TapRoom is a genuine taproom with a genuine happy hour that
 * Google types `pizza_delivery`. It is the one place in the catalog carrying an
 * excluded type and a happy hour, and this pattern is why it survives.
 *
 * The same idea already guards looksLikeShoppingMall() in venue-quality.mjs —
 * a named restaurant inside a mall is not the mall.
 */
const VENUE_NAME_SIGNAL =
  /\b(bar|pub|tavern|taproom|tap room|cantina|brew|brewery|brewing|brewhouse|lounge|grill|kitchen|cocktail|saloon|winery|speakeasy)\b/i;

export function hasVenueNameSignal(name) {
  return VENUE_NAME_SIGNAL.test(String(name || ''));
}

/**
 * Should this place be dropped on its category alone?
 *
 * Takes the primary type and the name separately because the callers hold them
 * in different shapes — a discovery candidate, an enriched Place Details
 * record, and a catalog listing joined back to one.
 */
export function isExcludedCategory(primaryType, name) {
  if (!primaryType || !EXCLUDED_PRIMARY_TYPES.has(primaryType)) return false;
  return !hasVenueNameSignal(name);
}
