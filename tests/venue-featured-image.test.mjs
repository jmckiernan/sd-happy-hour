import assert from 'node:assert/strict';
import { resolveLiveFeaturedImage } from '../src/lib/venueContent.ts';

function test(name, fn) {
  return fn().then(
    () => console.log(`ok ${name}`),
    (error) => {
      console.error(`fail ${name}`);
      throw error;
    },
  );
}

await test('resolveLiveFeaturedImage keeps a healthy override image', async () => {
  const base = { id: 1, image: '/api/images/base.png' };
  const merged = { ...base, image: '/api/images/override.png' };
  const featured = await resolveLiveFeaturedImage(
    base,
    merged,
    { patch: { image: '/api/images/override.png' } },
    async (url) => url.endsWith('override.png'),
  );
  assert.equal(featured.image, '/api/images/override.png');
});

await test('resolveLiveFeaturedImage falls back to the catalog image when override blob is missing', async () => {
  const base = { id: 21, image: '/api/images/catalog.png' };
  const merged = { ...base, image: '/api/images/stale-override.png' };
  const featured = await resolveLiveFeaturedImage(
    base,
    merged,
    { patch: { image: '/api/images/stale-override.png' } },
    async (url) => url.endsWith('catalog.png'),
  );
  assert.equal(featured.image, '/api/images/catalog.png');
});

await test('resolveLiveFeaturedImage clears broken override and catalog images for vibe fallback', async () => {
  const base = { id: 21, image: '/api/images/missing-catalog.png', vibe: 'rooftop' };
  const merged = { ...base, image: '/api/images/missing-override.png' };
  const featured = await resolveLiveFeaturedImage(
    base,
    merged,
    { patch: { image: '/api/images/missing-override.png' } },
    async () => false,
  );
  assert.equal(featured.image, '');
});
