/**
 * Store-locator widgets as a happy-hour source.
 *
 * Multi-location brands often publish the offer nowhere but the locator: Board
 * & Brew's "$2 off all pints, everyday 3-6PM" exists only inside a Storepoint
 * widget, and `/locations` HTML contains the string "happy hour" zero times
 * because the widget renders client-side. Same lesson as the Popmenu menus —
 * the JSON behind the page is the source of truth, not the DOM.
 *
 * Two ways in, in order:
 *   1. A platform adapter. We recognize the widget's script tag, read the
 *      account id out of it, and call the public JSON API over plain HTTP. No
 *      browser, no render wait.
 *   2. `collectLocationRecordsFromJson`, which mines *any* recorded JSON
 *      response for location-shaped objects carrying offer text. This is what
 *      covers the platforms nobody added an adapter for, so it — not the
 *      adapter list — is the real backstop.
 *
 * Offers are per location, never brand-wide: in the same Board & Brew payload
 * Mission Valley says "all beers" where Scripps Ranch says "all pints", and
 * Del Mar publishes nothing at all. Everything here matches one record to one
 * venue before a single line is applied.
 */

/**
 * Tried only when discovery finds nothing better, and scored below specials and
 * menus. Guessing paths ahead of discovered links has already cost this crawler
 * its budget on 404s once.
 */
export const LOCATOR_CANDIDATE_PATHS = [
  { path: '/locations', score: 10 },
  { path: '/store-locator', score: 10 },
  { path: '/find-us', score: 9 },
  { path: '/our-locations', score: 9 },
];

/** Does a string look like it names a recurring drink/food offer? */
const OFFER_TEXT = /happy\s*hour|\$\s*\d|\d+\s*%\s*off|half[- ]off|1\/2\s*off|\bbogo\b|drink\s*special|daily\s*special|well\s*drinks|draft\s*special/i;

/** Keys whose string values might carry the offer on a location record. */
const OFFER_FIELDS = /^(description|desc|details|notes?|extra\d*|custom_?field|special|specials|promo|promotion|offer|tagline|subtitle|message|content|blurb|about|info)$/i;

/** Keys that look like a street address on a location record. */
const ADDRESS_FIELDS = /^(streetaddress|street_address|address|address_?line_?1|addr1|address1|full_?address|location_?address)$/i;

const NAME_FIELDS = /^(name|title|location_?name|store_?name|label)$/i;

const MAX_RECORDS = 400;
const MAX_DEPTH = 8;

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value) {
  const num = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(num) ? num : null;
}

/**
 * Storepoint and friends stash extra widget fields as a JSON *string*. Parse it
 * so its values are searchable like any other field.
 */
function expandEmbeddedJson(value) {
  const text = asString(value);
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function offerTextFromNode(node) {
  const found = [];
  for (const [key, value] of Object.entries(node)) {
    const text = asString(value);
    if (!text) {
      const embedded = expandEmbeddedJson(value);
      if (embedded && typeof embedded === 'object') {
        for (const inner of Object.values(embedded)) {
          const innerText = asString(inner);
          if (innerText && OFFER_TEXT.test(innerText)) found.push(innerText);
        }
      }
      continue;
    }
    if (!OFFER_FIELDS.test(key) && !OFFER_TEXT.test(text)) continue;
    if (OFFER_TEXT.test(text)) found.push(text);
  }
  return found.join('\n').trim();
}

function addressFromNode(node) {
  for (const [key, value] of Object.entries(node)) {
    if (!ADDRESS_FIELDS.test(key)) continue;
    const text = asString(value);
    if (text) return text;
  }
  // Stockist splits the address across fields.
  const line = asString(node.address_line_1 || node.addressLine1);
  const city = asString(node.city);
  const state = asString(node.state);
  const zip = asString(node.postal_code || node.postalCode || node.zip);
  const joined = [line, city, state, zip].filter(Boolean).join(' ');
  return joined || '';
}

function nameFromNode(node) {
  for (const [key, value] of Object.entries(node)) {
    if (!NAME_FIELDS.test(key)) continue;
    const text = asString(value);
    if (text) return text;
  }
  return '';
}

function coordsFromNode(node) {
  const lat = asNumber(
    node.loc_lat ?? node.latitude ?? node.lat ?? node.Latitude ?? node.y
  );
  const lng = asNumber(
    node.loc_long ?? node.longitude ?? node.lng ?? node.lon ?? node.Longitude ?? node.x
  );
  if (lat === null || lng === null) return { lat: null, lng: null };
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { lat: null, lng: null };
  return { lat, lng };
}

/**
 * Mine parsed JSON for location records that carry offer text.
 *
 * Deliberately looser than `collectMenuGroupsFromJson`, which requires a name
 * *and* a price and so walks straight past a locator entry whose entire offer
 * is a free-text `description` with no price field. Here a record needs an
 * identity (address or coordinates) plus text that reads like an offer.
 *
 * @param {unknown} root parsed JSON from a page response or locator API
 * @returns {{ name: string, address: string, lat: number|null, lng: number|null, offerText: string }[]}
 */
export function collectLocationRecordsFromJson(root) {
  const records = [];
  const seen = new Set();

  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;
    if (records.length >= MAX_RECORDS) return;

    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1);
      return;
    }

    const address = addressFromNode(node);
    const { lat, lng } = coordsFromNode(node);
    if (address || (lat !== null && lng !== null)) {
      const offerText = offerTextFromNode(node);
      if (offerText) {
        const key = `${address.toLowerCase()}|${lat ?? ''},${lng ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          records.push({ name: nameFromNode(node), address, lat, lng, offerText });
        }
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1);
    }
  };

  walk(root, 0);
  return records;
}

/**
 * Recognize a locator widget from page HTML and return the public JSON APIs to
 * call. Each entry is plain HTTP — the point is to skip the browser entirely.
 *
 * Storepoint is verified against a live payload. Stockist's endpoint shape is
 * from its own docs. StoreRocket's is the documented pattern but unverified, so
 * a miss there must stay non-fatal and fall through to generic JSON mining.
 *
 * @param {string} html
 * @param {{ lat?: number|null, lng?: number|null }} [venue] used by APIs that require a search origin
 */
export function detectLocatorApis(html, venue = {}) {
  const source = String(html || '');
  const apis = [];
  const add = (platform, url) => {
    if (url && !apis.some((row) => row.url === url)) apis.push({ platform, url });
  };

  // <script src="https://storepoint.co/api/v1/js/166117680d6ae4.js">
  const storepoint = source.match(/storepoint\.co\/api\/v1\/js\/([a-z0-9]+)\.js/i);
  if (storepoint) {
    add('storepoint', `https://api.storepoint.co/v1/${storepoint[1]}/locations`);
  }

  // <div data-stockist-widget-tag="u10642">
  const stockist = source.match(/data-stockist-widget-tag=["']([a-z0-9]+)["']/i);
  if (stockist) {
    const lat = Number.isFinite(venue.lat) ? venue.lat : 32.7157;
    const lng = Number.isFinite(venue.lng) ? venue.lng : -117.1611;
    add(
      'stockist',
      `https://stockist.co/api/v1/${stockist[1]}/locations/search?latitude=${lat}&longitude=${lng}&distance=80`
    );
  }

  // StoreRocket embeds the account id in its widget script or a data attribute.
  const storerocket =
    source.match(/storerocket[_-]?(?:account|id)["'\s:=]+([a-zA-Z0-9]+)/i) ||
    source.match(/storerocket\.io\/api\/user\/([a-zA-Z0-9]+)/i);
  if (storerocket) {
    add('storerocket', `https://api.storerocket.io/api/user/${storerocket[1]}/locations`);
  }

  return apis;
}

/** Pull the location array out of whichever envelope the platform uses. */
export function locationsFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const direct =
    payload.results?.locations ||
    payload.results?.stores ||
    payload.locations ||
    payload.stores ||
    payload.data?.locations ||
    payload.data;
  if (Array.isArray(direct)) return direct;
  return Array.isArray(payload) ? payload : [];
}

/**
 * Fetch one locator API and normalize it to location records.
 * Never throws: a locator is a bonus source, not a required one.
 */
export async function fetchLocatorRecords(api, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let payload;
    try {
      const response = await fetchImpl(api.url, { signal: controller.signal });
      if (!response?.ok) return [];
      payload = JSON.parse(await response.text());
    } finally {
      clearTimeout(timer);
    }

    const rows = locationsFromPayload(payload);
    const records = rows.length
      ? collectLocationRecordsFromJson(rows)
      : collectLocationRecordsFromJson(payload);
    return records.map((record) => ({ ...record, platform: api.platform, sourceUrl: api.url }));
  } catch {
    return [];
  }
}

function haversineMeters(aLat, aLng, bLat, bLng) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earth = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.sqrt(h));
}

function streetNumber(address) {
  const match = String(address || '').trim().match(/^(\d+)/);
  return match ? match[1] : '';
}

function normalizeStreet(address) {
  return String(address || '')
    .toLowerCase()
    .replace(/\b(suite|ste|unit|#)\s*[\w-]+/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Pick the locator record that belongs to this venue.
 *
 * Coordinates first (a locator's own lat/lng is the least ambiguous signal),
 * then street number plus street name. Brand match alone is never enough — that
 * is exactly how one location's offer gets copied onto sixteen storefronts.
 *
 * @returns {{ record: object, method: string, distanceMeters: number|null } | null}
 */
export function matchLocatorRecord(records, venue, { maxMeters = 400 } = {}) {
  if (!Array.isArray(records) || !records.length || !venue) return null;

  if (Number.isFinite(venue.lat) && Number.isFinite(venue.lng)) {
    let best = null;
    for (const record of records) {
      if (!Number.isFinite(record.lat) || !Number.isFinite(record.lng)) continue;
      const distance = haversineMeters(venue.lat, venue.lng, record.lat, record.lng);
      if (distance <= maxMeters && (!best || distance < best.distanceMeters)) {
        best = { record, method: 'coordinates', distanceMeters: Math.round(distance) };
      }
    }
    if (best) return best;
  }

  const venueNumber = streetNumber(venue.address);
  const venueStreet = normalizeStreet(venue.address);
  if (venueNumber && venueStreet) {
    for (const record of records) {
      if (streetNumber(record.address) !== venueNumber) continue;
      const street = normalizeStreet(record.address);
      if (!street) continue;
      const [shorter, longer] =
        street.length < venueStreet.length ? [street, venueStreet] : [venueStreet, street];
      if (longer.includes(shorter.split(' ').slice(0, 3).join(' '))) {
        return { record, method: 'street_address', distanceMeters: null };
      }
    }
  }

  return null;
}

/** Render a matched record as evidence text for the extract call. */
export function locatorTextFromRecord(match) {
  if (!match?.record) return '';
  const { record } = match;
  const lines = [
    `Location: ${record.name || record.address}`,
    record.address ? `Address: ${record.address}` : '',
    record.offerText,
  ].filter(Boolean);
  return lines.join('\n');
}
