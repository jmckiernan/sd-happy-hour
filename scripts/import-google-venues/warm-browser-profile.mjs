#!/usr/bin/env node
/**
 * Warm browser cookies for headless scraping.
 *
 * Usage:
 *   npm run browser:warm -- --auto
 *   npm run browser:warm
 */

import readline from 'node:readline';
import { chromium } from 'playwright';
import {
  BROWSER_PROFILE_DIR,
  BROWSER_STATE_PATH,
} from './lib/playwright-browser.mjs';
import { isCloudflareChallenge } from './lib/website-crawl.mjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const auto = args.includes('--auto');
const startUrl = args.find((a) => !a.startsWith('--')) || 'https://sushiloungesd.com/specials--happy-hour';

console.log(`Profile: ${BROWSER_PROFILE_DIR}`);
console.log(`State file: ${BROWSER_STATE_PATH}`);
console.log(`URL: ${startUrl}`);

const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
  headless: false,
  channel: 'chrome',
  args: ['--disable-blink-features=AutomationControlled'],
  viewport: { width: 1366, height: 900 },
  locale: 'en-US',
  timezoneId: 'America/Los_Angeles',
});

const page = context.pages()[0] || (await context.newPage());
await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

try {
  await page.getByRole('button', { name: /accept all cookies/i }).click({ timeout: 5000 });
} catch {
  // no cookie banner
}

if (auto) {
  try {
    await page.waitForFunction(
      () => {
        const title = document.title.toLowerCase();
        const body = (document.body?.innerText || '').toLowerCase();
        if (title.includes('just a moment')) return false;
        if (body.includes('performing security verification')) return false;
        return body.includes('happy hour');
      },
      { timeout: 90_000 }
    );
    console.log('Happy hour content detected.');
  } catch {
    console.warn('Timed out waiting for content.');
  }
} else {
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Press Enter after the happy hour page has fully loaded… ', () => {
      rl.close();
      resolve();
    });
  });
}

const html = await page.content();
const ok = !isCloudflareChallenge(html) && /happy hour/i.test(html);

fs.mkdirSync(BROWSER_STATE_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
await context.storageState({ path: BROWSER_STATE_PATH });
await context.close();

if (ok) {
  console.log('Saved browser state for headless runs.');
} else {
  console.log('Page may still be blocked — re-run and complete Cloudflare manually.');
}
process.exit(ok ? 0 : 1);
