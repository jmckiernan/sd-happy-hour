import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverVenueImageCandidates,
  fetchVenueImageCandidate,
  sniffImageDimensions,
  venueImageFilename,
} from '../scripts/import-google-venues/lib/venue-images.mjs';
import { aiVenueImageFilename, brandKey, findChainReference } from '../scripts/import-google-venues/lib/ai-venue-images.mjs';

test('website candidate discovery ranks photographic metadata and rejects logos', () => {
  const html = `
    <meta property="og:image" content="/assets/the-waterfront-hero.jpg">
    <meta name="twitter:image" content="/assets/social.jpg">
    <img class="site-logo" src="/assets/logo.png" width="1600" height="900" alt="Logo">
    <img class="hero restaurant-interior" src="/assets/interior.jpg" width="1800" height="1000" alt="The Waterfront dining room">
  `;
  const rows = discoverVenueImageCandidates(
    html,
    'https://waterfront.example/about',
    { name: 'The Waterfront Bar & Grill' }
  );
  assert.equal(rows.some((row) => row.url.endsWith('/assets/logo.png')), false);
  assert.equal(rows[0].url, 'https://waterfront.example/assets/interior.jpg');
  assert.ok(rows.some((row) => row.source === 'og_image'));
});

test('branch gallery filenames that name the neighborhood outrank generic page images', () => {
  const html = `
    <img src="/uploads/bg_bonita1.jpg" width="1600" height="900" alt="">
    <img src="/uploads/agave-bg.jpg" width="1600" height="900" alt="">
  `;
  const rows = discoverVenueImageCandidates(
    html,
    'https://karinasseafood.com/bonita/',
    { name: "Karina's Mexican Seafood - Bonita", neighborhood: 'Bonita', address: '89 Bonita Rd, Chula Vista, CA 91910' }
  );
  assert.equal(rows[0].url, 'https://karinasseafood.com/uploads/bg_bonita1.jpg');
  assert.ok(rows[0].score > rows.find((row) => row.url.endsWith('/agave-bg.jpg')).score);
});

test('srcset chooses the largest declared source and deduplicates it', () => {
  const html = `<img class="hero" src="small.jpg" srcset="small.jpg 400w, large.jpg 1800w"><meta property="og:image" content="large.jpg">`;
  const rows = discoverVenueImageCandidates(html, 'https://venue.example/');
  assert.equal(rows.filter((row) => row.url.endsWith('/large.jpg')).length, 1);
});

test('webp VP8X dimensions parse without an image dependency', () => {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUIntLE(1599, 24, 3);
  bytes.writeUIntLE(899, 27, 3);
  assert.deepEqual(sniffImageDimensions(bytes, 'image/webp'), { width: 1600, height: 900 });
});

test('candidate downloader rejects images below the hero floor', async () => {
  const png = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(600, 16);
  png.writeUInt32BE(400, 20);
  const result = await fetchVenueImageCandidate(
    { url: 'https://venue.example/photo.png', pageUrl: 'https://venue.example/', score: 80 },
    async () => ({
      ok: true,
      headers: { get: (name) => name === 'content-type' ? 'image/png' : '' },
      arrayBuffer: async () => png,
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too_small');
});

test('persisted website image names are stable and provider-specific', () => {
  assert.equal(venueImageFilename({ id: 4, name: 'The Waterfront Bar & Grill' }, 'image/webp'), '4-the-waterfront-bar-grill-website.webp');
});

test('brand key groups chain branches and ai filenames are distinct', () => {
  assert.equal(brandKey('Board & Brew - Oceanside'), brandKey('Board & Brew - Escondido'));
  assert.equal(aiVenueImageFilename({ id: 637, name: 'Board & Brew - Oceanside' }), '637-board-brew-oceanside-ai.jpg');
  const reference = findChainReference(
    { id: 637, name: 'Board & Brew - Oceanside' },
    [{ id: 624, name: 'Board & Brew', image: '/images/venues/624-board-brew-website.jpg' }, { id: 637, name: 'Board & Brew - Oceanside' }]
  );
  assert.equal(reference?.id, 624);
});

