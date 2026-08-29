#!/usr/bin/env node
// Re-render the happy-hour menu boards we typeset ourselves, from the
// structured `hhMenu` already stored on each listing.
//
// No crawling and no AI: this is the script to run after changing the board
// design in lib/menu-board-image.mjs. Listings whose gallery holds a real
// flyer scraped from the venue are left alone.
//
// Usage:
//   npm run menus:render                          # dry run, reports what would change
//   npm run menus:render -- --apply
//   npm run menus:render -- --apply --venue=kingfisher,385

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { normalizeMenuBoard } from './lib/ai-extract.mjs';
import { createMenuBoardRenderer } from './lib/menu-board-image.mjs';
import { persistMenuFlyers } from './lib/menu-flyers.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function parseRenderArgs(argv) {
  const options = { ...parseArgs(argv), apply: false, venue: null };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--venue=')) options.venue = arg.slice(8);
  }
  return options;
}

function selectVenues(venues, options) {
  // Any listing with a transcribed menu gets our board, including ones whose
  // gallery still holds the flyer it was transcribed from — the board replaces
  // it so every venue page looks the same.
  let todo = venues.filter((venue) => venue.hhMenu?.sections?.length);
  if (options.venue) {
    const keys = String(options.venue).split(',').map((part) => part.trim()).filter(Boolean);
    todo = todo.filter((venue) => keys.some((key) => slugify(venue.name) === key || String(venue.id) === key));
  }
  return options.limit ? todo.slice(0, options.limit) : todo;
}

async function main() {
  const options = parseRenderArgs(process.argv.slice(2));
  const venues = readJson(HAPPY_HOURS_PATH, []);
  const todo = selectVenues(venues, options);

  console.log(`Rendering ${todo.length} menu board(s).`);
  const renderer = createMenuBoardRenderer();
  let rendered = 0;
  let failed = 0;

  try {
    for (const venue of todo) {
      try {
        // Re-normalizing lets copy rules added since the scrape (prefix
        // stripping, item caps) reach boards without paying for a crawl.
        venue.hhMenu = normalizeMenuBoard(venue.hhMenu) || venue.hhMenu;
        const image = await renderer.render(venue.hhMenu, venue);
        if (!image?.bytes?.length) {
          failed += 1;
          console.warn(`  ! ${venue.name}: renderer returned no image`);
          continue;
        }
        if (options.apply) {
          const saved = await persistMenuFlyers(venue, [image]);
          if (saved.length) venue.galleryImages = saved;
        }
        rendered += 1;
        const items = venue.hhMenu.sections.reduce((n, section) => n + section.items.length, 0);
        console.log(`  → ${venue.name}: ${venue.hhMenu.sections.length} section(s), ${items} item(s)`);
      } catch (error) {
        failed += 1;
        console.warn(`  ! ${venue.name}: ${error.message}`);
      }
    }
  } finally {
    await renderer.close();
  }

  if (options.apply) {
    writeJson(HAPPY_HOURS_PATH, venues);
    console.log(`\nRendered ${rendered}, failed ${failed}. Wrote ${HAPPY_HOURS_PATH}`);
  } else {
    console.log(`\nRendered ${rendered}, failed ${failed}. Dry run — pass --apply to write images.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
