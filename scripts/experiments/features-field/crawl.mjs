/**
 * EXPLORATORY — not part of the import pipeline. See docs/features-field-experiment.md.
 *
 * Crawls each sampled venue's website with the importer's own deep inventory
 * (6 pages / 8 fetches) and freezes the page text to disk, so the extraction
 * passes can be re-run and audited without re-fetching anything.
 */
import fs from 'node:fs';
import path from 'node:path';

import { inventoryWebsite } from '../../import-google-venues/lib/website-crawl.mjs';
import { createCachedFetch, mapPool } from '../../import-google-venues/lib/fetch-page.mjs';
import { hasBrowserState, createBrowserFetch } from '../../import-google-venues/lib/playwright-browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const DIR = path.join(ROOT, '.data', 'experiments', 'features-field');
const PAGES_DIR = path.join(DIR, 'pages');

const MAX_STORED_CHARS = 24_000;

async function main() {
  const { venues } = JSON.parse(fs.readFileSync(path.join(DIR, 'sample.json'), 'utf8'));
  fs.mkdirSync(PAGES_DIR, { recursive: true });

  const browserSession = hasBrowserState() ? await createBrowserFetch({}) : null;
  const fetchImpl = createCachedFetch({ browserFetch: browserSession?.fetch || null, browserConcurrency: 3 });

  const summary = [];
  await mapPool(venues, 4, async (venue) => {
    const file = path.join(PAGES_DIR, `${venue.id}.json`);
    if (fs.existsSync(file)) {
      const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
      summary.push({ id: venue.id, name: venue.name, pages: prior.pages.length, blocked: prior.blocked, cached: true });
      return;
    }

    let inventory;
    try {
      inventory = await inventoryWebsite(venue.website, {
        delayMs: 150,
        maxPages: 6,
        maxFetches: 8,
        fetchImpl,
        fetchSocial: true,
        venueContext: venue,
      });
    } catch (error) {
      inventory = { candidates: [], social: [], blocked: true, error: error.message };
    }

    const pages = (inventory.candidates || [])
      .filter((page) => page.kind === 'html' && page.text)
      .map((page) => ({ url: page.url, score: page.score, text: page.text.slice(0, MAX_STORED_CHARS) }));
    const media = (inventory.candidates || [])
      .filter((page) => page.kind !== 'html')
      .map((page) => ({ url: page.url, kind: page.kind, score: page.score }));
    const social = (inventory.social || [])
      .filter((row) => row.text)
      .map((row) => ({ network: row.network, url: row.url, text: String(row.text).slice(0, 4_000) }));

    fs.writeFileSync(file, `${JSON.stringify({ venue, pages, media, social, blocked: Boolean(inventory.blocked), error: inventory.error || null }, null, 2)}\n`);
    summary.push({ id: venue.id, name: venue.name, pages: pages.length, media: media.length, social: social.length, blocked: Boolean(inventory.blocked) });
    console.log(`  ${String(venue.id).padStart(5)} ${venue.name.slice(0, 32).padEnd(32)} ${pages.length} page(s), ${media.length} media, ${social.length} social${inventory.blocked ? ', BLOCKED' : ''}`);
  });

  await browserSession?.close?.();

  const withPages = summary.filter((row) => row.pages > 0).length;
  console.log(`\n${withPages}/${summary.length} venues yielded at least one readable page.`);
  fs.writeFileSync(path.join(DIR, 'crawl-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

main();
