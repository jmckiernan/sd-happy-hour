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

export const SEARCH_TYPES = ['restaurant', 'bar', 'cafe', 'night_club', 'brewery'];

export const MIN_RATING = Number(process.env.IMPORT_MIN_RATING || 4.0);
export const MIN_REVIEWS = Number(process.env.IMPORT_MIN_REVIEWS || 10);
export const MAX_IMPORT = Number(process.env.IMPORT_MAX || 1000);

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_ABBR = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export const DEAL_TYPES = ['beer', 'cocktails', 'wine', 'food', 'oysters', 'entertainment'];
export const FEATURES = ['patio', 'dog friendly', 'date night', 'group friendly', 'waterfront', 'rooftop', 'casual', 'upscale'];

export { NEIGHBORHOOD_BOXES } from './neighborhood-assign.mjs';
