/** Lat/lng boxes and address rules for venue neighborhood assignment. */

export const NEIGHBORHOOD_BOXES = [
  // San Diego urban — most specific first
  { name: 'Little Italy', minLat: 32.715, maxLat: 32.728, minLng: -117.176, maxLng: -117.164 },
  { name: 'Embarcadero', minLat: 32.708, maxLat: 32.716, minLng: -117.182, maxLng: -117.168 },
  { name: 'Gaslamp', minLat: 32.706, maxLat: 32.7185, minLng: -117.180, maxLng: -117.154 },
  { name: 'East Village', minLat: 32.706, maxLat: 32.7185, minLng: -117.162, maxLng: -117.146 },
  { name: 'Balboa Park', minLat: 32.724, maxLat: 32.738, minLng: -117.158, maxLng: -117.142 },
  // Ash Street up to Elm, east of Fifth: too far north for Gaslamp or East
  // Village, too far south for Balboa Park, and previously nameless. minLat sits
  // on Gaslamp's maxLat so B Street towers land in Gaslamp and Cortez keeps Ash.
  { name: 'Cortez Hill', minLat: 32.7185, maxLat: 32.7245, minLng: -117.163, maxLng: -117.152 },
  // Bankers Hill fills the gap between Little Italy, downtown and the park's west
  // edge. Without a box its venues fell through to a bare "San Diego", which has
  // no neighborhood page, so they appeared nowhere. Kept to the uncontested core
  // — First Avenue to Sixth, Elm Street up to just short of Upas — so downtown
  // and Hillcrest keep the blocks that are really theirs.
  { name: 'Bankers Hill', minLat: 32.7225, maxLat: 32.740, minLng: -117.166, maxLng: -117.158 },
  // Harbor Island plus the airport terminals on North Harbor Drive. Without the
  // western stretch, Stone Brewing and the United Club fell to a bare "San Diego".
  { name: 'Harbor Island', minLat: 32.718, maxLat: 32.735, minLng: -117.210, maxLng: -117.188 },
  { name: 'Middletown', minLat: 32.728, maxLat: 32.738, minLng: -117.178, maxLng: -117.168 },
  { name: 'Hillcrest', minLat: 32.744, maxLat: 32.758, minLng: -117.172, maxLng: -117.154 },
  { name: 'North Park', minLat: 32.728, maxLat: 32.752, minLng: -117.138, maxLng: -117.118 },
  { name: 'Normal Heights', minLat: 32.752, maxLat: 32.764, minLng: -117.138, maxLng: -117.108 },
  { name: 'South Park', minLat: 32.716, maxLat: 32.728, minLng: -117.130, maxLng: -117.118 },
  { name: 'Ocean Beach', minLat: 32.738, maxLat: 32.755, minLng: -117.262, maxLng: -117.238 },
  { name: 'Mission Beach', minLat: 32.764, maxLat: 32.782, minLng: -117.262, maxLng: -117.238 },
  { name: 'Pacific Beach', minLat: 32.790, maxLat: 32.812, minLng: -117.260, maxLng: -117.230 },
  { name: 'Point Loma', minLat: 32.698, maxLat: 32.738, minLng: -117.260, maxLng: -117.210 },
  { name: 'Old Town', minLat: 32.744, maxLat: 32.762, minLng: -117.218, maxLng: -117.188 },
  { name: 'Mission Valley', minLat: 32.758, maxLat: 32.782, minLng: -117.182, maxLng: -117.138 },
  { name: 'Kearny Mesa', minLat: 32.812, maxLat: 32.848, minLng: -117.182, maxLng: -117.138 },
  { name: 'Clairemont', minLat: 32.812, maxLat: 32.848, minLng: -117.222, maxLng: -117.182 },
  { name: 'La Jolla', minLat: 32.832, maxLat: 32.872, minLng: -117.290, maxLng: -117.230 },
  { name: 'UTC', minLat: 32.858, maxLat: 32.892, minLng: -117.230, maxLng: -117.200 },
  { name: 'Carmel Valley', minLat: 32.910, maxLat: 32.960, minLng: -117.260, maxLng: -117.200 },
  { name: 'Mira Mesa', minLat: 32.884, maxLat: 32.920, minLng: -117.170, maxLng: -117.120 },
  { name: 'Sorrento Valley', minLat: 32.880, maxLat: 32.910, minLng: -117.240, maxLng: -117.200 },
  { name: 'Rancho Bernardo', minLat: 32.940, maxLat: 32.980, minLng: -117.130, maxLng: -117.060 },
  { name: 'Rancho Peñasquitos', minLat: 32.940, maxLat: 32.980, minLng: -117.180, maxLng: -117.120 },

  // Coastal north county
  { name: 'Del Mar', minLat: 32.940, maxLat: 32.980, minLng: -117.280, maxLng: -117.240 },
  { name: 'Solana Beach', minLat: 32.980, maxLat: 33.000, minLng: -117.290, maxLng: -117.250 },
  // Cardiff-by-the-Sea (92007) sat inside the old Solana Beach box, so its
  // venues were labelled Solana Beach or Encinitas even though their addresses
  // plainly say Cardiff. Boxes are checked before addresses, so the /cardiff/
  // rule further down could never fire for a venue that had coordinates.
  { name: 'Cardiff', minLat: 33.000, maxLat: 33.030, minLng: -117.295, maxLng: -117.270 },
  { name: 'Encinitas', minLat: 33.020, maxLat: 33.080, minLng: -117.320, maxLng: -117.260 },
  { name: 'Carlsbad', minLat: 33.080, maxLat: 33.180, minLng: -117.360, maxLng: -117.260 },
  { name: 'Oceanside', minLat: 33.180, maxLat: 33.260, minLng: -117.420, maxLng: -117.280 },

  // South bay
  { name: 'Coronado', minLat: 32.670, maxLat: 32.710, minLng: -117.180, maxLng: -117.130 },
  { name: 'Imperial Beach', minLat: 32.570, maxLat: 32.600, minLng: -117.150, maxLng: -117.110 },
  // San Ysidro before Otay Mesa: the border crossing sits inside the wider Otay
  // rectangle, and boxes are first-match. Dairy Mart Road runs just west of
  // -117.060, so the western edge has to clear it.
  { name: 'San Ysidro', minLat: 32.540, maxLat: 32.570, minLng: -117.075, maxLng: -117.015 },
  // Otay Mesa / Nestor / Palm City (92154). Without this box the ZIP fell through
  // to a bare "San Diego" and 28 claim stubs had no neighborhood page to land on.
  { name: 'Otay Mesa', minLat: 32.540, maxLat: 32.595, minLng: -117.100, maxLng: -116.920 },
  { name: 'Chula Vista', minLat: 32.600, maxLat: 32.680, minLng: -117.120, maxLng: -116.960 },
  { name: 'National City', minLat: 32.640, maxLat: 32.680, minLng: -117.120, maxLng: -117.080 },

  // East county / inland
  { name: 'La Mesa', minLat: 32.750, maxLat: 32.790, minLng: -117.060, maxLng: -117.000 },
  { name: 'El Cajon', minLat: 32.780, maxLat: 32.830, minLng: -117.060, maxLng: -116.960 },
  { name: 'Santee', minLat: 32.820, maxLat: 32.870, minLng: -117.020, maxLng: -116.960 },
  { name: 'Escondido', minLat: 33.100, maxLat: 33.160, minLng: -117.140, maxLng: -117.060 },
  { name: 'San Marcos', minLat: 33.100, maxLat: 33.160, minLng: -117.220, maxLng: -117.140 },
  { name: 'Vista', minLat: 33.160, maxLat: 33.220, minLng: -117.280, maxLng: -117.200 },
  { name: 'Poway', minLat: 32.920, maxLat: 32.980, minLng: -117.080, maxLng: -117.020 },
  { name: 'Temecula', minLat: 33.460, maxLat: 33.540, minLng: -117.180, maxLng: -117.080 },
];

/** Zip codes within San Diego city when lat/lng boxes do not match. */
const SAN_DIEGO_ZIP_NEIGHBORHOOD = {
  92102: 'East Village',
  92103: 'Hillcrest',
  92104: 'North Park',
  92105: 'City Heights',
  92106: 'Point Loma',
  92107: 'Ocean Beach',
  92108: 'Mission Valley',
  92109: 'Pacific Beach',
  92110: 'Old Town',
  92111: 'Kearny Mesa',
  92113: 'Logan Heights',
  92114: 'Encanto',
  92115: 'College Area',
  92116: 'Normal Heights',
  92117: 'Clairemont',
  92119: 'San Carlos',
  92120: 'San Carlos',
  92121: 'Sorrento Valley',
  92122: 'UTC',
  92123: 'Kearny Mesa',
  92124: 'Tierrasanta',
  92126: 'Mira Mesa',
  92127: 'Rancho Bernardo',
  92128: 'Rancho Bernardo',
  92129: 'Rancho Peñasquitos',
  92130: 'Carmel Valley',
  92131: 'Scripps Ranch',
  92134: 'Balboa Park',
  92139: 'Paradise Hills',
  92154: 'Otay Mesa',
  92173: 'San Ysidro',
};

// County ZIPs outside the City of San Diego that still need a page. Consulted
// only after city parsing and the San Diego ZIP table have both failed.
const COUNTY_ZIP_NEIGHBORHOOD = {
  91917: 'Jamul',
  92082: 'Valley Center',
  92059: 'Valley Center',
  92061: 'Valley Center',
  92036: 'Ramona',
  92086: 'Ramona',
  91916: 'Alpine',
  92060: 'Ramona',
  92055: 'Oceanside',
};

// Cities and place names that Google returns as the municipality but that have
// no neighborhood page of their own — backcountry hamlets, reservation towns,
// and bases. Mapped to the nearest page that a visitor browsing the county
// would actually reach. Do not invent a page for these unless published venues
// start needing one; the reasons live in docs/homepage-reachability.md §6.
const CITY_TO_PAGE = {
  Julian: 'Ramona',
  'Pauma Valley': 'Valley Center',
  Pala: 'Valley Center',
  'Warner Springs': 'Ramona',
  Descanso: 'Alpine',
  'Palomar Mountain': 'Ramona',
  'Camp Pendleton North': 'Oceanside',
  'Camp Pendleton South': 'Oceanside',
  'Camp Pendleton': 'Oceanside',
};

// Last-resort patterns for addresses with no parseable city or zip. They match
// street names as readily as places, so they are only consulted once the city
// and zip have both failed to identify the venue.
const ADDRESS_NEIGHBORHOOD_RE = [
  [/gaslamp/i, 'Gaslamp'],
  [/little italy/i, 'Little Italy'],
  [/north park/i, 'North Park'],
  [/south park/i, 'South Park'],
  [/pacific beach|\bpb\b/i, 'Pacific Beach'],
  [/ocean beach|\bob\b/i, 'Ocean Beach'],
  [/mission beach/i, 'Mission Beach'],
  [/point loma|liberty station/i, 'Point Loma'],
  [/old town|mission hills/i, 'Old Town'],
  [/hillcrest/i, 'Hillcrest'],
  [/la jolla/i, 'La Jolla'],
  [/del mar/i, 'Del Mar'],
  [/carlsbad/i, 'Carlsbad'],
  [/encinitas/i, 'Encinitas'],
  [/solana beach/i, 'Solana Beach'],
  [/coronado/i, 'Coronado'],
  [/imperial beach/i, 'Imperial Beach'],
  [/mission valley/i, 'Mission Valley'],
  [/kearny mesa|convoy/i, 'Kearny Mesa'],
  [/clairemont/i, 'Clairemont'],
  [/mira mesa/i, 'Mira Mesa'],
  [/carmel valley/i, 'Carmel Valley'],
  [/university city|utc/i, 'UTC'],
  [/oceanside/i, 'Oceanside'],
  [/escondido/i, 'Escondido'],
  [/san marcos/i, 'San Marcos'],
  [/chula vista/i, 'Chula Vista'],
  [/national city/i, 'National City'],
  [/la mesa/i, 'La Mesa'],
  [/el cajon/i, 'El Cajon'],
  [/temecula/i, 'Temecula'],
  [/vista/i, 'Vista'],
  [/poway/i, 'Poway'],
  [/cardiff/i, 'Cardiff'],
  [/santee/i, 'Santee'],
  [/fallbrook/i, 'Fallbrook'],
  [/san clemente/i, 'San Clemente'],
  [/otay mesa/i, 'Otay Mesa'],
  [/san ysidro/i, 'San Ysidro'],
  [/encanto/i, 'Encanto'],
  [/paradise hills/i, 'Paradise Hills'],
  [/valley center/i, 'Valley Center'],
  [/julian/i, 'Julian'],
];

function cityFromAddress(address = '') {
  // "123 Main St, Carlsbad, CA 92008" or bare "Valley Center, CA 92082".
  const match = address.match(/(?:^|,\s*)([^,]+),\s*CA\s+\d{5}/i);
  return match ? match[1].trim() : null;
}

function zipFromAddress(address = '') {
  const match = address.match(/\bCA\s+(\d{5})\b/i) || address.match(/\b(9\d{4})\b/);
  return match ? match[1] : null;
}

function inBox(lat, lng, box) {
  return lat >= box.minLat && lat <= box.maxLat && lng >= box.minLng && lng <= box.maxLng;
}

function neighborhoodFromAddress(address = '') {
  for (const [pattern, name] of ADDRESS_NEIGHBORHOOD_RE) {
    if (pattern.test(address)) return name;
  }
  return null;
}

function pageForCity(city) {
  if (!city) return null;
  if (CITY_TO_PAGE[city]) return CITY_TO_PAGE[city];
  return city;
}

export function assignNeighborhood(lat, lng, address = '') {
  if (/mexico|tijuana|tecate|b\.c\./i.test(address)) return 'Tijuana';

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    for (const box of NEIGHBORHOOD_BOXES) {
      if (inBox(lat, lng, box)) return box.name;
    }
  }

  const city = cityFromAddress(address);
  const zip = zipFromAddress(address);

  // A separate municipality outranks whatever a street name hints at: a venue on
  // Avenida Del Mar in San Clemente is in San Clemente, not Del Mar. Backcountry
  // place names without a page of their own remap to the nearest real page.
  if (city && city !== 'San Diego') return pageForCity(city);

  // Within the city of San Diego the zip is the only reliable signal left. Street
  // names borrow other places' names freely — Scripps Poway Parkway is in Scripps
  // Ranch, El Cajon Boulevard runs through North Park — so an unrecognised zip
  // stays vaguely "San Diego" instead of guessing from the street.
  if (city === 'San Diego') return SAN_DIEGO_ZIP_NEIGHBORHOOD[zip] || 'San Diego';

  const fromAddress = neighborhoodFromAddress(address);
  if (fromAddress) return pageForCity(fromAddress) || fromAddress;

  return SAN_DIEGO_ZIP_NEIGHBORHOOD[zip]
    || COUNTY_ZIP_NEIGHBORHOOD[zip]
    || 'San Diego';
}
