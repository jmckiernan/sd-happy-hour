// One-time (re-runnable) importer: downloads the stock "vibe" photos this
// site used to hotlink from Unsplash into public/images/vibes/, so the site
// serves its own copies instead of depending on images.unsplash.com staying
// up and keeping those photo IDs alive.
//
// Run with: npm run fetch:vibe-images
//
// Masters are fetched at 1600px wide because that's the largest size the
// site asks for (the venue-page hero). Netlify Image CDN downscales from
// this master for the 800px homepage cards at request time, so there's no
// need to commit a second pre-sized variant per photo — see getVenueImage()
// in src/lib/venues.ts.
import fs from 'node:fs/promises';
import path from 'node:path';

// The photo IDs previously hardcoded in src/lib/venues.ts's vibeImages map.
// Kept here (rather than imported) so this script stays runnable after that
// map is rewritten to point at the local files it produces.
const SOURCES = {
  'upscale-casual': 'photo-1514362545857-3bc16c4c7d1b',
  'speakeasy': 'photo-1470337458703-46ad1756a187',
  'trendy-gastropub': 'photo-1538488881038-e252a119ace7',
  'seafood-spot': 'photo-1559339352-11d035aa65de',
  'rooftop-vibes': 'photo-1517457373958-b7bdd4587205',
  'modern-mexican': 'photo-1582169296194-e4d644c48063',
  'tiki-bar': 'photo-1536935338788-846bb9981813',
  'chef-driven': 'photo-1550966871-3ed3cdb5ed0c',
  'wine-bar': 'photo-1510812431401-41d2bd2722f3',
  'upscale-mediterranean': 'photo-1544148103-0773bf10d330',
  'neighborhood-gastropub': 'photo-1575037614876-c38a4d44f5b8',
  'craft-cocktails': 'photo-1551024709-8f23befc6f87',
  'dog-friendly-patio': 'photo-1466978913421-dad2ebd01d17',
  'casual-chicken-joint': 'photo-1626645738196-c2a7c87a8f58',
  'waterfront-mexican': 'photo-1552566626-52f8b828add9',
  'arcade-bar': 'photo-1511882150382-421056c89033',
  'all-day-cafe': 'photo-1495474472287-4d71bcdd2085',
  'italian-gastropub': 'photo-1517248135467-4c7edcad34c4',
  'vegan-metal-bar': 'photo-1572116469696-31de0f17cc34',
  'beach-brewery': 'photo-1559526324-593bc073d938',
};

const OUT_DIR = path.join(process.cwd(), 'public', 'images', 'vibes');
const WIDTH = 1600;
const QUALITY = 85;

// A truncated/HTML error page would still "download" fine and then render as
// a broken image on the site, so verify each response is actually a JPEG
// before writing it.
function assertJpeg(slug, contentType, bytes) {
  if (!contentType.startsWith('image/jpeg')) {
    throw new Error(`${slug}: expected image/jpeg, got "${contentType}"`);
  }
  if (bytes.length < 10_000) {
    throw new Error(`${slug}: suspiciously small (${bytes.length} bytes)`);
  }
  // JPEG SOI marker.
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) {
    throw new Error(`${slug}: does not start with a JPEG SOI marker`);
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const entries = Object.entries(SOURCES);
  let written = 0;
  let totalBytes = 0;
  const failures = [];

  for (const [slug, photoId] of entries) {
    const url = `https://images.unsplash.com/${photoId}?w=${WIDTH}&q=${QUALITY}&fm=jpg`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
      const bytes = Buffer.from(await res.arrayBuffer());
      assertJpeg(slug, contentType, bytes);

      await fs.writeFile(path.join(OUT_DIR, `${slug}.jpg`), bytes);
      written++;
      totalBytes += bytes.length;
      console.log(`  ok   ${slug}.jpg  (${(bytes.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      failures.push(`${slug}: ${err.message}`);
      console.error(`  FAIL ${slug}  ${err.message}`);
    }
  }

  console.log(
    `\n${written}/${entries.length} written to public/images/vibes/ ` +
      `(${(totalBytes / 1024 / 1024).toFixed(1)} MB total)`
  );

  if (failures.length) {
    console.error(`\n${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
}

main();
