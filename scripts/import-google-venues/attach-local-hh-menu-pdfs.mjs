#!/usr/bin/env node
// Attach a full happy-hour menu (hhMenu + provenance flyer + generated board)
// from a local HH PDF already on disk — same end state as refresh-happy-hour
// when the crawl finds and transcribes a flyer, without re-crawling.
//
// Usage:
//   node --env-file-if-exists=.env --env-file-if-exists=.env.local \
//     scripts/import-google-venues/attach-local-hh-menu-pdfs.mjs
//   … --apply
//   … --apply --venue=643,650,2983

import fs from 'node:fs/promises';
import path from 'node:path';
import { HAPPY_HOURS_PATH, ROOT_DIR } from './lib/constants.mjs';
import { hasAiExtraction, normalizeMenuBoard, transcribeMenuBoardWithAi } from './lib/ai-extract.mjs';
import { createMenuBoardRenderer } from './lib/menu-board-image.mjs';
import { persistMenuBoard, persistMenuFlyers } from './lib/menu-flyers.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';

/**
 * Karina's locations with published HH flyer PDFs (cached under .data/tmp).
 * Barrio Logan / Mission Hills have no HH flyer — deliberately omitted.
 */
const ATTACHMENTS = [
  {
    id: 643,
    pdfRel: '.data/tmp/karinas/WebMenuHHOtayAndBonita.pdf',
    sourceUrl: 'https://karinasseafood.com/wp-content/uploads/2025/10/WebMenuHHOtayAndBonita.pdf',
  },
  {
    id: 650,
    pdfRel: '.data/tmp/karinas/WebMenuHHOtayAndBonita.pdf',
    sourceUrl: 'https://karinasseafood.com/wp-content/uploads/2025/10/WebMenuHHOtayAndBonita.pdf',
  },
  {
    id: 2983,
    pdfRel: '.data/tmp/karinas/WebMenuHHCantinaGaslamp.pdf',
    sourceUrl: 'https://karinasseafood.com/wp-content/uploads/2025/10/WebMenuHHCantinaGaslamp.pdf',
  },
];

/** Hand transcription of the HH flyer when AI is unavailable — matches printed lines. */
const FALLBACK_BOARD = {
  note: 'Happy hour in the bar only. All day Monday; 3–6 PM Tuesday–Sunday.',
  sections: [
    {
      title: 'Drinks',
      items: [
        { name: 'House Margarita', price: '$8', category: 'cocktail' },
        { name: "Karina's Signature Skinny Margarita", price: '$8', category: 'cocktail' },
        { name: 'Cucumber Martini', price: '$8', category: 'cocktail' },
        { name: 'Tamarindo Martini', price: '$8', category: 'cocktail' },
        { name: 'Well Drinks', price: '$8', category: 'cocktail' },
      ],
    },
    {
      title: 'Wine',
      items: [
        { name: 'House White Wine', price: '$8', category: 'wine' },
        { name: 'House Red Wine', price: '$8', category: 'wine' },
      ],
    },
    {
      title: 'Draft Beer',
      items: [
        { name: "Karina's Lager", price: '$5', category: 'beer' },
        { name: 'Coors Light', price: '$5', category: 'beer' },
        { name: 'Pacifico', price: '$5', category: 'beer' },
      ],
    },
    {
      title: 'Appetizers',
      items: [
        { name: 'Mango Jalapeño Tuna Sashimi', price: '$10', category: 'food' },
        { name: 'Jumbo Shrimp Ceviche Martini', price: '$10', category: 'food' },
        { name: 'Seared Sesame Ahi Tuna', price: '$10', category: 'food' },
        { name: 'Camarones Enchilados', price: '$10', category: 'food' },
        { name: 'Rib Eye Steak Sliders (3)', price: '$10', category: 'food' },
        { name: 'Spicy Calamari Strips', price: '$10', category: 'food' },
        {
          name: 'Tres Taquitos with choice of (all 3 same): Camarones Enchilados, Marlin Enchilados, Rib-Eye Steak, or Carnitas',
          price: '$10',
          category: 'food',
        },
      ],
    },
  ],
};

function parseAttachArgs(argv) {
  const options = { ...parseArgs(argv), apply: false, venue: null };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--venue=')) options.venue = arg.slice(8);
  }
  return options;
}

const boardCache = new Map();

async function boardFromPdf(pdfPath, sourceUrl, venue) {
  const cacheKey = pdfPath;
  if (boardCache.has(cacheKey)) return boardCache.get(cacheKey);

  const bytes = await fs.readFile(pdfPath);
  let result;
  if (hasAiExtraction()) {
    const inventory = {
      candidates: [{
        url: sourceUrl,
        kind: 'pdf',
        bytes,
        score: 100,
        ok: true,
      }],
      social: [],
    };
    const board = await transcribeMenuBoardWithAi(inventory, {
      id: venue.id,
      name: venue.name,
      neighborhood: venue.neighborhood,
      website: venue.website,
    });
    if (board?.sections?.length) result = { board, via: 'ai' };
  }
  if (!result) {
    const normalized = normalizeMenuBoard(FALLBACK_BOARD);
    if (!normalized) throw new Error('fallback board failed normalization');
    result = { board: normalized, via: 'fallback' };
  }
  boardCache.set(cacheKey, result);
  return result;
}

async function main() {
  const options = parseAttachArgs(process.argv.slice(2));
  const venues = readJson(HAPPY_HOURS_PATH, []);
  const byId = new Map(venues.map((venue) => [venue.id, venue]));

  let todo = ATTACHMENTS;
  if (options.venue) {
    const keys = new Set(String(options.venue).split(',').map((part) => part.trim()));
    todo = todo.filter((row) => keys.has(String(row.id)));
  }

  console.log(`Attaching HH menus for ${todo.length} venue(s). AI=${hasAiExtraction()}`);
  const renderer = createMenuBoardRenderer();
  let written = 0;

  try {
    for (const row of todo) {
      const venue = byId.get(row.id);
      if (!venue) {
        console.warn(`  ! id ${row.id} missing from catalog`);
        continue;
      }
      const pdfPath = path.join(ROOT_DIR, row.pdfRel);
      try {
        await fs.access(pdfPath);
      } catch {
        console.warn(`  ! ${venue.name}: missing PDF ${row.pdfRel}`);
        continue;
      }

      const { board, via } = await boardFromPdf(pdfPath, row.sourceUrl, venue);
      const observedAt = new Date().toISOString().slice(0, 10);
      const menu = {
        ...board,
        sourceUrl: row.sourceUrl,
        observedAt,
      };
      const pages = await renderer.renderPages(menu, venue);
      if (!pages.length) {
        console.warn(`  ! ${venue.name}: board renderer returned no image`);
        continue;
      }

      const items = menu.sections.reduce((n, section) => n + section.items.length, 0);
      console.log(
        `  ${options.apply ? '+' : '?'} ${venue.name} (${venue.id}): `
        + `${menu.sections.length} section(s), ${items} item(s), `
        + `${pages.length} board page(s), via=${via}`
      );

      if (!options.apply) continue;

      const bytes = await fs.readFile(pdfPath);
      const saved = await persistMenuFlyers(venue, [{
        url: row.sourceUrl,
        kind: 'pdf',
        bytes,
      }]);
      // Caption provenance like refresh-happy-hour after a successful transcription.
      const sourceImages = saved.map((image) => ({
        ...image,
        caption: 'Happy hour menu flyer published by the venue',
      }));
      venue.hhMenu = {
        ...menu,
        ...(sourceImages.length ? { sourceImages } : {}),
      };
      venue.galleryImages = await persistMenuBoard(venue, pages);
      written += 1;
    }
  } finally {
    await renderer.close();
  }

  if (!options.apply) {
    console.log('\nDry run — pass --apply to write catalog + images.');
    return;
  }

  writeJson(HAPPY_HOURS_PATH, venues);
  console.log(`\nAttached menus for ${written} listing(s). Wrote ${HAPPY_HOURS_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
