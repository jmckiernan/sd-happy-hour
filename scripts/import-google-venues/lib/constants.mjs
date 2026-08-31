import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.join(__dirname, '..', '..', '..');
export const DATA_DIR = path.join(ROOT_DIR, '.data', 'import', 'google');
export const STAGING_PATH = path.join(ROOT_DIR, '.data', 'import', 'staging.json');
export const HAPPY_HOURS_PATH = path.join(ROOT_DIR, 'public', 'data', 'happy-hours.json');

export const CANDIDATES_PATH = path.join(DATA_DIR, 'candidates.json');
export const ENRICHED_PATH = path.join(DATA_DIR, 'enriched.json');
export const WITH_HH_PATH = path.join(DATA_DIR, 'with-happy-hour.json');

/** San Diego County-ish bounds (matches src/lib/marketAreas.ts). */
export const COUNTY_BOUNDS = {
  minLat: 32.50,
  maxLat: 33.55,
  minLng: -117.65,
  maxLng: -116.60,
};

// The block of venue ids this city is allowed to mint. Venue id is the join key
// in a dozen tables — venue_claims, venue_publications, venue_overrides,
// venue_photos, promotions, live_overrides, saved_spots, venue_follows,
// happy_hour_menus, venue_managers — and it decides the URL slug. Every city's
// pipeline allocates from max(id) + 1 over its own catalog, so without reserved
// bands a second city starts at 1 and mints ids San Diego already owns. The
// collision is silent until the two catalogs meet, and repairing it then means
// renumbering venues and rewriting every one of those foreign keys, where a
// single miss hands an ownership claim or a saved spot to the wrong venue.
// San Diego keeps the band its existing ids already sit in; a second city takes
// the next one (VENUE_ID_BAND = { start: 100_000, end: 199_999 }) and the two
// never meet. See docs/data-architecture.md §6.1 and docs/porting-to-a-new-city.md §3.2.
export const VENUE_ID_BAND = { start: 1, end: 99_999 };

export const SEARCH_TYPES = ['restaurant', 'bar', 'cafe', 'night_club', 'brewery'];

export const MIN_RATING = Number(process.env.IMPORT_MIN_RATING || 4.0);
export const MIN_REVIEWS = Number(process.env.IMPORT_MIN_REVIEWS || 10);
export const MAX_IMPORT = Number(process.env.IMPORT_MAX || 1000);

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_ABBR = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export const DEAL_TYPES = ['beer', 'cocktails', 'wine', 'food', 'oysters', 'entertainment'];

export { NEIGHBORHOOD_BOXES } from './neighborhood-assign.mjs';
