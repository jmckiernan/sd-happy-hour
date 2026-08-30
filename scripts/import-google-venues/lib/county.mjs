/**
 * Is this place actually in San Diego County?
 *
 * `COUNTY_BOUNDS` is a rectangle, and the county is not. Its northwest corner
 * reaches San Clemente in Orange County and its northern edge reaches Temecula
 * in Riverside County, which is how 54 out-of-county venues (23 San Clemente,
 * 31 Temecula) ended up published on a San Diego site.
 *
 * A tighter rectangle cannot fix this. Temecula sits at 33.494°N in Riverside
 * County while Fallbrook at 33.376°N is San Diego County, so no single `maxLat`
 * separates them — the real border is a jagged line, not a latitude.
 *
 * So we do not guess: Google returns the county in `addressComponents`
 * (`administrative_area_level_2`) on every Places detail call, and we already
 * request that field. The bounds stay as a cheap prefilter for the search grid;
 * this is the authority.
 */

const COUNTY_TYPE = 'administrative_area_level_2';

/**
 * The US–Mexico land border, as a straight line.
 *
 * `COUNTY_BOUNDS` starts at 32.50°N, which reaches into Tijuana — 517 of our
 * candidates are Mexican restaurants in the literal sense, and we had already
 * bought Place Details for 459 of them. The county check catches these later,
 * but only after we have paid; discovery needs to not go there at all, which
 * matters much more now that adaptive search subdivides dense areas and
 * central Tijuana is very dense.
 *
 * The boundary runs from the Pacific at 32.5343°N, 117.1244°W to the Colorado
 * River at 32.7187°N, 114.7196°W, so its latitude climbs as you head east.
 */
const BORDER_WEST = { lat: 32.5343, lng: -117.1244 };
const BORDER_EAST = { lat: 32.7187, lng: -114.7196 };

export function borderLatAt(lng) {
  const slope = (BORDER_EAST.lat - BORDER_WEST.lat) / (BORDER_EAST.lng - BORDER_WEST.lng);
  return BORDER_WEST.lat + slope * (lng - BORDER_WEST.lng);
}

/** False for anything in Mexico, so discovery can skip it before spending. */
export function isNorthOfBorder(lat, lng) {
  return lat >= borderLatAt(lng);
}

export const SAN_DIEGO_COUNTY = 'San Diego County';

/**
 * Cities inside the bounds rectangle but outside the county, for the ~14% of
 * cached places Google returned with no county component. Names, not lat/lng,
 * because that is what a `formattedAddress` gives us.
 */
const OUT_OF_COUNTY_CITIES =
  /\b(san clemente|dana point|laguna (?:beach|niguel|hills|woods)|capistrano beach|san juan capistrano|ladera ranch|rancho santa margarita|mission viejo|aliso viejo|irvine|temecula|murrieta|wildomar|lake elsinore|menifee|hemet|anza|idyllwild|palm springs|corona)\b/i;

/** `San Diego County`, `Orange County`, … or null when Google omitted it. */
export function countyFromAddressComponents(place) {
  const components = place?.addressComponents;
  if (!Array.isArray(components)) return null;
  for (const component of components) {
    const types = component?.types || [];
    if (!types.includes(COUNTY_TYPE)) continue;
    const name = component.longText || component.long_name || component.shortText || '';
    if (name) return name;
  }
  return null;
}

/** Fallback for records with no county component: read the city off the address. */
export function looksOutOfCountyByAddress(address) {
  return OUT_OF_COUNTY_CITIES.test(String(address || ''));
}

/**
 * Decide whether a place belongs in the catalog.
 *
 * Missing county data is not disqualifying on its own — 679 cached places have
 * no county component, and almost all of them are genuinely in San Diego. Those
 * fall back to the city check, and if that is clean too they are kept.
 *
 * @returns {{ inCounty: boolean, county: string|null, basis: 'google'|'address'|'unknown' }}
 */
export function classifyCounty(place, address = '') {
  const county = countyFromAddressComponents(place);
  if (county) {
    return { inCounty: county === SAN_DIEGO_COUNTY, county, basis: 'google' };
  }
  const formatted = address || place?.formattedAddress || place?.address || '';
  if (looksOutOfCountyByAddress(formatted)) {
    return { inCounty: false, county: null, basis: 'address' };
  }
  return { inCounty: true, county: null, basis: 'unknown' };
}

export function isSanDiegoCounty(place, address = '') {
  return classifyCounty(place, address).inCounty;
}
