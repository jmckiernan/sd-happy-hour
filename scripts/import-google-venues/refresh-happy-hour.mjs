#!/usr/bin/env node
// Re-scrape venue websites for happy hour times, days, and deals.
//
// Per venue:
//   1. Google Places HAPPY_HOUR (already on the listing) is authoritative for times
//   2. Inventory the website once per domain (sitemap → home/menu/specials + other candidates)
//   3. One Haiku call with all candidate text (+ vision for media)
//   4. Record found/not-found + reason + source URL + evidence quotes
//
// Usage:
//   npm run import:venues:refresh-happy-hour
//   npm run import:venues:refresh-happy-hour -- --apply
//   npm run import:venues:refresh-happy-hour -- --concurrency=10 --apply
//   npm run import:venues:refresh-happy-hour -- --retry-failed --apply
//   npm run import:venues:refresh-happy-hour -- --venue=sushi-lounge-encinitas --apply

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { extractFromInventory, hasAiExtraction, inventoryWebsite } from './lib/happy-hour.mjs';
import { compressDealsWithAi } from './lib/ai-extract.mjs';
import { venueDealsNeedRewrite } from './lib/deals.mjs';
import { persistMenuFlyers } from './lib/menu-flyers.mjs';
import { renderMenuBoardJpeg, menuBoardFromDealLines } from './lib/html-menu-flyer.mjs';
import { flagVenue, getRegistrableDomain } from './lib/venue-quality.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';
import { createBrowserFetch, hasBrowserState } from './lib/playwright-browser.mjs';
import { createCachedFetch, mapPool } from './lib/fetch-page.mjs';
import { SCRAPE_OUTCOMES } from './lib/scrape-outcome.mjs';
import { applyScrape } from './lib/apply-scrape.mjs';
import { isAnthropicBillingError } from './lib/anthropic-errors.mjs';
import { alertOperator } from './lib/operator-alert.mjs';

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function parseRefreshArgs(argv) {
  const options = {
    ...parseArgs(argv),
    apply: false,
    browser: 'auto',
    venue: null,
    useAi: true,
    highOnly: false,
    retryFailed: false,
    concurrency: 10,
    refreshCache: false,
  };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--browser') options.browser = true;
    else if (arg === '--no-browser') options.browser = false;
    else if (arg === '--no-ai') options.useAi = false;
    else if (arg === '--high-only') options.highOnly = true;
    else if (arg === '--retry-failed') options.retryFailed = true;
    else if (arg === '--refresh-cache') options.refreshCache = true;
    else if (arg.startsWith('--venue=')) options.venue = arg.slice(8);
    else if (arg.startsWith('--concurrency=')) options.concurrency = Number(arg.slice(14)) || 10;
  }
  return options;
}

function groupByDomain(venues) {
  const groups = new Map();
  for (const venue of venues) {
    const domain = getRegistrableDomain(venue.website) || `venue-${venue.id}`;
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(venue);
  }
  return [...groups.entries()];
}

async function main() {
  const options = parseRefreshArgs(process.argv.slice(2));
  const venues = readJson(HAPPY_HOURS_PATH, []);
  let todo = venues.filter((v) => v.website);

  if (options.venue) {
    todo = todo.filter((v) => {
      const keys = String(options.venue).split(',').map((part) => part.trim()).filter(Boolean);
      return keys.some((key) => slugify(v.name) === key || String(v.id) === key);
    });
  } else if (options.retryFailed) {
    todo = todo.filter((v) => v.lastScrape?.outcome === SCRAPE_OUTCOMES.extract_failed);
  } else if (options.highOnly) {
    todo = todo
      .map((v) => ({ venue: v, flags: flagVenue(v, venues) }))
      .filter(({ flags }) => flags.some((f) => f.severity === 'high'))
      .map(({ venue }) => venue);
  }

  if (options.limit) todo = todo.slice(0, options.limit);

  const wantBrowser = options.browser === 'auto' ? hasBrowserState() : options.browser;
  if (wantBrowser && !hasBrowserState()) {
    console.warn('No browser state found — continuing with HTTP only. Run: npm run browser:warm -- --auto');
  }

  const browserSession = wantBrowser && hasBrowserState()
    ? await createBrowserFetch({ headed: process.env.PLAYWRIGHT_HEADED === '1' })
    : null;

  const fetchImpl = createCachedFetch({
    browserFetch: browserSession?.fetch || null,
    refresh: options.refreshCache,
    browserConcurrency: 3,
  });

  const scrapeOptions = {
    delayMs: 150,
    maxPages: 6,
    maxFetches: 8,
    fetchImpl,
    useAi: options.useAi,
  };

  if (options.useAi && hasAiExtraction()) {
    console.log('Using AI extraction (Anthropic) for happy hour and specials.');
  } else if (options.useAi) {
    console.warn('ANTHROPIC_API_KEY not set — falling back to regex parsing.');
  }

  const domainGroups = groupByDomain(todo);
  console.log(
    `Refreshing ${todo.length} venue(s) across ${domainGroups.length} domain(s), concurrency=${options.concurrency}${browserSession ? ', browser fallback on' : ', HTTP only'}.`
  );

  const stats = {
    found: 0,
    updated: 0,
    unchanged: 0,
    lowConfidence: 0,
    byOutcome: {},
  };
  let processed = 0;
  const started = Date.now();
  let stopReason = null;

  function bumpOutcome(outcome) {
    const key = outcome || 'unknown';
    stats.byOutcome[key] = (stats.byOutcome[key] || 0) + 1;
  }

  function persist() {
    if (options.apply) writeJson(HAPPY_HOURS_PATH, venues);
  }

  await mapPool(domainGroups, options.concurrency, async ([domain, domainVenues]) => {
    if (stopReason) return;
    let inventory;
    try {
      inventory = await inventoryWebsite(domainVenues[0].website, scrapeOptions);
    } catch (error) {
      inventory = { origin: domain, candidates: [], social: [], blocked: false, sitemapFound: false };
      console.warn(`  ! ${domain}: inventory failed (${error.message})`);
    }

    for (const venue of domainVenues) {
      if (stopReason) return;
      try {
        const scraped = await extractFromInventory(inventory, venue, scrapeOptions);
        if (isAnthropicBillingError(scraped?.reason)) {
          stopReason = scraped.reason;
          return;
        }
        const apply = applyScrape(venue, scraped);
        if (scraped.found) {
          try {
            let flyers = [...(scraped.menuImages || [])];
            if (!flyers.length) {
              const board = scraped.menuBoard || menuBoardFromDealLines(scraped.deals, scraped.windows);
              if (board) {
                const rendered = renderMenuBoardJpeg(board, {
                  ...venue,
                  website: scraped.sourcePage || venue.website,
                });
                if (rendered?.bytes?.length) flyers = [rendered];
              }
            }
            if (flyers.length) {
              const saved = await persistMenuFlyers(venue, flyers);
              if (saved.length) {
                venue.galleryImages = saved;
                apply.changed = true;
                apply.changes = [...(apply.changes || []), `hh menu photo (${saved.length})`];
              }
            }
          } catch (error) {
            console.warn(`  ~ ${venue.name}: menu flyer save failed (${error.message})`);
          }
        }
        if (options.useAi && hasAiExtraction() && venueDealsNeedRewrite(venue.deals) && !(venue.weeklySpecials || []).length) {
          try {
            const [rewritten] = await compressDealsWithAi([{
              id: venue.id,
              name: venue.name,
              deals: venue.deals,
            }]);
            if (rewritten?.deals?.length) {
              venue.deals = rewritten.deals;
              venue.dealsUnknown = false;
              apply.changed = true;
              apply.changes = [...(apply.changes || []), 'compressed deal chips'];
            }
          } catch (error) {
            if (isAnthropicBillingError(error)) {
              stopReason = error.message;
              return;
            }
            console.warn(`  ~ ${venue.name}: deal compress failed (${error.message})`);
          }
        }
        processed += 1;
        bumpOutcome(scraped.outcome || apply.reason);

        if (!scraped.found) {
          console.log(`  ✗ ${venue.name} [${domain}]: ${scraped.outcome} — ${scraped.reason}`);
        } else if (apply.reason === 'low_confidence') {
          stats.lowConfidence += 1;
          console.log(`  ~ ${venue.name}: low confidence without evidence (${scraped.sourcePage || 'unknown page'})`);
        } else if (apply.changed) {
          stats.found += 1;
          stats.updated += 1;
          console.log(`  → ${venue.name}: ${apply.changes.join('; ')} (${scraped.confidence})`);
        } else {
          stats.found += 1;
          stats.unchanged += 1;
          console.log(`  = ${venue.name}: already current (${scraped.sourcePage || 'website'})`);
        }
      } catch (error) {
        if (isAnthropicBillingError(error)) {
          stopReason = error.message;
          return;
        }
        processed += 1;
        bumpOutcome(SCRAPE_OUTCOMES.extract_failed);
        console.warn(`  ! ${venue.name}: ${error.message}`);
      }

      if (processed % 25 === 0) {
        persist();
        const elapsed = ((Date.now() - started) / 1000).toFixed(0);
        console.log(`  … ${processed}/${todo.length} in ${elapsed}s (updated ${stats.updated})`);
      }
    }
  });

  if (browserSession) await browserSession.close();
  persist();

  if (stopReason) {
    const remaining = todo.length - processed;
    await alertOperator({
      title: 'Anthropic credits exhausted',
      body: `Happy-hour refresh stopped after ${processed} of ${todo.length} venues. Add credits, then rerun with --retry-failed. ${remaining} left.`,
      extra: {
        processed,
        total: todo.length,
        remaining,
        updated: stats.updated,
        reason: stopReason,
      },
    });
    process.exit(2);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n--- Refresh summary ---');
  console.log(`Venues: ${todo.length} in ${elapsed}s`);
  console.log(`Found: ${stats.found}  updated: ${stats.updated}  unchanged: ${stats.unchanged}`);
  console.log(`Low confidence skipped: ${stats.lowConfidence}`);
  console.log('Outcomes:');
  for (const [outcome, count] of Object.entries(stats.byOutcome).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${outcome}: ${count}`);
  }
  if (options.apply) console.log(`Wrote ${HAPPY_HOURS_PATH}`);
  else console.log('Dry run — pass --apply to write changes.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
