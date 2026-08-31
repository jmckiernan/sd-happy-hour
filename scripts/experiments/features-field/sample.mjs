/**
 * EXPLORATORY — not part of the import pipeline. See docs/features-field-experiment.md.
 *
 * Draws a stratified sample of catalog venues with a usable website, for the
 * one-off test of whether venue features can be read off venue websites.
 * Deterministic: same catalog in, same 30 venues out, no RNG seed to remember.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OUT_DIR = path.join(ROOT, '.data', 'experiments', 'features-field');

const SAMPLE_SIZE = 30;

/** Vibe strings collapsed into the four venue types the question is about. */
function venueType(venue) {
  const vibe = String(venue.vibe || '').toLowerCase();
  if (/cafe|coffee|bakery|donut|juice/.test(vibe)) return 'cafe';
  if (/brew|beer|taproom/.test(vibe)) return 'brewery';
  if (/bar|nightlife|speakeasy|lounge|tiki|pub|cocktail/.test(vibe)) return 'bar';
  return 'restaurant';
}

const REGIONS = [
  ['coastal', /pacific beach|ocean beach|mission beach|la jolla|coronado|encinitas|carlsbad|oceanside|del mar|solana beach|cardiff|leucadia|point loma|imperial beach/i],
  ['urban core', /gaslamp|little italy|east village|north park|south park|hillcrest|golden hill|bankers hill|barrio logan|normal heights|university heights|mission hills|downtown|logan heights|city heights/i],
  ['south bay', /chula vista|national city|otay|bonita|san ysidro/i],
  ['north county inland', /escondido|san marcos|vista|poway|rancho bernardo|fallbrook|ramona|valley center|4s ranch|rancho penasquitos/i],
  ['east county', /el cajon|la mesa|santee|lakeside|alpine|spring valley|lemon grove|jamul/i],
];

function region(venue) {
  const name = String(venue.neighborhood || '');
  for (const [label, re] of REGIONS) if (re.test(name)) return label;
  return 'other san diego';
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/** A stable per-venue shuffle key, so the draw does not depend on array order. */
function orderKey(venue) {
  return crypto.createHash('sha1').update(`features-experiment:${venue.id}`).digest('hex');
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'happy-hours.json'), 'utf8'));
  const venues = Array.isArray(catalog) ? catalog : catalog.venues;

  const domainCounts = new Map();
  for (const venue of venues) {
    const h = host(venue.website);
    if (h) domainCounts.set(h, (domainCounts.get(h) || 0) + 1);
  }

  // A social profile is a real venue "website" in this catalog and one of the
  // roughest inputs the crawler ever sees, so it belongs in the pool, not in a
  // convenience filter. maps.google.com is not a venue site at all.
  const pool = venues
    .filter((venue) => /^https?:\/\//i.test(venue.website || ''))
    .filter((venue) => !/^maps\.google\.com$/i.test(host(venue.website)))
    // Known out-of-county residue from the search rectangle. A Temecula branch
    // is a fine chain website and a bad representative of this catalog.
    .filter((venue) => !/temecula|murrieta|san clemente|dana point|mission viejo|menifee|corona/i.test(venue.neighborhood || ''))
    .map((venue) => ({
      id: venue.id,
      name: venue.name,
      neighborhood: venue.neighborhood,
      address: venue.address,
      website: venue.website,
      vibe: venue.vibe,
      features: venue.features || [],
      hasHappyHourData: Boolean(venue.hasHappyHourData),
      type: venueType(venue),
      region: region(venue),
      host: host(venue.website),
      chain: (domainCounts.get(host(venue.website)) || 0) >= 3,
      social: /instagram\.com|facebook\.com|m\.facebook\.com|linktr\.ee/i.test(host(venue.website)),
      key: orderKey(venue),
    }));

  const typeShare = {};
  for (const row of pool) typeShare[row.type] = (typeShare[row.type] || 0) + 1;

  // Proportional allocation by venue type, floored at 3 so brewery and cafe are
  // not represented by one site each.
  const quota = {};
  for (const [type, count] of Object.entries(typeShare)) {
    quota[type] = Math.max(3, Math.round((count / pool.length) * SAMPLE_SIZE));
  }
  const overshoot = Object.values(quota).reduce((a, b) => a + b, 0) - SAMPLE_SIZE;
  if (overshoot > 0) {
    const biggest = Object.entries(quota).sort((a, b) => b[1] - a[1])[0][0];
    quota[biggest] -= overshoot;
  }

  const picked = [];
  const usedNeighborhoods = new Map();
  const usedHosts = new Set();

  function tryPick(row, neighborhoodCap) {
    if (usedHosts.has(row.host)) return false;
    if ((usedNeighborhoods.get(row.neighborhood) || 0) >= neighborhoodCap) return false;
    picked.push(row);
    usedHosts.add(row.host);
    usedNeighborhoods.set(row.neighborhood, (usedNeighborhoods.get(row.neighborhood) || 0) + 1);
    return true;
  }

  for (const [type, want] of Object.entries(quota)) {
    const bucket = pool.filter((row) => row.type === type).sort((a, b) => a.key.localeCompare(b.key));
    const takenRegions = new Set();
    let taken = 0;
    // First sweep spreads regions inside the type; second fills what is left.
    for (const row of bucket) {
      if (taken >= want) break;
      if (takenRegions.has(row.region)) continue;
      if (tryPick(row, 2)) {
        takenRegions.add(row.region);
        taken += 1;
      }
    }
    for (const row of bucket) {
      if (taken >= want) break;
      if (picked.includes(row)) continue;
      if (tryPick(row, 2)) taken += 1;
    }
  }

  // Guarantees the sample is not all polished independent restaurant sites.
  // Rows admitted by one guarantee are pinned so a later one cannot evict them.
  const pinned = new Set();

  function ensure(predicate, min, label) {
    if (picked.filter(predicate).length >= min) return;
    const wanted = pool
      .filter((row) => predicate(row) && !picked.some((p) => p.id === row.id))
      .sort((a, b) => a.key.localeCompare(b.key));
    for (const row of wanted) {
      if (picked.filter(predicate).length >= min) break;
      if (usedHosts.has(row.host)) continue;
      // Displace within the same venue type where possible, so a guarantee on
      // one axis does not quietly unbalance another.
      let index = picked.findIndex((p) => !predicate(p) && !pinned.has(p.id) && p.type === row.type);
      if (index < 0) index = picked.findIndex((p) => !predicate(p) && !pinned.has(p.id));
      if (index < 0) break;
      usedHosts.delete(picked[index].host);
      picked[index] = row;
      usedHosts.add(row.host);
      pinned.add(row.id);
    }
    for (const row of picked) if (predicate(row)) pinned.add(row.id);
    const final = picked.filter(predicate).length;
    if (final < min) console.warn(`  ! could not reach ${min} ${label} (have ${final})`);
  }

  ensure((row) => row.chain, 4, 'chain-domain venues');
  ensure((row) => row.social, 2, 'social-only websites');
  ensure((row) => row.hasHappyHourData, 8, 'venues with a published happy hour');

  picked.sort((a, b) => a.id - b.id);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'sample.json'),
    `${JSON.stringify({ drawnAt: new Date().toISOString(), poolSize: pool.length, quota, venues: picked }, null, 2)}\n`
  );

  const by = (fn) => {
    const counts = {};
    for (const row of picked) counts[fn(row)] = (counts[fn(row)] || 0) + 1;
    return counts;
  };
  console.log(`pool ${pool.length} → sample ${picked.length}`);
  console.log('type   ', by((r) => r.type));
  console.log('region ', by((r) => r.region));
  console.log('chain  ', by((r) => (r.chain ? 'chain' : 'independent')));
  console.log('listing', by((r) => (r.hasHappyHourData ? 'has happy hour' : 'stub')));
  for (const row of picked) {
    console.log(`  ${String(row.id).padStart(5)}  ${row.name.slice(0, 34).padEnd(34)} ${row.type.padEnd(10)} ${row.region.padEnd(19)} ${row.website}`);
  }
}

main();
