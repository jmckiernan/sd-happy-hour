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
import { menuTextFromJsonResponses } from './json-menu-extract.mjs';

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
    // Deliberately much taller than a real laptop: menu platforms render only
    // the sections near the viewport and park the rest behind a "Load More"
    // control that often isn't clickable. A tall viewport renders the whole
    // menu up front — at 900px tall, Popmenu gave us a happy-hour menu's
    // drinks and silently dropped its entire food section.
    viewport: { width: 1366, height: 1600 },
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

const LOAD_MORE_TEXT = /load more|show more|view more|see more/i;

/**
 * Wait until the page's own text stops growing, then treat it as hydrated.
 *
 * A fixed delay is the wrong tool: too short and we transcribe half a menu as
 * if it were the whole thing, too long and it costs every venue in the run.
 */
async function waitForTextToSettle(page, { timeoutMs = 6000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastLength = -1;
  let stableRounds = 0;

  while (Date.now() < deadline) {
    let length = lastLength;
    try {
      length = await page.evaluate(() => (document.body?.innerText || '').length);
    } catch {
      return;
    }
    if (length === lastLength) {
      stableRounds += 1;
      if (stableRounds >= 2) return;
    } else {
      stableRounds = 0;
      lastLength = length;
    }
    await page.waitForTimeout(intervalMs);
  }
}

/** Scroll through the page so intersection-observer content renders. */
async function scrollThroughPage(page) {
  return page.evaluate(async () => {
    const step = 700;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 250));
    return document.body.scrollHeight;
  });
}

/**
 * Menu platforms (Popmenu especially) render only what's near the viewport and
 * park the rest behind a "Load More Content" control — that's how an entire
 * HH Food section goes missing from a menu we "fetched". Scroll the page and
 * exhaust those controls before reading the text.
 *
 * Scrolling matters more than clicking: the control is often not a button or a
 * link, so it can't be targeted by role, while scrolling reveals sections on
 * any lazily-rendered menu regardless of platform.
 */
async function expandLazyContent(page, maxRounds = 4) {
  let lastHeight = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    let height = lastHeight;
    try {
      height = await scrollThroughPage(page);
    } catch {
      // page navigated mid-scroll
    }

    let clicked = false;
    // Any element, not just button/a: these controls are often plain divs.
    const more = page.getByText(LOAD_MORE_TEXT).first();
    try {
      if (await more.count()) {
        await more.scrollIntoViewIfNeeded({ timeout: 1000 });
        await more.click({ timeout: 1000 });
        clicked = true;
        await page.waitForTimeout(700);
      }
    } catch {
      // decorative or non-interactive control; the tall viewport covers us
    }

    // Nothing new rendered and nothing left to click.
    if (!clicked && height === lastHeight) break;
    lastHeight = height;
  }

  return page.evaluate(() => (document.body?.innerText || '').trim());
}

const TAB_NAMES = /happy\s*hour|golden\s*hour|specials?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|game day/i;

/**
 * Click each matching menu tab and read the text it reveals, expanding any
 * lazy content behind it. Returns every tab's text joined, since a menu split
 * across tabs is one menu.
 */
async function clickTabsAndExpand(page, pattern, maxTabs) {
  const tabs = page.locator('button, [role="tab"], [role="button"], summary, a').filter({ hasText: pattern });
  const count = Math.min(await tabs.count(), maxTabs);
  const texts = [];
  for (let i = 0; i < count; i += 1) {
    try {
      await tabs.nth(i).click({ timeout: 800 });
      await page.waitForTimeout(300);
      texts.push(await expandLazyContent(page));
    } catch {
      // not clickable, or the click navigated away from this locator
    }
  }
  return texts.filter(Boolean).join('\n\n');
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

  // The text check above passes on server-rendered markup, but menu platforms
  // load the actual items over XHR afterwards. Reading a half-built menu is
  // the dangerous case, because a half-built menu looks like a complete one.
  await waitForTextToSettle(page);

  if (!interact) {
    await page.waitForTimeout(400);
    return [];
  }

  const collected = [];

  /**
   * Each phase below is independent: clicking a tab can navigate the page and
   * invalidate every locator created before it, so one phase throwing must
   * never cost us the text another phase would have collected.
   */
  const debug = process.env.SDHH_DEBUG_BROWSER === '1';
  const phase = async (label, run) => {
    try {
      const text = await run();
      if (debug) {
        console.log(`    [phase ${label}] len=${text?.length || 0} url=${page.url()}`);
        for (const marker of ['HH DRINKS', 'HH FOOD']) {
          if (text && text.toUpperCase().includes(marker)) console.log(`      has ${marker}`);
        }
      }
      if (text) collected.push(text);
    } catch (error) {
      if (debug) console.log(`    [phase ${label}] failed: ${error.message.split('\n')[0]}`);
    }
  };

  // Expand before clicking anything: a menu URL that already opens on the
  // happy-hour tab needs only the lazy content revealed.
  await phase('expand', () => expandLazyContent(page));

  // Happy-hour tabs first, for the same reason.
  await phase('hh-tabs', () => clickTabsAndExpand(page, /happy\s*hour|golden\s*hour/i, 4));
  await phase('tabs', () => clickTabsAndExpand(page, TAB_NAMES, 10));

  await phase('expand-final', () => expandLazyContent(page));

  await page.waitForTimeout(400);
  return collected.filter(Boolean);
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
        const jsonResponses = [];
        let jsonBudget = 4_000_000;
        page.on('response', async (response) => {
          if (jsonBudget <= 0) return;
          const type = response.headers()['content-type'] || '';
          if (!/json/i.test(type)) return;
          try {
            const body = await response.text();
            if (!body || body.length > 1_500_000) return;
            jsonBudget -= body.length;
            jsonResponses.push({ url: response.url(), body });
          } catch {
            // body already discarded by the browser
          }
        });
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
          // Menu APIs answer with every section; the DOM only ever shows the
          // selected one, so the JSON is the more complete of the two sources.
          const jsonMenuText = menuTextFromJsonResponses(jsonResponses);
          const visibleText = [...(tabTexts || []), visibleNow, jsonMenuText]
            .filter(Boolean)
            .join('\n\n');
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
