import assert from 'node:assert/strict';
import { storedImageUrlKey } from '../src/lib/imageStore.ts';
import { loadSourceImage } from '../src/lib/loadSourceImage.ts';

const requestUrl = new URL('https://happyhoursd.com/api/admin/edit-image');

assert.equal(storedImageUrlKey('/api/images/foo-bar.jpg'), 'foo-bar.jpg');
assert.equal(storedImageUrlKey('https://happyhoursd.com/api/images/foo-bar.jpg'), 'foo-bar.jpg');
assert.equal(storedImageUrlKey('https://happyhoursd.com/api/images/foo-bar.jpg/'), 'foo-bar.jpg');
assert.equal(storedImageUrlKey('/images/venues/1-ironside.jpg'), null);

const staticImage = await loadSourceImage('/images/vibes/trendy-gastropub.jpg', { requestUrl });
assert.equal(staticImage.contentType, 'image/jpeg');
assert.ok(staticImage.bytes.byteLength > 1000);

console.log('ok   loadSourceImage reads committed public assets');
console.log('ok   storedImageUrlKey handles absolute blob URLs');
