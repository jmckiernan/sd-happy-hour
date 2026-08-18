// Pulls the hero images that blog posts actually reference out of the
// production Netlify Blobs store and onto local disk, so `astro dev` renders
// real images instead of broken ones.
//
// Why this is needed: `netlify dev` and `netlify serve` do NOT proxy Blobs to
// production — the CLI runs an empty local sandbox store ("Netlify Blobs
// running in sandbox mode for local development"), so every /api/images/<key>
// request 404s locally no matter which dev command you use. Plain `astro dev`
// is the one mode that reads images off disk, via the `.data/images/` fallback
// in src/lib/imageStore.ts, because there Blobs is unavailable entirely.
//
// So this writes into `.data/images/` in exactly the layout that fallback
// expects: the bytes at `<key>`, plus a `<key>.meta.json` sidecar holding the
// contentType (imageStore.readImage reads both).
//
// Driven by what the content files reference rather than by `blobs:list`,
// which also contains orphans from superseded edits. A key that's referenced
// but absent from the store is reported rather than skipped silently — that's
// a post that will render broken in production too.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BLOG_DIR = path.join(process.cwd(), 'src', 'content', 'blog');
// Venues can carry an admin-set featured photo too (see the `image` field in
// src/lib/venues.ts), stored in the same Blobs store, so those keys need
// pulling as well or every venue with a real photo renders broken in dev.
const VENUE_DATA = path.join(process.cwd(), 'public', 'data', 'happy-hours.json');
const IMAGE_DIR = path.join(process.cwd(), '.data', 'images');
const STORE_NAME = 'blog-images';

// Inverse of EXT_BY_CONTENT_TYPE in src/lib/imageStore.ts. Kept as its own
// map rather than imported because that module is TypeScript inside the Astro
// build, and this is a plain node script run outside it.
const CONTENT_TYPE_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

// Only keys served by our own /api/images/ route can come from the store;
// a heroImage pointing at some external URL is left alone.
const OWN_IMAGE_RE = /^\/api\/images\/([^/"']+)$/;

async function referencedKeys() {
  const files = (await fs.readdir(BLOG_DIR)).filter((f) => f.endsWith('.md'));
  const found = new Map(); // key -> [post slugs referencing it]

  for (const file of files) {
    const raw = await fs.readFile(path.join(BLOG_DIR, file), 'utf-8');
    const line = raw.split(/\r?\n/).find((l) => l.trim().startsWith('heroImage:'));
    if (!line) continue;

    const value = line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
    const match = value.match(OWN_IMAGE_RE);
    if (!match) continue;

    const key = match[1];
    if (!found.has(key)) found.set(key, []);
    found.get(key).push(file.replace(/\.md$/, ''));
  }

  // Venue featured photos, from the same store. Read tolerantly: a checkout
  // without the data file (or with an older one that has no `image` fields) is
  // a normal state, not an error.
  try {
    const venues = JSON.parse(await fs.readFile(VENUE_DATA, 'utf-8'));
    for (const venue of venues) {
      const match = String(venue.image || '').match(OWN_IMAGE_RE);
      if (!match) continue;
      const key = match[1];
      if (!found.has(key)) found.set(key, []);
      found.get(key).push(`venue: ${venue.name}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  return found;
}

// Resolved rather than run through a shell: `shell: true` concatenates args
// without escaping (node warns DEP0190 about it), and these keys come out of
// content files.
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// Retried because a single `blobs:get` fails intermittently — the first run of
// this script reported a key as absent that `blobs:list` showed was present
// and that fetched fine moments later. Treating one failure as "missing" would
// mean telling you a post needs a new image when it doesn't.
const FETCH_ATTEMPTS = 3;

async function fetchBlob(key, destination) {
  let lastOutput = '';

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    const result = spawnSync(
      NPX,
      ['netlify', 'blobs:get', STORE_NAME, key, '--output', destination],
      { encoding: 'utf-8' }
    );
    lastOutput = `${result.stdout || ''}${result.stderr || ''}`.trim();

    // A non-zero exit can still leave a partial or empty file behind, and an
    // empty file would otherwise look like a valid cached image next run.
    let bytes = 0;
    try {
      bytes = (await fs.stat(destination)).size;
    } catch {
      bytes = 0;
    }

    if (result.status === 0 && bytes > 0) return { ok: true, output: lastOutput };

    await fs.rm(destination, { force: true });
    if (attempt < FETCH_ATTEMPTS) {
      console.log(`  retry ${attempt}/${FETCH_ATTEMPTS - 1} ${key}`);
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }

  return { ok: false, output: lastOutput };
}

async function main() {
  await fs.mkdir(IMAGE_DIR, { recursive: true });

  const keys = await referencedKeys();
  if (keys.size === 0) {
    console.log('No /api/images/ images referenced by any post or venue — nothing to pull.');
    return;
  }

  const pulled = [];
  const skipped = [];
  const missing = [];

  for (const [key, posts] of keys) {
    const destination = path.join(IMAGE_DIR, key);

    // Keys are never reused (makeImageKey stamps time + random suffix), so an
    // existing file is necessarily the right bytes and can be left alone.
    // Both halves have to be there though: readImage() reads the bytes AND the
    // sidecar, so an image without its meta.json still 404s.
    const [hasBytes, hasMeta] = await Promise.all([
      fs.access(destination).then(() => true, () => false),
      fs.access(`${destination}.meta.json`).then(() => true, () => false),
    ]);
    if (hasBytes && hasMeta) {
      skipped.push(key);
      continue;
    }

    if (!hasBytes) {
      const { ok, output } = await fetchBlob(key, destination);
      if (!ok) {
        missing.push({ key, posts, output });
        continue;
      }
    }

    const ext = path.extname(key).slice(1).toLowerCase();
    const contentType = CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream';
    await fs.writeFile(`${destination}.meta.json`, JSON.stringify({ contentType }));
    pulled.push(key);
  }

  console.log(`\nPulled ${pulled.length}, already present ${skipped.length}, missing ${missing.length}.`);
  for (const key of pulled) console.log(`  pulled   ${key}`);
  for (const key of skipped) console.log(`  cached   ${key}`);

  if (missing.length) {
    console.log(
      `\n${missing.length} referenced image(s) could not be fetched after ${FETCH_ATTEMPTS} attempts.\n` +
        `Cross-check with \`npx netlify blobs:list ${STORE_NAME}\`: absent from that list means the\n` +
        `bytes are genuinely gone and that post/venue needs a new image; present means the CLI is\n` +
        `still flaking and re-running this should pick it up.`
    );
    for (const { key, posts: referencedBy, output } of missing) {
      console.log(`  FAILED   ${key}`);
      console.log(`           referenced by: ${referencedBy.join(', ')}`);
      if (output) console.log(`           ${output.replace(/\n/g, '\n           ')}`);
    }
    // Non-zero so this is usable as a check, not just a fetch.
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
