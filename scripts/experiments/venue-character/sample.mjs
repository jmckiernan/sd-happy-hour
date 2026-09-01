/**
 * EXPLORATORY — not part of the import pipeline. See docs/proprietary-venue-attributes.md §5.
 *
 * Draws a stratified sample of 40 *published* venues for the character-vibe spike.
 * Deterministic: SHA-1 of venue id → stable order. Guarantees the evidence strata
 * the brief requires (menu+deals, deals-only, thin, chain domains, gold-control seeds).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OUT_DIR = path.join(ROOT, '.data', 'experiments', 'venue-character');

const SAMPLE_SIZE = 40;

/** Collapse today's vibe / name into a kind bucket for stratification. */
function kindBucket(venue) {
  const text = `${venue.vibe || ''} ${venue.name || ''}`.toLowerCase();
  if (/arcade|pinball|game room/.test(text)) return 'arcade';
  if (/tiki/.test(text)) return 'tiki';
  if (/speakeasy|hidden bar/.test(text)) return 'speakeasy';
  if (/rooftop/.test(text)) return 'rooftop';
  if (/waterfront|harbor|marina|beach bar|oceanfront/.test(text)) return 'waterfront';
  if (/wine/.test(text)) return 'wine';
  if (/brew|taproom|alehouse|beer/.test(text)) return 'brewery';
  if (/sports/.test(text)) return 'sports';
  if (/cocktail|lounge|craft cocktail/.test(text)) return 'cocktail';
  if (/gastropub/.test(text)) return 'gastropub';
  if (/dive/.test(text)) return 'dive';
  if (/pub|tavern|ale house/.test(text)) return 'pub';
  if (/bar/.test(text)) return 'bar';
  return 'other';
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

function orderKey(venue) {
  return crypto.createHash('sha1').update(`venue-character:${venue.id}`).digest('hex');
}

function hasMenu(venue) {
  return Boolean(venue.hhMenu?.sections?.length || venue.hhMenu?.note);
}

function hasDeals(venue) {
  return Array.isArray(venue.deals) && venue.deals.length > 0;
}

function ownWebsite(venue) {
  const h = host(venue.website);
  if (!h) return false;
  return !/instagram\.com|facebook\.com|m\.facebook\.com|linktr\.ee|maps\.google\.com/i.test(h);
}

/** Hand-typed seed vibes that map cleanly onto the closed character vocabulary. */
const GOLD_SEED_IDS = new Set([
  3, // Raised by Wolves — Speakeasy
  7, // False Idol — Tiki bar
  16, // Coin-Op Game Room — Arcade bar
  5, // Rustic Root — Rooftop vibes
  15, // Coasterra — Waterfront Mexican
]);

function evidenceClass(venue) {
  const menu = hasMenu(venue);
  const deals = hasDeals(venue);
  const web = ownWebsite(venue);
  if (menu && deals && web) return 'menu+deals+web';
  if (!menu && deals) return 'deals-no-menu';
  if (!menu && !deals) return 'thin';
  if (menu && !deals) return 'menu-only';
  return 'other';
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'happy-hours.json'), 'utf8'));
  const venues = Array.isArray(catalog) ? catalog : catalog.venues;

  const domainCounts = new Map();
  for (const venue of venues) {
    const h = host(venue.website);
    if (h) domainCounts.set(h, (domainCounts.get(h) || 0) + 1);
  }

  const pool = venues
    .filter((venue) => venue.listingStatus === 'published')
    .filter((venue) => /^https?:\/\//i.test(venue.website || ''))
    .filter((venue) => !/^maps\.google\.com$/i.test(host(venue.website)))
    .filter((venue) => !/temecula|murrieta|san clemente|dana point|mission viejo|menifee|corona/i.test(venue.neighborhood || ''))
    .map((venue) => ({
      id: venue.id,
      name: venue.name,
      neighborhood: venue.neighborhood,
      address: venue.address,
      website: venue.website,
      vibe: venue.vibe || null,
      deals: venue.deals || [],
      hasMenu: hasMenu(venue),
      hasDeals: hasDeals(venue),
      ownWebsite: ownWebsite(venue),
      evidenceClass: evidenceClass(venue),
      kind: kindBucket(venue),
      region: region(venue),
      host: host(venue.website),
      chain: (domainCounts.get(host(venue.website)) || 0) >= 3,
      goldSeed: GOLD_SEED_IDS.has(venue.id),
      // Catalog fields frozen into the sample so extract can build packets without re-reading the whole catalog.
      hhMenu: venue.hhMenu || null,
      weeklySpecials: venue.weeklySpecials || null,
      galleryImages: (venue.galleryImages || []).slice(0, 12).map((img) => ({
        url: img.url || img.src || null,
        caption: img.caption || img.alt || null,
        filename: typeof img === 'string' ? img : (img.url || img.src || '').split('/').pop() || null,
      })),
      key: orderKey(venue),
    }));

  // Prefer richer evidence in the base draw (menu+deals first), then fill.
  const preference = { 'menu+deals+web': 0, 'menu-only': 1, 'deals-no-menu': 2, other: 3, thin: 4 };

  const kindShare = {};
  for (const row of pool) kindShare[row.kind] = (kindShare[row.kind] || 0) + 1;

  const quota = {};
  for (const [kind, count] of Object.entries(kindShare)) {
    quota[kind] = Math.max(1, Math.round((count / pool.length) * SAMPLE_SIZE));
  }
  let totalQuota = Object.values(quota).reduce((a, b) => a + b, 0);
  while (totalQuota > SAMPLE_SIZE) {
    const biggest = Object.entries(quota).sort((a, b) => b[1] - a[1])[0][0];
    if (quota[biggest] <= 1) break;
    quota[biggest] -= 1;
    totalQuota -= 1;
  }
  while (totalQuota < SAMPLE_SIZE) {
    const biggest = Object.entries(kindShare).sort((a, b) => b[1] - a[1])[0][0];
    quota[biggest] = (quota[biggest] || 0) + 1;
    totalQuota += 1;
  }

  const picked = [];
  const usedHosts = new Set();
  const usedNeighborhoods = new Map();
  const pinned = new Set();

  function tryPick(row, { neighborhoodCap = 2, pin = false } = {}) {
    if (picked.some((p) => p.id === row.id)) return false;
    if (usedHosts.has(row.host)) return false;
    if ((usedNeighborhoods.get(row.neighborhood) || 0) >= neighborhoodCap) return false;
    picked.push(row);
    usedHosts.add(row.host);
    usedNeighborhoods.set(row.neighborhood, (usedNeighborhoods.get(row.neighborhood) || 0) + 1);
    if (pin) pinned.add(row.id);
    return true;
  }

  function reserve(predicate, min, label, { preferRich = false } = {}) {
    const wanted = pool
      .filter((row) => predicate(row) && !picked.some((p) => p.id === row.id))
      .sort((a, b) => {
        if (preferRich) {
          const pref = (preference[a.evidenceClass] ?? 9) - (preference[b.evidenceClass] ?? 9);
          if (pref !== 0) return pref;
        }
        return a.key.localeCompare(b.key);
      });
    for (const row of wanted) {
      if (picked.filter(predicate).length >= min) break;
      tryPick(row, { neighborhoodCap: 4, pin: true });
    }
    const final = picked.filter(predicate).length;
    if (final < min) console.warn(`  ! could not reserve ${min} ${label} (have ${final})`);
  }

  // Reserve the brief's required strata BEFORE kind fill, or menu+deals crowds them out.
  reserve((row) => row.goldSeed, 3, 'gold-control seed vibes');
  reserve((row) => row.evidenceClass === 'thin', 5, 'thin / stub evidence');
  reserve((row) => row.evidenceClass === 'deals-no-menu', 5, 'deals but no menu');
  reserve((row) => row.evidenceClass === 'menu+deals+web', 5, 'menu+deals+own-website', { preferRich: true });
  reserve((row) => row.chain, 3, 'chain-domain venues');

  for (const [kind, want] of Object.entries(quota)) {
    const bucket = pool
      .filter((row) => row.kind === kind)
      .sort((a, b) => {
        const pref = (preference[a.evidenceClass] ?? 9) - (preference[b.evidenceClass] ?? 9);
        if (pref !== 0) return pref;
        return a.key.localeCompare(b.key);
      });
    const takenRegions = new Set(picked.filter((p) => p.kind === kind).map((p) => p.region));
    let taken = picked.filter((p) => p.kind === kind).length;
    for (const row of bucket) {
      if (taken >= want || picked.length >= SAMPLE_SIZE) break;
      if (takenRegions.has(row.region)) continue;
      if (tryPick(row)) {
        takenRegions.add(row.region);
        taken += 1;
      }
    }
    for (const row of bucket) {
      if (taken >= want || picked.length >= SAMPLE_SIZE) break;
      if (tryPick(row)) taken += 1;
    }
  }

  while (picked.length > SAMPLE_SIZE) {
    const index = [...picked.keys()].reverse().find((i) => !pinned.has(picked[i].id));
    if (index == null) break;
    usedHosts.delete(picked[index].host);
    picked.splice(index, 1);
  }
  if (picked.length < SAMPLE_SIZE) {
    const fillers = pool
      .filter((row) => !picked.some((p) => p.id === row.id) && !usedHosts.has(row.host))
      .sort((a, b) => {
        const pref = (preference[a.evidenceClass] ?? 9) - (preference[b.evidenceClass] ?? 9);
        if (pref !== 0) return pref;
        return a.key.localeCompare(b.key);
      });
    for (const row of fillers) {
      if (picked.length >= SAMPLE_SIZE) break;
      tryPick(row);
    }
  }

  picked.sort((a, b) => a.id - b.id);

  // Drop bulky fields from the on-disk sample listing; crawl/extract reattach from catalog when needed.
  const slim = picked.map(({ hhMenu, weeklySpecials, galleryImages, key, ...rest }) => rest);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'sample.json'),
    `${JSON.stringify({
      drawnAt: new Date().toISOString(),
      poolSize: pool.length,
      quota,
      venues: slim,
      // Keep evidence snapshots for extract without another catalog pass.
      evidence: Object.fromEntries(
        picked.map((row) => [
          row.id,
          {
            hhMenu: row.hhMenu,
            weeklySpecials: row.weeklySpecials,
            galleryImages: row.galleryImages,
            deals: row.deals,
            vibe: row.vibe,
          },
        ])
      ),
    }, null, 2)}\n`
  );

  const by = (fn) => {
    const counts = {};
    for (const row of picked) counts[fn(row)] = (counts[fn(row)] || 0) + 1;
    return counts;
  };
  console.log(`pool ${pool.length} → sample ${picked.length}`);
  console.log('kind   ', by((r) => r.kind));
  console.log('region ', by((r) => r.region));
  console.log('evidence', by((r) => r.evidenceClass));
  console.log('chain  ', by((r) => (r.chain ? 'chain' : 'independent')));
  console.log('gold   ', by((r) => (r.goldSeed ? 'gold' : 'ordinary')));
  for (const row of picked) {
    console.log(
      `  ${String(row.id).padStart(5)}  ${row.name.slice(0, 34).padEnd(34)} ${row.kind.padEnd(10)} ${row.evidenceClass.padEnd(16)} ${row.goldSeed ? 'GOLD' : '    '} ${row.website}`
    );
  }
}

main();
