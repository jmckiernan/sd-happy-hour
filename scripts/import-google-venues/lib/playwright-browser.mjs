/**
 * Playwright fetch helper for Cloudflare-protected venue websites.
 *
 * Setup:
 *   npx playwright install chromium
 *   npm run browser:warm -- --auto     # headed; saves cookies to .data/browser-state.json
 *
 * Usage:
 *   npm run audit:venues -- --verify --browser
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCloudflareChallenge } from './website-crawl.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BROWSER_PROFILE_DIR = path.join(__dirname, '..', '..', '..', '.data', 'browser-profile');
export const BROWSER_STATE_PATH = path.join(__dirname, '..', '..', '..', '.data', 'browser-state.json');

const REAL_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function playwrightOptionsFromEnv() {
  return {
    headed: process.env.PLAYWRIGHT_HEADED === '1' || process.env.PLAYWRIGHT_HEADED === 'true',
    useChrome: process.env.PLAYWRIGHT_USE_CHROME !== '0',
    profileDir: process.env.PLAYWRIGHT_PROFILE_DIR || BROWSER_PROFILE_DIR,
    statePath: process.env.PLAYWRIGHT_STATE_PATH || BROWSER_STATE_PATH,
  };
}

async function clearProfileLock(profileDir) {
  const fsPromises = await import('node:fs/promises');
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      await fsPromises.unlink(`${profileDir}/${name}`);
    } catch {
      // ignore
    }
  }
}

async function launchContext(options = {}) {
  const { chromium } = await import('playwright');
  const config = { ...playwrightOptionsFromEnv(), ...options };
  const launchArgs = ['--disable-blink-features=AutomationControlled'];
  const contextDefaults = {
    userAgent: REAL_USER_AGENT,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  };

  // Headless: reuse cookies from warm run (no profile lock issues)
  if (!config.headed && fs.existsSync(config.statePath)) {
    const browser = await chromium.launch({
      headless: true,
      channel: config.useChrome ? 'chrome' : undefined,
      args: launchArgs,
    });
    const context = await browser.newContext({
      ...contextDefaults,
      storageState: config.statePath,
    });
    return { context, browser, persistent: false };
  }

  // Headed warm: persistent profile for manual Cloudflare pass
  try {
    const context = await chromium.launchPersistentContext(config.profileDir, {
      headless: false,
      channel: config.useChrome ? 'chrome' : undefined,
      args: launchArgs,
      ...contextDefaults,
    });
    return { context, persistent: true, isWarmSession: true };
  } catch (error) {
    if (!/ProcessSingleton|SingletonLock|profile.*in use/i.test(error.message)) throw error;
    console.warn('Browser profile locked — clearing stale lock and retrying…');
    await clearProfileLock(config.profileDir);
    const context = await chromium.launchPersistentContext(config.profileDir, {
      headless: false,
      channel: config.useChrome ? 'chrome' : undefined,
      args: launchArgs,
      ...contextDefaults,
    });
    return { context, persistent: true, isWarmSession: true };
  }
}

async function dismissInterstitials(page) {
  const labels = [
    /i.?m 21 or older/i,
    /yes.?i.?m 21/i,
    /i am 21/i,
    /accept all cookies/i,
  ];
  for (const name of labels) {
    try {
      await page.getByRole('button', { name }).click({ timeout: 1600 });
      await page.waitForTimeout(200);
    } catch {
      // not on this page
    }
  }
  try {
    await page.locator('button, a, [role="button"]').filter({ hasText: /21 or older/i }).first().click({ timeout: 1200 });
    await page.waitForTimeout(250);
  } catch {
    // already dismissed
  }
}

async function waitForRealContent(page, options = {}) {
  const { mode = 'content', timeoutMs = 6000, interact = true } = options;

  await dismissInterstitials(page);

  if (mode === 'discovery') {
    try {
      await page.waitForLoadState('networkidle', { timeout: 3000 });
    } catch {
      // partial load is fine for link discovery
    }
    await page.waitForTimeout(600);
    return [];
  }

  try {
    await page.waitForFunction(
      () => {
        const title = document.title.toLowerCase();
        const body = (document.body?.innerText || '').toLowerCase();
        if (title.includes('just a moment')) return false;
        if (body.includes('performing security verification')) return false;
        if (/happy\s*hour|golden\s*hour|daily specials?|drink specials?|taco\s+tues|\$\s?\d/.test(body)) return true;
        return body.replace(/\s+/g, ' ').length > 800;
      },
      { timeout: timeoutMs }
    );
  } catch {
    // timed out — use whatever rendered
  }

  if (!interact) {
    await page.waitForTimeout(400);
    return [];
  }

  const tabNames = /happy\s*hour|golden\s*hour|specials?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|game day|load more/i;
  const collected = [];
  try {
    const clickables = page.locator('button, [role="tab"], [role="button"], summary, a').filter({ hasText: tabNames });
    const count = Math.min(await clickables.count(), 10);
    for (let i = 0; i < count; i += 1) {
      try {
        await clickables.nth(i).click({ timeout: 800 });
        await page.waitForTimeout(250);
        const tabText = await page.evaluate(() => (document.body?.innerText || '').trim());
        if (tabText) collected.push(tabText);
      } catch {
        // not clickable
      }
    }
    const hhTabs = page.locator('button, [role="tab"], [role="button"], a').filter({ hasText: /happy\s*hour|golden\s*hour/i });
    const hhCount = Math.min(await hhTabs.count(), 4);
    for (let i = 0; i < hhCount; i += 1) {
      try {
        await hhTabs.nth(i).click({ timeout: 800 });
        await page.waitForTimeout(300);
        const tabText = await page.evaluate(() => (document.body?.innerText || '').trim());
        if (tabText) collected.push(tabText);
      } catch {
        // not clickable
      }
    }
  } catch {
    // no tab UI
  }

  await page.waitForTimeout(400);
  return collected;
}

/**
 * Returns { fetch, close, saveState? } compatible with website crawl fetchImpl.
 */
export async function createBrowserFetch(options = {}) {
  try {
    const config = { ...playwrightOptionsFromEnv(), ...options };
    const { context, browser, persistent, isWarmSession } = await launchContext(options);

    return {
      fetch: async (url, requestInit = {}) => {
        const page = await context.newPage();
        try {
          const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          const status = nav?.status() || 0;
          if (status >= 400) {
            return {
              ok: false,
              status,
              headers: { get: () => nav?.headers()?.['content-type'] || 'text/html' },
              text: async () => '',
              visibleText: async () => '',
            };
          }
          const waitMode = requestInit.sdhhWaitMode === 'discovery' ? 'discovery' : 'content';
          const tabTexts = await waitForRealContent(page, { mode: waitMode });
          const html = await page.content();
          const visibleNow = await page.evaluate(() => (document.body?.innerText || '').trim());
          const visibleText = [...(tabTexts || []), visibleNow].filter(Boolean).join('\n\n');
          if (isCloudflareChallenge(html)) {
            throw new Error(
              'Cloudflare challenge active. Run: npm run browser:warm -- --auto'
            );
          }
          return {
            ok: true,
            status,
            headers: { get: () => nav?.headers()?.['content-type'] || 'text/html' },
            text: async () => html,
            visibleText: async () => visibleText,
          };
        } finally {
          await page.close();
        }
      },
      saveState: async () => {
        if (!isWarmSession) return false;
        fs.mkdirSync(path.dirname(config.statePath), { recursive: true });
        await context.storageState({ path: config.statePath });
        return true;
      },
      close: async () => {
        if (isWarmSession) {
          try {
            fs.mkdirSync(path.dirname(config.statePath), { recursive: true });
            await context.storageState({ path: config.statePath });
          } catch {
            // ignore
          }
        }
        await context.close();
        if (browser) await browser.close();
      },
    };
  } catch (error) {
    console.warn('Playwright unavailable; falling back to fetch-only mode.', error.message);
    return null;
  }
}

export function hasBrowserState() {
  return fs.existsSync(BROWSER_STATE_PATH);
}
