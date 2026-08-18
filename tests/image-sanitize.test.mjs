// Tests for src/lib/imageSanitize.ts — the hardening that stands between
// owner-uploaded photos (src/pages/api/restaurant/venues/[id]/photos.ts) and
// the Blobs store. Worth real tests: it is the only thing between a hostile
// upload and a public page.
//
// Run with `npm run test:images`, which bundles through esbuild first since
// these import TypeScript directly.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sanitizeUploadedImage, sniffImageType } from '../src/lib/imageSanitize.ts';

const OPTS = { maxBytes: 8 * 1024 * 1024, minWidth: 600, minHeight: 400, maxDimension: 6000 };

let failures = 0;
const check = (name, condition, detail = '') => {
  if (!condition) {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  } else {
    console.log(`ok   ${name} ${detail}`);
  }
};
const contains = (bytes, needle) => Buffer.from(bytes).includes(Buffer.from(needle, 'latin1'));

// --- PNG builder, so the PNG cases run against a real, decodable file ------
function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function buildPng(width, height, extraChunks = [], trailing = Buffer.alloc(0)) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extraChunks,
    pngChunk('IDAT', zlib.deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
    trailing,
  ]);
}

// --- real JPEGs from the repo survive the round trip ----------------------
const VIBE_DIR = 'public/images/vibes';
for (const file of fs.readdirSync(VIBE_DIR).filter((f) => f.endsWith('.jpg')).slice(0, 4)) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(VIBE_DIR, file)));
  const result = sanitizeUploadedImage(bytes, 'image/jpeg', OPTS);
  check(`real jpeg accepted: ${file}`, result.ok, result.ok ? `${result.width}x${result.height}` : result.error);
  if (result.ok) {
    check(`  ${file} is still a jpeg`, sniffImageType(result.bytes) === 'image/jpeg');
    check(
      `  ${file} ends at EOI`,
      result.bytes[result.bytes.length - 2] === 0xff && result.bytes[result.bytes.length - 1] === 0xd9
    );
  }
}

// --- PNG: metadata chunks and appended payload are removed ----------------
const dirtyPng = buildPng(
  700,
  500,
  [
    pngChunk('tEXt', Buffer.from('Comment SECRET-METADATA-MARKER', 'latin1')),
    pngChunk('eXIf', Buffer.from('GPS-LOCATION-MARKER', 'latin1')),
  ],
  Buffer.from('<script>APPENDED-PAYLOAD</script>', 'latin1')
);
const pngResult = sanitizeUploadedImage(new Uint8Array(dirtyPng), 'image/png', OPTS);
check('png accepted', pngResult.ok, pngResult.ok ? `${pngResult.width}x${pngResult.height}` : pngResult.error);
if (pngResult.ok) {
  check(
    '  png text/EXIF metadata stripped',
    !contains(pngResult.bytes, 'SECRET-METADATA-MARKER') && !contains(pngResult.bytes, 'GPS-LOCATION-MARKER')
  );
  check('  png appended payload dropped', !contains(pngResult.bytes, 'APPENDED-PAYLOAD'));
  check('  png ends at IEND', Buffer.from(pngResult.bytes.slice(-8, -4)).toString('latin1') === 'IEND');
}

// --- JPEG: EXIF block and appended payload are removed -------------------
const jpegSrc = fs.readFileSync(path.join(VIBE_DIR, 'wine-bar.jpg'));
const exifBody = Buffer.from('Exif--GPS-33.1234-117.5678-MARKER', 'latin1');
const app1Length = Buffer.alloc(2);
app1Length.writeUInt16BE(exifBody.length + 2);
const jpegWithExif = Buffer.concat([
  jpegSrc.subarray(0, 2),
  Buffer.from([0xff, 0xe1]),
  app1Length,
  exifBody,
  jpegSrc.subarray(2),
  Buffer.from('APPENDED-JPEG-PAYLOAD', 'latin1'),
]);
const exifResult = sanitizeUploadedImage(new Uint8Array(jpegWithExif), 'image/jpeg', OPTS);
check(
  'jpeg with EXIF accepted',
  exifResult.ok,
  exifResult.ok ? `stripped ${exifResult.strippedBytes}B` : exifResult.error
);
if (exifResult.ok) {
  check('  jpeg GPS EXIF stripped', !contains(exifResult.bytes, 'GPS-33.1234-117.5678-MARKER'));
  check('  jpeg appended payload dropped', !contains(exifResult.bytes, 'APPENDED-JPEG-PAYLOAD'));
}

// --- everything that must be refused -------------------------------------
const rejections = [
  ['declared png but actually jpeg', new Uint8Array(jpegSrc), 'image/png'],
  ['gif', new Uint8Array(Buffer.from(`GIF89a${'x'.repeat(2000)}`, 'latin1')), 'image/gif'],
  [
    'webp',
    new Uint8Array(
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(2000)])
    ),
    'image/webp',
  ],
  [
    'svg with script',
    new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>', 'latin1')),
    'image/svg+xml',
  ],
  ['html pretending to be a jpeg', new Uint8Array(Buffer.from('<html><script>alert(1)</script></html>', 'latin1')), 'image/jpeg'],
  ['jpeg truncated before its header', new Uint8Array(jpegSrc.subarray(0, 400)), 'image/jpeg'],
  // Truncated mid-scan: the header still parses, so only the missing EOI
  // marker catches this one.
  ['jpeg truncated mid-scan', new Uint8Array(jpegSrc.subarray(0, Math.floor(jpegSrc.length * 0.6))), 'image/jpeg'],
  ['empty file', new Uint8Array(0), 'image/jpeg'],
  ['png with no IEND', new Uint8Array(buildPng(700, 500).subarray(0, 200)), 'image/png'],
];
for (const [name, bytes, declaredType] of rejections) {
  const result = sanitizeUploadedImage(bytes, declaredType, OPTS);
  check(`rejected: ${name}`, result.ok === false, result.ok ? 'WRONGLY ACCEPTED' : `-> ${result.error.slice(0, 50)}`);
}

// --- size and dimension bounds -------------------------------------------
const tooSmall = sanitizeUploadedImage(new Uint8Array(dirtyPng), 'image/png', {
  ...OPTS,
  minWidth: 1200,
  minHeight: 900,
});
check('rejected: below minimum dimensions', tooSmall.ok === false, tooSmall.ok ? 'WRONGLY ACCEPTED' : '');

const tooBig = sanitizeUploadedImage(new Uint8Array(dirtyPng), 'image/png', { ...OPTS, maxDimension: 200 });
check('rejected: above maximum dimensions', tooBig.ok === false, tooBig.ok ? 'WRONGLY ACCEPTED' : '');

const tooHeavy = sanitizeUploadedImage(new Uint8Array(dirtyPng), 'image/png', { ...OPTS, maxBytes: 100 });
check('rejected: above byte cap', tooHeavy.ok === false, tooHeavy.ok ? 'WRONGLY ACCEPTED' : '');

console.log(
  failures === 0 ? '\nimage sanitize: all checks passed' : `\nimage sanitize: ${failures} failure(s)`
);
process.exitCode = failures ? 1 : 0;
