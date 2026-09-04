#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { HAPPY_HOURS_PATH, ROOT_DIR } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import {
  aiVenueImageFilename,
  brandKey,
  findChainReference,
  generateAiVenueImage,
} from './lib/ai-venue-images.mjs';
import { relativeVenueImagePath } from './lib/venue-images.mjs';

const IMAGE_DIR = path.join(ROOT_DIR, 'public', 'images', 'venues');
const RUN_PATH = path.join(ROOT_DIR, '.data', 'import', 'ai-venue-images.json');

function parseOptions(argv) {
  const options = {
    apply: false,
    force: false,
    regenerateAi: false,
    includeUnlisted: false,
    limit: 0,
    ids: new Set(),
    delayMs: 1500,
  };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--regenerate-ai') options.regenerateAi = true;
    else if (arg === '--include-unlisted') options.includeUnlisted = true;
    else if (arg.startsWith('--limit=')) options.limit = Math.max(0, Number(arg.slice(8)) || 0);
    else if (arg.startsWith('--ids=')) {
      for (const id of arg.slice(6).split(',')) if (Number(id)) options.ids.add(Number(id));
    } else if (arg.startsWith('--delay-ms=')) options.delayMs = Math.max(0, Number(arg.slice(11)) || 0);
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return `Generate temporary AI placeholder hero images for venues without a featured photo,
or regenerate existing AI placeholders with updated food/drink-focused prompts.

Usage:
  npm run images:ai -- [--apply] [--limit=10] [--ids=611,612] [--force]
  npm run images:ai -- --regenerate-ai [--apply] [--include-unlisted]

Default: preview targets only. With --apply, writes JPEGs to public/images/venues/
and attaches imageSource.provider=ai_generated until an owner replaces it.

Options:
  --apply              write images and update happy-hours.json
  --force              regenerate even if a prior AI placeholder exists
  --regenerate-ai      replace existing ai_generated hero images
  --include-unlisted   include unlisted venues without images (new placeholders only)
  --limit=N            process at most N venues
  --ids=1,2,3          process only these venue ids
  --delay-ms=1500      pause between Gemini calls`;
}

function isPublished(venue) {
  return venue.listingStatus !== 'unlisted' && venue.startTime && venue.endTime && venue.days?.length;
}

function isAiGenerated(venue) {
  return venue.imageSource?.provider === 'ai_generated';
}

function venueMatchesMode(venue, options) {
  if (options.regenerateAi) {
    if (isAiGenerated(venue)) return true;
    if (!venue.image) return options.includeUnlisted || isPublished(venue);
    return false;
  }
  if (!venue.image) return options.includeUnlisted || isPublished(venue);
  return options.force && isAiGenerated(venue);
}

function selectTargets(venues, options, priorRun) {
  let targets;
  if (options.ids.size) {
    targets = venues.filter((venue) => options.ids.has(Number(venue.id)));
    targets = targets.filter((venue) => venueMatchesMode(venue, options));
  } else if (options.regenerateAi) {
    targets = venues.filter((venue) => isAiGenerated(venue));
    if (!options.includeUnlisted) targets = targets.filter(isPublished);
  } else {
    targets = venues.filter((venue) => !venue.image);
    if (!options.includeUnlisted) targets = targets.filter(isPublished);
  }
  if (!options.force && !options.regenerateAi) {
    targets = targets.filter((venue) => priorRun.venues?.[venue.id]?.outcome !== 'attached');
  }
  if (options.limit) targets = targets.slice(0, options.limit);
  return targets;
}

function pageUrlFor(venue) {
  if (venue.website && /^https?:\/\//i.test(venue.website)) return venue.website;
  return `https://happyhoursd.com/venue/${venue.id}`;
}

async function normalizeToJpeg(bytes) {
  return sharp(bytes)
    .resize({ width: 1600, height: 900, fit: 'cover', withoutEnlargement: true })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const venues = readJson(HAPPY_HOURS_PATH, []);
  const prior = readJson(RUN_PATH, { version: 1, venues: {} });
  const targets = selectTargets(venues, options, prior);

  const mode = options.regenerateAi ? 'regenerating' : 'generating';
  console.log(`${options.apply ? mode[0].toUpperCase() + mode.slice(1) : 'Previewing'} AI placeholders for ${targets.length} venue(s).`);
  if (options.apply && !process.env.GEMINI_API_KEY?.trim()) {
    throw new Error('GEMINI_API_KEY is required for --apply.');
  }

  await fs.mkdir(IMAGE_DIR, { recursive: true });
  let attached = 0;

  for (const venue of targets) {
    const reference = findChainReference(venue, venues);
    const label = `${String(venue.id).padStart(4)} ${venue.name}`;
    if (!options.apply) {
      console.log(`  ${label}  brand=${brandKey(venue.name) || '(none)'}  ref=${reference ? `#${reference.id}` : 'none'}`);
      prior.venues[venue.id] = {
        venueId: venue.id,
        name: venue.name,
        outcome: 'preview',
        brand: brandKey(venue.name),
        referenceVenueId: reference?.id || null,
        mode: options.regenerateAi ? 'regenerate' : 'new',
      };
      continue;
    }

    try {
      const generated = await generateAiVenueImage(venue, { reference, rootDir: ROOT_DIR });
      const jpeg = await normalizeToJpeg(generated.bytes);
      const filename = aiVenueImageFilename(venue);
      await fs.writeFile(path.join(IMAGE_DIR, filename), jpeg);
      venue.image = relativeVenueImagePath(filename);
      venue.imageSource = {
        provider: 'ai_generated',
        pageUrl: pageUrlFor(venue),
        retrievedAt: new Date().toISOString(),
        review: 'ai_placeholder',
        rightsBasis: 'ai_synthetic_placeholder',
        sha256: generated.sha256,
        ...(reference ? { referenceVenueId: reference.id, referenceImage: reference.image } : {}),
      };
      prior.venues[venue.id] = {
        venueId: venue.id,
        name: venue.name,
        outcome: 'attached',
        brand: brandKey(venue.name),
        referenceVenueId: reference?.id || null,
        image: venue.image,
        mode: options.regenerateAi ? 'regenerate' : 'new',
      };
      attached += 1;
      console.log(`  ok   ${label}${reference ? ` (style ref #${reference.id})` : ''}`);
      prior.updatedAt = new Date().toISOString();
      writeJson(RUN_PATH, prior);
      writeJson(HAPPY_HOURS_PATH, venues);
    } catch (error) {
      prior.venues[venue.id] = {
        venueId: venue.id,
        name: venue.name,
        outcome: 'error',
        reason: error.message,
        mode: options.regenerateAi ? 'regenerate' : 'new',
      };
      console.error(`  FAIL ${label}  ${error.message}`);
    }

    await sleep(options.delayMs);
  }

  prior.updatedAt = new Date().toISOString();
  writeJson(RUN_PATH, prior);
  console.log(`\nAttached: ${attached}. Manifest: ${path.relative(ROOT_DIR, RUN_PATH)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
