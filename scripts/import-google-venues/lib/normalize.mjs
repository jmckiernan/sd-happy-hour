import { COUNTY_BOUNDS, DAY_NAMES, DEAL_TYPES } from './constants.mjs';
import { finalizeDeals } from './deals.mjs';
import { assignNeighborhood } from './neighborhood-assign.mjs';
import { isUsableVenueWebsite } from './website-ownership.mjs';
import { unverifiedWindowHold } from './seo-visibility.mjs';
import { deriveVenueKind } from './venue-kind.mjs';

/**
 * `{ vibe }` when the venue's kind can be read off its name or Google's primary
 * type, and `{}` when it cannot. Spread rather than assigned so an unknown kind
 * leaves the key off the record entirely: a listing with no `vibe` is a listing
 * nobody has established the kind of, and that has to be distinguishable from
 * one we looked at and could describe.
 */
function venueKindPatch(record, name) {
  const kind = deriveVenueKind({ name, primaryType: record.primaryType });
  return kind ? { vibe: kind } : {};
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function inCounty(lat, lng) {
  return lat >= COUNTY_BOUNDS.minLat && lat <= COUNTY_BOUNDS.maxLat
    && lng >= COUNTY_BOUNDS.minLng && lng <= COUNTY_BOUNDS.maxLng;
}

export function guessNeighborhood(lat, lng, formattedAddress = '') {
  return assignNeighborhood(lat, lng, formattedAddress);
}

/**
 * Vocabulary for each deal type, read off the deal text the catalog already
 * publishes rather than guessed at: every branch below matches at least one
 * live venue's offers. Brand names are in because plenty of venues quote a
 * price against the beer rather than the word ("Bud Light, Victoria, Pacifico"
 * was the whole of one venue's draft list).
 *
 * Sangria and sake sit under `wine` because that is what they are made of, and
 * mimosas under `cocktails` because that is how a bar sells them. Word
 * boundaries are load-bearing: an unanchored `ale` matches "wholesale" and an
 * unanchored `gin` matches "ginger".
 */
const DEAL_TYPE_PATTERNS = [
  ['beer', /\bbeers?\b|\bcervezas?\b|\bdrafts?\b|\bdraughts?\b|\bpints?\b|\bpitchers?\b|\blagers?\b|\bales?\b|\bipas?\b|\bpilsners?\b|\bstouts?\b|\bbrews?\b|\bschooners?\b|\bcrowlers?\b|\bdomestics?\b|\bimports?\b|\bon tap\b|\btaps?\b|\bbiergar|\bbud light\b|\bcoors\b|\bmichelob\b|\bmodelo\b|\bpacifico\b|\bcorona\b|\btecate\b|\bestrella\b|\bvictoria\b|\bguinness\b|\bperoni\b|\bsapporo\b|\btsingtao\b|\bkirin\b|\bstella\b|\bmiller\b|\bdos equis\b/],
  ['cocktails', /\bcocktails?\b|\bmargaritas?\b|\bmargs?\b|\bmartinis?\b|\bmojitos?\b|\bmules?\b|\bpalomas?\b|\bmai tais?\b|\bnegronis?\b|\bspritz\b|\bcaipirinhas?\b|\bsidecars?\b|\bcosmopolitans?\b|\bgreyhounds?\b|\bscrewdrivers?\b|\bhighballs?\b|\bold fashioneds?\b|\bbloody mar(?:y|ys|ies)\b|\bmarys\b|\bmimosas?\b|\britas?\b|\blong island\b|\bwells?\b|\byou call it\b|\bspirits?\b|\bliquor\b|\btequilas?\b|\bwhiske?ys?\b|\bbourbons?\b|\bvodkas?\b|\bgin\b|\brum\b|\bmezcals?\b|\bsojus?\b|\bshots?\b|\bshooters?\b|\baperol\b/],
  ['wine', /\bwines?\b|\bchardonnay\b|\bcabernet\b|\bpinots?\b|\bgrigio\b|\bsauvignon\b|\bmerlot\b|\bmalbec\b|\bmoscato\b|\bros[eé]\b|\bproseccos?\b|\bchampagnes?\b|\bfrizzante\b|\bbubbl(?:es|y)\b|\bsangrias?\b|\bsakes?\b|\bcorkage\b/],
  ['food', /\bfoods?\b|\btacos?\b|\bappetizers?\b|\bapps\b|\bsnacks?\b|\bbites?\b|\bpizzas?\b|\bslices?\b|\bburgers?\b|\bwings?\b|\bfries\b|\btots\b|\bnachos\b|\bsliders?\b|\bquesadillas?\b|\bplates?\b|\bstarters?\b|\bentr[eé]es?\b|\bshareables?\b|\bsharable\b|\bsushi\b|\brolls?\b|\bflatbreads?\b|\bchips\b|\bdips?\b|\bguacamole\b|\bqueso\b|\bcalamari\b|\bshrimp\b|\bmussels?\b|\bedamame\b|\bempanadas?\b|\bceviche\b|\bsalads?\b|\bpasta\b|\bsandwich|\bwraps?\b|\btortas?\b|\bbirria\b|\bcarnitas\b|\basada\b|\bpupus\b|\btapas\b|\bmeatballs?\b|\bpretzels?\b|\bhummus\b|\bfalafel\b|\bgyros?\b|\bpoke\b|\btuna\b|\bsalmon\b|\bchicken\b|\bcheese\b|\bfish\b|\bdesserts?\b|\bcake\b|\bgelato\b/],
  ['oysters', /\boysters?\b|\bshuck/],
  ['entertainment', /\bentertainment\b|\btrivia\b|\bkaraoke\b|\bbingo\b|\bmusic\b|\bdjs?\b|\bopen mic\b|\barcade\b|\bgames?\b/],
];

const DRINK_DEAL_TYPES = ['beer', 'cocktails', 'wine'];

/**
 * What a happy hour discounts, read from the venue's own published deal text.
 *
 * This used to concatenate the deal text with Google's place `types` into one
 * blob and default to `food` when nothing matched. Google tags essentially
 * every eating establishment with the literal type `food` — 4,876 of the 5,361
 * places in the enrich cache — so `food` landed on 96% of scheduled venues
 * whatever they actually discounted, and the deal text's own evidence was
 * indistinguishable from the taxonomy's afterwards. The deal text is also ours:
 * scraped from the venue's site, with none of the caching terms Places content
 * carries (docs/places-api-cost-analysis.md §2.6).
 *
 * `alcohol` is Google's cached `servesBeer` / `servesWine` / `servesCocktails`,
 * and it is deliberately subordinate: **deal text wins wherever it names a
 * drink at all.** The booleans only say what a venue pours, the deal text says
 * what it discounts, and those are different claims — a brewery that serves
 * wine but only ever discounts beer should not be filterable under wine. So the
 * booleans fill a silence and never contradict a statement.
 *
 * Returns `[]` when the text names nothing: a venue whose window we know and
 * whose offers we do not is what `dealsUnknown` already describes.
 */
export function inferDealTypes(deals = [], alcohol = {}) {
  const text = deals.join('\n').toLowerCase();
  const found = new Set();
  for (const [type, pattern] of DEAL_TYPE_PATTERNS) {
    if (pattern.test(text)) found.add(type);
  }
  if (!DRINK_DEAL_TYPES.some((type) => found.has(type))) {
    if (alcohol.servesBeer) found.add('beer');
    if (alcohol.servesWine) found.add('wine');
    if (alcohol.servesCocktails) found.add('cocktails');
  }
  // Ordered by DEAL_TYPES so the same offers always serialize the same way.
  return DEAL_TYPES.filter((type) => found.has(type));
}

/**
 * The Atmosphere booleans we publish, read straight off Google's response.
 *
 * Nothing is inferred here, and nothing is defaulted. A key is written only
 * when Google answered, so an absent key means "nobody has told us", which is
 * a different statement from `false`. That distinction is the whole point: the
 * `features` array this replaced could not make it, so a venue without a
 * `patio` tag and a venue nobody had asked about looked identical
 * (docs/features-field-experiment.md §7).
 *
 * The set is chosen on fill rate and on whether it helps someone decide where
 * to drink tonight (docs/places-api-cost-analysis.md §5). Deliberately absent:
 * `servesBeer`/`servesWine`/`servesCocktails`, which already reach the page
 * through `dealTypes` and would say the same thing twice; `delivery`,
 * `takeout`, `dineIn` and `curbsidePickup`, which describe how food leaves the
 * building and not what a happy hour is; the `serves*` meal variants, which are
 * a restaurant-guide concern; and `goodForChildren`/`menuForChildren`, which
 * are off-audience here. `openingDate` and `subDestinations` are excluded on
 * evidence rather than judgement — Google answered neither for any of the 2,787
 * venues we bought.
 */
const PUBLISHED_ATMOSPHERE_BOOLEANS = [
  'outdoorSeating',
  'allowsDogs',
  'reservable',
  'liveMusic',
  'restroom',
  'goodForGroups',
  'goodForWatchingSports',
  'servesVegetarianFood',
];

/**
 * Google's grouped booleans (parking, payment, accessibility).
 *
 * The same three-state rule applies one level down: a sub-key Google omitted is
 * unknown, not false, so the object is copied key by key rather than wholesale
 * and an object with nothing known is dropped instead of published empty.
 */
const PUBLISHED_ATMOSPHERE_GROUPS = ['parkingOptions', 'paymentOptions', 'accessibilityOptions'];

function copyKnownBooleans(group) {
  if (!group || typeof group !== 'object') return null;
  const known = {};
  for (const [key, value] of Object.entries(group)) {
    if (typeof value === 'boolean') known[key] = value;
  }
  return Object.keys(known).length ? known : null;
}

function atmosphereAmenities(record = {}) {
  const amenities = {};
  for (const field of PUBLISHED_ATMOSPHERE_BOOLEANS) {
    if (typeof record[field] === 'boolean') amenities[field] = record[field];
  }
  for (const field of PUBLISHED_ATMOSPHERE_GROUPS) {
    const known = copyKnownBooleans(record[field]);
    if (known) amenities[field] = known;
  }
  if (typeof record.priceLevel === 'string' && record.priceLevel) {
    amenities.priceLevel = record.priceLevel;
  }
  // Only useful as a pair; a range with one end is not a range.
  if (record.priceRange?.startPrice?.units && record.priceRange?.endPrice?.units) {
    amenities.priceRange = {
      startPrice: Number(record.priceRange.startPrice.units),
      endPrice: Number(record.priceRange.endPrice.units),
      currencyCode: record.priceRange.startPrice.currencyCode || 'USD',
    };
  }
  return amenities;
}

export { atmosphereAmenities, PUBLISHED_ATMOSPHERE_BOOLEANS, PUBLISHED_ATMOSPHERE_GROUPS };

const MAX_WINDOW_MINUTES = 8 * 60;
const MIN_WINDOW_MINUTES = 30;

/**
 * Is this a happy hour, or did we just read the restaurant's opening hours?
 *
 * Three Cheesecake Factories came through as 11:00–22:00 and a casino as
 * 13:00–08:00. Nobody discounts for eleven hours; those are business hours
 * that happened to sit near the words "happy hour". Ending at midnight
 * (`00:00`) is allowed ("until midnight"); any other end-before-start wrap
 * is refused — this product does not publish overnight happy hours.
 */
export function isPlausibleWindow(startTime, endTime) {
  const toMinutes = (value) => {
    const [h, m] = String(value).split(':').map(Number);
    return h * 60 + m;
  };
  const start = toMinutes(startTime);
  const endRaw = toMinutes(endTime);
  if (endRaw < start && endTime !== '00:00') return false;
  const end = endRaw <= start ? endRaw + 24 * 60 : endRaw;
  const span = end - start;
  return span >= MIN_WINDOW_MINUTES && span <= MAX_WINDOW_MINUTES;
}

// `½` has to be here alongside "half" and "1/2". Without it, "½ off appetizers
// Mon–Fri 3–6pm" reads as priceless, and the "names two days, quotes no price"
// rule below then throws away a perfectly good deal.
const OFFER_SIGNAL = /\$|\d\s*(?:off|for)|%|[½¼⅓]|half[- ](?:off|price)|1\/2\s*(?:off|price)|\bfree\b|\bbogo\b|two for|\bdiscount/i;

/**
 * Site furniture the readers pick up alongside the real offers: nav labels,
 * cookie and age notices, and the venue's opening-hours table. "Reserve",
 * "Jobs" and "Must be 21+ to enter." all reached deal chips this way — short
 * enough to pass the length test and naming no price to fail the offer test.
 */
const BOILERPLATE = new RegExp(
  [
    '^(reserve|reservations?|jobs|careers|menus?|order( online)?|gift cards?|contact( us)?|about( us)?|hours|directions|location|locations|catering|events?|shop|home|blog|news|faq|privacy|terms|sign ?up|subscribe|newsletter|follow us|book( now| a table)?)\\b',
    'skip to (main )?content',
    'must be \\d+\\+?',
    "^(we'?re |now )?open( daily| now)?\\b",
    '^join us',
    '^\\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*\\s*[-–—]\\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*\\s*:?\\s*$',
    'indicates required fields',
  ].join('|'),
  'i'
);

/**
 * Drop "deals" that are really page titles or marketing copy.
 *
 * The extractor will happily hand back "FIREHOUSE American Eatery & Lounge" or
 * "Best Gaslamp Happy Hour | American Junkie San Diego" — the name of the page
 * it read, not anything you can order. A line earns its place by naming a
 * price or a discount, or by being short enough to read as an item.
 */
/**
 * Lines that name no offer at all.
 *
 * "Happy hour" is the label on the section the extractor was reading, not
 * something you can order, and it arrived as the only "deal" for 86 of 112
 * staged venues. A venue in that state knows its window but not its offers,
 * which the catalog already expresses with `dealsUnknown`.
 */
const NOT_AN_OFFER = [
  /^happy\s*hours?!?$/i,
  /^happy\s*hour\s*(?:menu|specials?|deals?)$/i,
  /^(?:daily|weekday|weekend)\s*specials?$/i,
  /^(?:daily|weekday|weekend|late\s*night|all\s*day)\s*happy\s*hours?$/i,
  // "at The Deck" — a location fragment left over from a sentence.
  /^(?:at|in|on)\s+\w+(?:\s+\w+)?$/i,
  /^call\s+us\b|^\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/i,
  /^(?:order|parties|reservations?|catering|menu|specials?|deals?|drinks?|food)$/i,
  // An unfinished storefront, read verbatim off the page.
  /you have no products/i,
  /\[empty page content\]/i,
  // The extractor's own note about what it could not find, which is a
  // description of our failure and never an offer. A venue publishing its menu
  // as an image leaves the section headings in the page text and no items, and
  // "Beverages [no items listed]" reached a live deal chip that way. Kept
  // narrow so a dietary marker like "[GF]" is not mistaken for an annotation.
  /\[[^\]]{13,}\]/,
  /\[[^\]]*(?:no items|not listed|empty|unknown)[^\]]*\]/i,
  /\b(?:no|none)\s+items?\s+listed\b|\bnot\s+listed\b|\bnone\s+listed\b/i,
  // "Mon-Thu &", "Fri &" — a day range the extractor cut mid-sentence.
  /^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:\s*[-–]\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)?\s*[&,:]?\s*$/i,
];

export function stripNonOffers(deals, venueName = '') {
  const nameTokens = String(venueName)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);

  const DAY_WORD = /\b(mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?\b/gi;

  return deals.filter((deal) => {
    // Sites use curly apostrophes, which would otherwise slip past the
    // boilerplate patterns ("We're open" vs "We’re open").
    const text = String(deal || '').replace(/[\u2018\u2019]/g, "'").trim();
    if (!text || text.length < 3) return false;
    if (NOT_AN_OFFER.some((pattern) => pattern.test(text))) return false;
    if (BOILERPLATE.test(text)) return false;
    // A line that only ends a label ("Happy Hour:", "Wednesday - Sunday:")
    // introduces the offers; it is never one itself.
    if (/:$/.test(text) && !OFFER_SIGNAL.test(text)) return false;
    if (OFFER_SIGNAL.test(text)) return true;
    // Names several days and quotes no price: an opening-hours row, not a deal.
    if ((text.match(DAY_WORD) || []).length >= 2) return false;
    // No price and it echoes the venue's own name: that is a heading.
    const lower = text.toLowerCase();
    const echoes = nameTokens.filter((token) => lower.includes(token)).length;
    if (echoes >= 2 || (echoes >= 1 && text.length > 30)) return false;
    return text.length <= 60;
  });
}

export function normalizeVenue(record, nextId) {
  const lat = record.location?.latitude ?? record.lat;
  const lng = record.location?.longitude ?? record.lng;
  if (!inCounty(lat, lng)) return null;

  const name = record.displayName?.text || record.displayName || record.name || '';
  if (!name.trim()) return null;
  const address = record.formattedAddress || record.address;
  // Some venues have no site of their own, or only a Facebook/Yelp page we
  // refuse to treat as one. Their Google listing is then the only place a
  // reader can go, and every published listing needs somewhere to point.
  const ownSite = isUsableVenueWebsite(record.websiteUri || record.website)
    ? (record.websiteUri || record.website)
    : '';
  const website = ownSite || record.googleMapsUri || '';
  const hh = record.happyHour;
  if (!hh?.startTime || !hh?.endTime || !hh?.days?.length) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hh.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hh.endTime)) return null;

  if (!isPlausibleWindow(hh.startTime, hh.endTime)) return null;

  // When nothing survives, say so rather than falling back to filler. We know
  // the window; claiming to know the offers is what puts "Happy hour" on a card
  // as though it were a deal.
  const offers = stripNonOffers(hh.deals || [], name);
  const deals = offers.length ? finalizeDeals(offers) : [];
  const dealsUnknown = deals.length === 0;

  const sourceUrl = hh.sourcePage || record.googleMapsUri || website;
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) return null;

  const dealTypes = inferDealTypes(deals, record);

  return {
    id: nextId,
    name,
    neighborhood: guessNeighborhood(lat, lng, address),
    address,
    lat,
    lng,
    days: hh.days.filter((day) => DAY_NAMES.includes(day)),
    startTime: hh.startTime,
    endTime: hh.endTime,
    deals,
    dealsUnknown,
    // Absent whenever neither the name nor Google's primary type says what
    // kind of place this is. The key is omitted rather than set to a filler
    // value — see lib/venue-kind.mjs.
    ...venueKindPatch(record, name),
    website,
    phone: record.nationalPhoneNumber || record.phone || undefined,
    verified: false,
    lastVerifiedAt: null,
    sourceUrl,
    dealTypes,
    ...atmosphereAmenities(record),
    seoHidden: hh.confidence !== 'high',
    // A thin answer from Google is a window we cannot yet source, which is a
    // statement about the venue rather than about search, so it holds the
    // listing off browse under its own reason. A later scrape that confirms
    // the window lifts both (lib/apply-scrape.mjs).
    ...(hh.confidence !== 'high' ? { browseHold: unverifiedWindowHold() } : {}),
    // Every catalog venue carries this explicitly; leaving it undefined on
    // imports makes visibility depend on how each consumer reads a missing key.
    listingStatus: 'published',
    _import: {
      googlePlaceId: record.googlePlaceId || record.id?.replace(/^places\//, ''),
      slug: slugify(name),
      rating: record.rating ?? null,
      reviewCount: record.userRatingCount ?? null,
      happyHourSource: hh.source,
      happyHourConfidence: hh.confidence,
      importedAt: new Date().toISOString(),
    },
  };
}

/**
 * A venue we can't substantiate a happy hour for, carried so its owner can
 * find and claim it from the restaurant dashboard.
 *
 * Deliberately has no days/startTime/endTime: the venue page reads a window as
 * a real happy hour, so a placeholder would publish a time we made up. Stays
 * off browse surfaces and out of the sitemap via listingStatus.
 */
export function normalizeStubVenue(record, nextId) {
  const lat = record.location?.latitude ?? record.lat;
  const lng = record.location?.longitude ?? record.lng;
  if (!inCounty(lat, lng)) return null;

  const name = (record.displayName?.text || record.displayName || record.name || '').trim();
  if (!name) return null;
  const address = record.formattedAddress || record.address;
  if (!address) return null;

  const website = isUsableVenueWebsite(record.websiteUri || record.website)
    ? (record.websiteUri || record.website)
    : '';
  const sourceUrl = record.googleMapsUri || website;
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) return null;

  return {
    id: nextId,
    name,
    neighborhood: guessNeighborhood(lat, lng, address),
    address,
    lat,
    lng,
    deals: [],
    ...venueKindPatch(record, name),
    website,
    phone: record.nationalPhoneNumber || record.phone || undefined,
    verified: false,
    lastVerifiedAt: null,
    sourceUrl,
    dealTypes: [],
    ...atmosphereAmenities(record),
    seoHidden: true,
    listingStatus: 'unlisted',
    hasHappyHourData: false,
    _import: {
      googlePlaceId: record.googlePlaceId || record.id?.replace(/^places\//, ''),
      slug: slugify(name),
      rating: record.rating ?? null,
      reviewCount: record.userRatingCount ?? null,
      importedAt: new Date().toISOString(),
      stub: true,
    },
  };
}

export function stripImportMeta(venue) {
  const { _import, ...rest } = venue;
  return rest;
}
