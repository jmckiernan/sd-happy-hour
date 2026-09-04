import assert from 'node:assert/strict';
import { storedImageUrlKey } from '../src/lib/imageStore.ts';
import { loadSourceImage } from '../src/lib/loadSourceImage.ts';

const requestUrl = new URL('https://happyhoursd.com/api/admin/edit-image');

assert.equal(storedImageUrlKey('/api/images/foo-bar.jpg'), 'foo-bar.jpg');
assert.equal(storedImageUrlKey('https://happyhoursd.com/api/images/foo-bar.jpg'), 'foo-bar.jpg');
assert.equal(storedImageUrlKey('https://happyhoursd.com/api/images/foo-bar.jpg/'), 'foo-bar.jpg');
assert.equal(storedImageUrlKey('/images/venues/1-ironside.jpg'), null);

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]);
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://happyhoursd.com/images/vibes/trendy-gastropub.jpg') {
    assert.equal(init.headers?.cookie, 'admin=1');
    return new Response(jpegBytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }
  if (url === 'https://example.com/photo.jpg') {
    assert.equal(init.headers?.cookie, undefined);
    return new Response(jpegBytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

try {
  const staticImage = await loadSourceImage('/images/vibes/trendy-gastropub.jpg', {
    requestUrl,
    cookieHeader: 'admin=1',
  });
  assert.equal(staticImage.contentType, 'image/jpeg');
  assert.deepEqual(staticImage.bytes, jpegBytes);

  const remoteImage = await loadSourceImage('https://example.com/photo.jpg', { requestUrl });
  assert.equal(remoteImage.contentType, 'image/jpeg');
  assert.deepEqual(remoteImage.bytes, jpegBytes);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('ok   loadSourceImage fetches committed public assets same-origin with admin cookie');
console.log('ok   loadSourceImage fetches third-party URLs without cookie forwarding');
console.log('ok   storedImageUrlKey handles absolute blob URLs');
