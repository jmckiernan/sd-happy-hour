#!/usr/bin/env node
// Reattach the scraped menu images that lost their reference.
//
// 256 files in public/images/venues were unreachable from the catalog, which
// looked at first like fallout from the chain purge. It is not. 254 of them are
// named `{id}-{slug}-hh-menu[-N].{ext}` — the convention `persistMenuFlyers`
// writes — and the id and slug match a listing that still has a menu but has no
// `sourceImages` recorded. They are the flyers those menus were transcribed
// from, orphaned when `normalizeMenuBoard` rebuilt each board from `note` and
// `sections` alone and dropped provenance on every re-render.
//
// So they are evidence, not litter, and deleting them would throw away the only
// copy of the image behind 254 transcriptions — the thing that makes a price
// checkable without revisiting a site that may since have changed.
//
// They are reattached as `menuCandidateImages`, not `sourceImages`. The
// stronger claim would be a guess: a menu may have been transcribed from the
// page's text and never from this image at all, and last week's beer-vat
// photograph proved that an image filed under "happy hour menu" is not
// necessarily a menu. `menuCandidateImages` is the field the pipeline already
// uses for exactly this — an image that may be a menu, kept for a later look,
// never displayed as one.
//
// Usage:
//   node scripts/import-google-venues/relink-orphan-menu-flyers.mjs
//   node scripts/import-google-venues/relink-orphan-menu-flyers.mjs --apply

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';

const IMAGE_DIR = 'public/images/venues';
const FLYER_RE = /^(\d+)-(.+?)-hh-menu(?:-\d+)?\.(?:png|jpe?g|webp)$/i;
const apply = process.argv.includes('--apply');

const slugify = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const venues = readJson(HAPPY_HOURS_PATH, []);
const byId = new Map(venues.map((v) => [v.id, v]));

// Every path a listing can point at, so "unreferenced" means unreachable rather
// than just missing from the one field this script knows about.
const referenced = new Set();
for (const venue of venues) {
  for (const match of JSON.stringify(venue).matchAll(/\/images\/venues\/([^"'\\\s)]+)/g)) {
    referenced.add(match[1]);
  }
}

const tracked = execSync(`git ls-files ${IMAGE_DIR}`, { encoding: 'utf8' })
  .split('\n').filter(Boolean).map((p) => path.basename(p));
const orphans = tracked.filter((file) => !referenced.has(file));

const relink = new Map();
const deletable = [];
const skipped = [];

for (const file of orphans) {
  const match = FLYER_RE.exec(file);
  if (!match) {
    // Not a flyer, so there is nothing to reattach it to. It is still safe to
    // remove if the listing it was named for is gone — the chain purge left
    // photographs behind the same way.
    const owner = Number((/^(\d+)-/.exec(file) || [])[1]);
    if (owner && !byId.has(owner)) deletable.push([file, `venue ${owner} no longer in the catalog`]);
    else skipped.push([file, 'not a menu flyer and its listing still exists']);
    continue;
  }

  const venue = byId.get(Number(match[1]));
  if (!venue) { deletable.push([file, 'venue no longer in the catalog']); continue; }
  // The id alone could be stale after a renumber; the slug has to agree too.
  if (match[2] !== slugify(venue.name)) { skipped.push([file, `slug disagrees with ${venue.name}`]); continue; }
  if (!venue.hhMenu?.sections?.length) { skipped.push([file, 'venue has no menu to be provenance for']); continue; }

  if (!relink.has(venue.id)) relink.set(venue.id, []);
  relink.get(venue.id).push(file);
}

console.log(`tracked venue images: ${tracked.length}`);
console.log(`unreferenced:         ${orphans.length}`);
console.log(`  reattachable as menu candidates: ${[...relink.values()].flat().length} file(s) across ${relink.size} listing(s)`);
console.log(`  deletable (venue is gone):       ${deletable.length}`);
console.log(`  left alone (cannot attribute):   ${skipped.length}`);
for (const [file, why] of skipped) console.log(`      ${file}: ${why}`);
for (const [file, why] of deletable) console.log(`      delete ${file}: ${why}`);

if (!apply) {
  console.log('\nReport only — pass --apply to write.');
  process.exit(0);
}

let attached = 0;
for (const [id, files] of relink) {
  const venue = byId.get(id);
  const existing = venue.menuCandidateImages || [];
  const known = new Set(existing.map((image) => image.url));
  const additions = files
    .map((file) => `/images/venues/${file}`)
    .filter((url) => !known.has(url))
    .map((url) => ({
      url,
      caption: 'Unconfirmed happy hour menu candidate',
      sourceUrl: venue.hhMenu?.sourceUrl || venue.website || null,
    }));
  if (!additions.length) continue;
  venue.menuCandidateImages = [...existing, ...additions];
  attached += additions.length;
}

for (const [file] of deletable) {
  fs.rmSync(path.join(IMAGE_DIR, file), { force: true });
}

writeJson(HAPPY_HOURS_PATH, venues);
console.log(`\nReattached ${attached} image(s) to ${relink.size} listing(s); deleted ${deletable.length}.`);
