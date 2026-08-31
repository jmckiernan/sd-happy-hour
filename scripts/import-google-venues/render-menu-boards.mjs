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
import { persistMenuBoard } from './lib/menu-flyers.mjs';
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

/** True when normalizing dropped a section or an item the listing had stored. */
function losesContent(before, after) {
  const count = (menu) => (menu?.sections || []).reduce((n, section) => n + (section.items?.length || 0), 0);
  return (after.sections?.length || 0) < (before.sections?.length || 0) || count(after) < count(before);
}

function selectVenues(venues, options) {
  // Any listing with a transcribed menu gets our board. The board is the
  // zoomable copy of the same text the page renders as HTML, so a venue with
  // menu content and no board has lost a feature rather than gained tidiness.
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
  const trimmed = [];

  try {
    for (const venue of todo) {
      try {
        // Re-normalizing lets copy rules added since the scrape (prefix
        // stripping, item caps) reach boards without paying for a crawl. The
        // board is drawn from the normalized copy, but the listing only keeps
        // it when nothing was lost: normalization caps a board at four
        // sections and 24 items per section for layout, which is a statement
        // about what fits on an image and not about what the venue sells.
        // Persisting the trimmed version deleted five of Amigo Cantina's
        // transcribed items, including a whole tequila flight section.
        const normalized = normalizeMenuBoard(venue.hhMenu);
        const menu = normalized || venue.hhMenu;
        if (normalized && !losesContent(venue.hhMenu, normalized)) venue.hhMenu = normalized;
        else if (normalized) {
          // Pagination means length is no longer a reason to drop anything, so
          // this is now only reachable when normalization rejected content on
          // its merits — site chrome, a nameless item. Worth seeing.
          trimmed.push(venue.name);
        }
        const pages = await renderer.renderPages(menu, venue);
        if (!pages.length) {
          failed += 1;
          console.warn(`  ! ${venue.name}: renderer returned no image`);
          continue;
        }
        if (options.apply) {
          venue.galleryImages = await persistMenuBoard(venue, pages);
        }
        rendered += 1;
        const items = venue.hhMenu.sections.reduce((n, section) => n + section.items.length, 0);
        const pageNote = pages.length > 1 ? `, ${pages.length} pages` : '';
        console.log(`  → ${venue.name}: ${venue.hhMenu.sections.length} section(s), ${items} item(s)${pageNote}`);
      } catch (error) {
        failed += 1;
        console.warn(`  ! ${venue.name}: ${error.message}`);
      }
    }
  } finally {
    await renderer.close();
  }

  if (trimmed.length) {
    console.log(`\nNormalization still dropped content for ${trimmed.length} listing(s): ${trimmed.join(', ')}`);
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
