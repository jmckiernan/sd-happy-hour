/**
 * Pick the right branch page on a multi-location site, and refuse the wrong one.
 *
 * Chains are where per-location accuracy breaks down. BJ's, Chili's and
 * Applebee's do not publish a locator API — they publish one page per
 * restaurant, all on the same domain, all saying "Happy Hour". Any of them
 * will satisfy a crawler looking for the phrase, so the risk is not missing a
 * deal but attaching a real deal to the wrong restaurant. That already
 * happened once: a Cinépolis in La Costa was given the Vista theater's hours.
 *
 * Two jobs here. Find this venue's own page among many, and reject a page that
 * demonstrably belongs to a different branch. The second matters more — a
 * missing happy hour is a gap, a wrong one is a lie on a venue page.
 */

import { NEIGHBORHOOD_BOXES } from './neighborhood-assign.mjs';

const PLACE_NAMES = (
  Array.isArray(NEIGHBORHOOD_BOXES) ? NEIGHBORHOOD_BOXES.map((box) => box.name) : Object.keys(NEIGHBORHOOD_BOXES)
).map((name) => name.toLowerCase());

/** Cities just outside the county that still show up on chain sites. */
const NEIGHBORING_PLACES = [
  'san clemente', 'dana point', 'laguna niguel', 'laguna beach', 'mission viejo',
  'irvine', 'temecula', 'murrieta', 'menifee', 'lake elsinore', 'corona del mar',
  'anaheim', 'costa mesa', 'santa ana', 'tustin', 'huntington beach', 'torrance',
];

const VOCABULARY = [...new Set([...PLACE_NAMES, ...NEIGHBORING_PLACES])]
  // Longest first so "la costa" wins over "costa" and "la jolla village" over
  // "la jolla" when both could match the same text.
  .sort((a, b) => b.length - a.length);

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

/** Place names mentioned in a string, matched on word boundaries. */
export function placesMentioned(text) {
  const hay = ` ${normalize(text)} `;
  const found = [];
  for (const place of VOCABULARY) {
    if (hay.includes(` ${place} `)) found.push(place);
  }
  return found;
}

export function zipsIn(text) {
  return String(text || '').match(/\b9[0-2]\d{3}\b/g) || [];
}

/** Leading street number, the strongest per-branch signal a URL can carry. */
export function streetNumberOf(address) {
  const match = String(address || '').match(/^\s*(\d{2,6})\s/);
  return match ? match[1] : null;
}

/**
 * The city segment of a US postal address: the part before the state.
 *
 * The vocabulary cannot be complete — Cardiff is a real place that is not in
 * it, and without this a Coronado URL looked harmless for a Cardiff venue.
 */
export function cityFromAddress(address) {
  const parts = String(address || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (/^[A-Z]{2}\b|^(california|ca)\b/i.test(parts[i])) {
      return i > 0 ? parts[i - 1].toLowerCase() : null;
    }
  }
  // No state token, so fall back to the second field: "910 Grand Ave, San Diego".
  return parts.length >= 2 ? parts[1].toLowerCase() : null;
}

function venueSignals(venue = {}) {
  const address = venue.address || venue.formattedAddress || '';
  const city = cityFromAddress(address);
  const places = placesMentioned(`${address} ${venue.neighborhood || ''}`);
  if (city && !places.includes(city)) places.push(city);
  return {
    zips: zipsIn(address),
    places,
    streetNumber: streetNumberOf(address),
  };
}

/**
 * Does this URL belong to a different branch than the venue?
 *
 * Only says yes on positive evidence of a *different* place. A URL that names
 * nowhere is not a conflict, because most brand pages name nowhere and we
 * would reject the entire web.
 */
export function conflictsWithVenue(url, venue = {}) {
  if (!url) return false;
  let path = '';
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname} ${parsed.search}`;
  } catch {
    path = String(url);
  }

  const signals = venueSignals(venue);

  const urlZips = zipsIn(path);
  if (urlZips.length && signals.zips.length && !urlZips.some((zip) => signals.zips.includes(zip))) {
    return true;
  }

  const urlPlaces = placesMentioned(path);
  if (!urlPlaces.length || !signals.places.length) return false;
  // "la costa" vs "la costa town square" should agree, so allow containment.
  return !urlPlaces.some((place) =>
    signals.places.some((mine) => mine.includes(place) || place.includes(mine))
  );
}

/**
 * Score how strongly a URL claims to be this venue's page.
 * Higher is better; 0 means nothing tied it to this branch.
 */
export function scoreLocationUrl(url, venue = {}) {
  if (!url || conflictsWithVenue(url, venue)) return 0;
  let path = '';
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname} ${parsed.search}`;
  } catch {
    path = String(url);
  }
  const signals = venueSignals(venue);
  const compact = normalize(path).replace(/\s+/g, '');
  let score = 0;

  if (signals.zips.some((zip) => path.includes(zip))) score += 10;
  if (signals.streetNumber && compact.includes(signals.streetNumber)) score += 6;
  for (const place of signals.places) {
    if (compact.includes(place.replace(/\s+/g, ''))) score += 4;
  }
  if (/\/(?:locations?|restaurants?|stores?|find-?us)\//i.test(path)) score += 1;

  return score;
}

/** The best per-branch page among candidates, or null if none identifies one. */
export function pickLocationPage(urls, venue = {}) {
  let best = null;
  for (const url of urls || []) {
    const score = scoreLocationUrl(url, venue);
    if (score > 0 && (!best || score > best.score)) best = { url, score };
  }
  return best;
}
