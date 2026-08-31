// Checks that reach the live internet.
//
// Split out of tests/venue-audit.test.mjs so that suite can run offline and
// guard CI. A crawl against someone else's website fails for reasons that have
// nothing to do with our code — their sitemap moves, their WAF blocks us, the
// build host has no outbound access — and one such failure used to take the
// whole venue catalog suite down with it.
//
// Usage:
//   npm run test:venue-crawl:live

import assert from 'node:assert/strict';
import { discoverFromSitemap } from '../scripts/import-google-venues/lib/sitemap-discover.mjs';

/** A real venue sitemap that lists a happy-hour page. */
async function testDiscoverFromSitemapLive() {
  const { candidates, sitemapFound } = await discoverFromSitemap('https://lapuertasd.com/');
  assert.equal(sitemapFound, true);
  assert.ok(candidates.some((c) => /happy-hours/i.test(c.url)));
}

const tests = [testDiscoverFromSitemapLive];

let failed = 0;
for (const test of tests) {
  try {
    await test();
    console.log(`✓ ${test.name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${test.name}: ${error.message}`);
  }
}

if (failed) process.exit(1);
console.log(`All ${tests.length} live crawl tests passed.`);
