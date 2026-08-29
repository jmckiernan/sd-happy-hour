/**
 * Google's websiteUri is often a squatted .com that has nothing to do with
 * the restaurant. We never invent {venuename}.com ourselves — but we also
 * must not trust Google's URL until the page mentions this listing.
 */

const NAME_STOP = new Set([
  'the', 'and', 'of', 'at', 'a', 'an', 'bar', 'grill', 'restaurant', 'cafe',
  'caffe', 'company', 'co', 'inc', 'llc', 'kitchen', 'house', 'pub', 'tavern',
  'lounge', 'spot', 'wine', 'brewery', 'brewing', 'cocktail', 'nightlife',
]);

export function isGoogleMapsUrl(url) {
  return /google\.[^/]+\/maps|maps\.google\.|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(String(url || ''));
}

export function isUsableVenueWebsite(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  return !isGoogleMapsUrl(url);
}

const PLATFORM_HOST_RE = /(?:^|\.)(?:square\.site|toasttab\.com|popmenu\.com|popmenucloud\.com|clover\.com|spoton\.com|getbento\.com)$/i;

function hostContainsVenueName(host, venue) {
  const names = significantNameTokens(venue?.name).filter((token) => token.length >= 4);
  const compactHost = compact(host);
  return names.some((token) => host.includes(token) || compactHost.includes(compact(token)));
}

export function hostnameCorroboratesVenue(url, venue) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostContainsVenueName(host, venue)) return false;
  return PLATFORM_HOST_RE.test(host);
}

/**
 * Google listed this host and the hostname contains the restaurant's name.
 * Empty JS shells still count as the official site; a squatted casino at a
 * different host still fails.
 */
export function listedHostMatchesVenueName(url, venue) {
  if (!url || !venue?.website) return false;
  let host = '';
  let listed = '';
  try {
    host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    listed = new URL(venue.website).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return false;
  }
  if (host !== listed) return false;
  return hostContainsVenueName(host, venue);
}

/** Path/query mentions this listing's city, neighborhood, or ZIP. */
export function urlMatchesVenueLocation(url, venue = {}) {
  let blob = '';
  try {
    const parsed = new URL(url);
    blob = `${parsed.pathname} ${parsed.search}`.toLowerCase();
  } catch {
    return false;
  }
  const hay = compact(blob);
  const { zip, city, neighborhood } = locationSignals(venue);
  if (zip && hay.includes(zip)) return true;
  if (city.length >= 4 && hay.includes(compact(city))) return true;
  if (neighborhood.length >= 4 && hay.includes(compact(neighborhood))) return true;
  return false;
}

/**
 * Official chain/location URL: hostname looks like the brand, and the path
 * is this city's page. Unlike hostnameCorroboratesVenue, this is not limited
 * to Square/Toast — texasdebrazil.com/locations/carlsbad/ is the listing.
 * A squatted {name}.com home page still fails because it has no location path.
 */
export function listingUrlCorroboratesVenue(url, venue) {
  if (!url || !venue) return false;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostContainsVenueName(host, venue)) return false;
  if (PLATFORM_HOST_RE.test(host)) return true;
  return urlMatchesVenueLocation(url, venue);
}

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function significantNameTokens(name) {
  const words = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !NAME_STOP.has(word));
  if (words.length) return words;
  const collapsed = compact(name);
  return collapsed.length >= 4 ? [collapsed] : [];
}

function locationSignals(venue = {}) {
  const address = String(venue.address || '');
  const zip = address.match(/\b9\d{4}\b/)?.[0] || '';
  const city = address.split(',')[1]?.trim() || '';
  const street = address.match(/^(\d+\s+[^,]+)/)?.[1] || '';
  const phone = String(venue.phone || '').replace(/\D/g, '');
  const neighborhood = String(venue.neighborhood || '');
  return { zip, city, street, phone, neighborhood };
}

export function pageMatchesVenueListing(text, venue = {}) {
  const hay = compact(text);
  if (hay.length < 40) return false;

  const names = significantNameTokens(venue.name);
  const nameHit = names.some((token) => hay.includes(compact(token)))
    || hay.includes(compact(venue.name));
  if (!nameHit) return false;

  const { zip, city, street, phone, neighborhood } = locationSignals(venue);
  const cityHit = city.length >= 4 && hay.includes(compact(city));
  const zipHit = Boolean(zip) && hay.includes(zip);
  const streetHit = street.length >= 6 && hay.includes(compact(street));
  const neighborhoodHit = neighborhood.length >= 4 && hay.includes(compact(neighborhood));
  const phoneHit = phone.length >= 10 && hay.includes(phone.slice(-10));
  const sanDiegoHit = hay.includes('sandiego') && /san diego|chula vista|la jolla|oceanside|carlsbad|encinitas/i.test(String(venue.address || venue.neighborhood || ''));

  return zipHit || cityHit || streetHit || neighborhoodHit || phoneHit || sanDiegoHit;
}
