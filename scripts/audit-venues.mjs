#!/usr/bin/env node
/**
 * Audit venue happy hour data for accuracy and completeness.
 *
 * Phase 1 (default): static quality flags — no network, fast.
 * Phase 2 (--verify): re-scrape authority websites and compare to stored data.
 *
 * Usage:
 *   npm run audit:venues
 *   npm run audit:venues -- --verify --limit=25
 *   npm run audit:venues -- --venue=sushi-lounge-encinitas --verify
 *   npm run audit:venues -- --verify --browser   # Playwright for Cloudflare sites
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAPPY_HOURS_PATH } from './import-google-venues/lib/constants.mjs';
import { extractWebsiteHappyHourDeep, discoverWebsiteLocations, hasAiExtraction, inventoryWebsite } from './import-google-venues/lib/happy-hour.mjs';
import {
  flagVenue,
  compareVenueToScrape,
  detectMultiLocationGaps,
  getRegistrableDomain,
  summarizeAuditResults,
  groupVenuesByDomain,
} from './import-google-venues/lib/venue-quality.mjs';
import { readJson, writeJson, sleep } from './import-google-venues/lib/io.mjs';
import { isCloudflareChallenge } from './import-google-venues/lib/website-crawl.mjs';
import { createBrowserFetch, hasBrowserState } from './import-google-venues/lib/playwright-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const AUDIT_DIR = path.join(ROOT_DIR, '.data', 'audit');
const REPORT_PATH = path.join(AUDIT_DIR, 'venues-report.json');

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function isCloudflareBlocked(raw = '') {
  return isCloudflareChallenge(String(raw)) || /just a moment/i.test(String(raw));
}

function parseAuditArgs(argv) {
  const options = {
    verify: false,
    browser: false,
    limit: 0,
    venue: null,
    minSeverity: null,
    output: REPORT_PATH,
    useAi: true,
  };

  for (const arg of argv) {
    if (arg === '--verify') options.verify = true;
    else if (arg === '--browser') options.browser = true;
    else if (arg === '--no-ai') options.useAi = false;
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--venue=')) options.venue = arg.slice(8);
    else if (arg.startsWith('--min-severity=')) options.minSeverity = arg.slice(15);
    else if (arg.startsWith('--output=')) options.output = arg.slice(9);
  }

  return options;
}

function selectVenuesForVerification(venues, options) {
  let selected = venues.filter((v) => v.website);

  if (options.venue) {
    selected = selected.filter(
      (v) => slugify(v.name) === options.venue || String(v.id) === options.venue
    );
  } else {
    selected = selected
      .map((v) => ({ venue: v, flags: flagVenue(v, venues) }))
      .filter(({ flags }) => flags.some((f) => f.severity === 'high' || f.severity === 'medium'))
      .sort((a, b) => b.flags.length - a.flags.length)
      .map(({ venue }) => venue);
  }

  if (options.limit) selected = selected.slice(0, options.limit);
  return selected;
}

async function main() {
  const options = parseAuditArgs(process.argv.slice(2));
  const venues = readJson(HAPPY_HOURS_PATH, []);
  const auditedAt = new Date().toISOString();

  console.log(`Auditing ${venues.length} venues...`);

  const results = venues.map((venue) => ({
    id: venue.id,
    name: venue.name,
    slug: slugify(venue.name),
    neighborhood: venue.neighborhood,
    website: venue.website,
    flags: flagVenue(venue, venues),
  }));

  let browserSession = null;
  let websiteLocationsByDomain = new Map();
  if (options.verify) {
    if (options.browser && !hasBrowserState()) {
      console.error('No browser state found. Run: npm run browser:warm -- --auto');
      process.exit(1);
    }
    if (options.browser) {
      browserSession = await createBrowserFetch({ headed: process.env.PLAYWRIGHT_HEADED === '1' });
      if (!browserSession?.fetch) {
        console.error('Could not launch Playwright browser. Try: npm run browser:warm -- --auto');
        process.exit(1);
      }
      console.log('Browser ready (using saved cookie state).');
    }
    if (options.useAi && hasAiExtraction()) {
      console.log('AI extraction enabled (Anthropic).');
    }

    const toVerify = selectVenuesForVerification(venues, options);
    console.log(`Re-scraping ${toVerify.length} venue website(s)...`);

    websiteLocationsByDomain = new Map();
    const inventoryByDomain = new Map();

    for (const venue of toVerify) {
      const result = results.find((r) => r.id === venue.id);
      try {
        const scrapeOptions = {
          delayMs: 200,
          maxPages: 6,
          maxFetches: 8,
          fetchImpl: browserSession?.fetch,
          useAi: options.useAi,
        };
        const domain = getRegistrableDomain(venue.website);
        if (domain && !inventoryByDomain.has(domain)) {
          inventoryByDomain.set(domain, await inventoryWebsite(venue.website, scrapeOptions));
        }
        const scraped = await extractWebsiteHappyHourDeep(venue.website, venue, {
          ...scrapeOptions,
          inventory: domain ? inventoryByDomain.get(domain) : undefined,
        });
        const diffs = compareVenueToScrape(venue, scraped);
        result.scraped = {
          found: scraped.found,
          outcome: scraped.outcome,
          reason: scraped.reason,
          startTime: scraped.startTime,
          endTime: scraped.endTime,
          days: scraped.days,
          deals: scraped.deals,
          sourcePage: scraped.sourcePage,
          confidence: scraped.confidence,
          candidateUrls: scraped.candidateUrls,
        };
        result.verifyDiffs = diffs;
        result.flags = [...result.flags, ...diffs];

        if (scraped.found && isCloudflareBlocked(scraped.raw)) {
          result.flags.push({
            severity: 'high',
            code: 'cloudflare_blocked',
            message: 'Website may be Cloudflare-protected; scrape result is unreliable.',
          });
        }

        // Location discovery doubles crawl time — skip during batch verification runs.
        if (domain && !websiteLocationsByDomain.has(domain) && !options.venue && !options.limit) {
          const locations = await discoverWebsiteLocations(venue.website, scrapeOptions);
          if (locations.length) websiteLocationsByDomain.set(domain, locations);
          await sleep(200);
        }

        if (!scraped.found) {
          console.log(`  ✗ ${venue.name}: ${scraped.outcome} — ${scraped.reason}`);
        } else if (diffs.some((d) => d.severity === 'high')) {
          console.log(
            `  ⚠ ${venue.name}: ${diffs.map((d) => d.message).join(' | ')}`
          );
        } else {
          console.log(`  ✓ ${venue.name}: matches or minor diffs`);
        }
      } catch (error) {
        result.verifyError = error.message;
        console.warn(`  ! ${venue.name}: ${error.message}`);
      }
    }

    if (browserSession) await browserSession.close();
  }

  const multiLocationGaps = options.verify
    ? detectMultiLocationGaps(venues, websiteLocationsByDomain)
    : detectMultiLocationGaps(venues);

  const filteredResults = options.minSeverity
    ? results.filter((r) => r.flags.some((f) => f.severity === options.minSeverity))
    : results.filter((r) => r.flags.length);

  const summary = summarizeAuditResults(results);
  const report = {
    auditedAt,
    options: { verify: options.verify, browser: options.browser, limit: options.limit || null },
    summary: {
      ...summary,
      multiLocationGaps: multiLocationGaps.length,
    },
    multiLocationGaps,
    domainClusters: summarizeDomainClusters(venues),
    venues: filteredResults.sort((a, b) => {
      const sev = (r) => r.flags.find((f) => f.severity === 'high') ? 0 : r.flags.find((f) => f.severity === 'medium') ? 1 : 2;
      return sev(a) - sev(b) || b.flags.length - a.flags.length;
    }),
  };

  writeJson(options.output, report);

  console.log('\n--- Audit summary ---');
  console.log(`Venues with issues: ${summary.venuesWithIssues} / ${summary.venuesAudited}`);
  console.log(`High: ${summary.bySeverity.high || 0}, Medium: ${summary.bySeverity.medium || 0}, Low: ${summary.bySeverity.low || 0}`);
  if (multiLocationGaps.length) {
    console.log(`Multi-location gaps: ${multiLocationGaps.length} domain(s) with missing locations`);
    for (const gap of multiLocationGaps.slice(0, 5)) {
      console.log(`  ${gap.domain}: ${gap.inDatabase} in DB, ${gap.listedOnSite} on website`);
    }
  }
  console.log(`Report written to ${options.output}`);
}

function summarizeDomainClusters(venues) {
  const groups = groupVenuesByDomain(venues);
  return [...groups.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([domain, domainVenues]) => ({
      domain,
      count: domainVenues.length,
      venues: domainVenues.map((v) => ({ id: v.id, name: v.name, neighborhood: v.neighborhood })),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
