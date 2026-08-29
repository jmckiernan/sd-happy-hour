/**
 * Render a happy-hour menu board image for venues that publish their happy
 * hour as HTML instead of a flyer we can reuse.
 *
 * Boards are rendered from HTML in headless Chrome rather than drawn on a
 * canvas: it's the only way to use the site's real display/body faces
 * (Playfair Display + Outfit) and gradients, and a deviceScaleFactor of 2
 * gives a retina-sharp image without hand-rolled text layout.
 *
 * The structured board is stored on the listing as `hhMenu`, so restyling
 * every board is a local re-render (`npm run menus:render`) with no crawl
 * and no AI spend. See docs/venue-data-pipeline.md.
 */

import { formatWindows } from './menu-board-format.mjs';

/** Matches the site's design tokens in src/layouts/Layout.astro. */
const THEME = {
  night: '#0F172A',
  nightSoft: '#1E293B',
  oceanDeep: '#164E63',
  sunsetStart: '#FF6B35',
  sunsetMid: '#F7931E',
  sunsetEnd: '#FFD23F',
  sand: '#FFFBF5',
};

const WIDTH = 1080;
const DEVICE_SCALE = 2;
/** Past this many items a single column gets uncomfortably tall and thin. */
const TWO_COLUMN_ITEM_COUNT = 14;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function countItems(board) {
  return (board.sections || []).reduce((total, section) => total + (section.items || []).length, 0);
}

/**
 * Always formatted from the listing's own windows, never from a string the
 * model copied off the page — that's how a 24-hour clock would sneak onto a
 * customer-facing board.
 */
function boardHoursLines(board, venue) {
  return formatWindows(venue?.windows || board.windows || []);
}

function sectionHtml(section) {
  const items = (section.items || [])
    .map((item) => {
      const price = String(item.price || '').trim();
      return `
        <li class="item">
          <span class="item-name">${escapeHtml(item.name)}</span>
          ${price ? `<span class="leader"></span><span class="item-price">${escapeHtml(price)}</span>` : ''}
        </li>`;
    })
    .join('');
  return `
    <section class="menu-section">
      <h2 class="section-title">${escapeHtml(section.title || 'Happy Hour')}</h2>
      <ul class="items">${items}</ul>
    </section>`;
}

export function buildBoardHtml(board, venue = {}) {
  const venueName = String(venue.name || 'Happy Hour').replace(/\s+/g, ' ').trim();
  const hoursLines = boardHoursLines(board, venue);
  const twoColumn = countItems(board) >= TWO_COLUMN_ITEM_COUNT;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    width: ${WIDTH}px;
    font-family: 'Outfit', -apple-system, sans-serif;
    /* Night navy into ocean deep: the same dusk the site backdrop sits in. */
    background:
      radial-gradient(120% 80% at 50% -10%, rgba(255, 107, 53, 0.28), transparent 60%),
      linear-gradient(168deg, ${THEME.night} 0%, ${THEME.nightSoft} 55%, ${THEME.oceanDeep} 100%);
    color: ${THEME.sand};
    padding: 56px;
  }

  .board {
    border: 1px solid rgba(255, 210, 63, 0.35);
    border-radius: 24px;
    padding: 48px 44px 36px;
    background: rgba(15, 23, 42, 0.35);
  }

  header { text-align: center; padding-bottom: 28px; }

  .eyebrow {
    font-size: 19px;
    font-weight: 600;
    letter-spacing: 0.34em;
    text-transform: uppercase;
    color: ${THEME.sunsetEnd};
  }

  .venue-name {
    font-family: 'Playfair Display', Georgia, serif;
    font-weight: 700;
    font-size: 62px;
    line-height: 1.1;
    margin: 14px 0 18px;
  }

  /* Sunset rule under the name — the site's signature gradient. */
  .rule {
    width: 168px;
    height: 4px;
    margin: 0 auto 20px;
    border-radius: 4px;
    background: linear-gradient(90deg, ${THEME.sunsetStart}, ${THEME.sunsetMid}, ${THEME.sunsetEnd});
  }

  .hours { font-size: 27px; font-weight: 500; line-height: 1.5; }
  .hours span { display: block; }
  .note {
    margin-top: 12px;
    font-size: 20px;
    font-weight: 400;
    color: rgba(255, 251, 245, 0.72);
  }

  .sections { columns: ${twoColumn ? 2 : 1}; column-gap: 48px; }

  .menu-section {
    break-inside: avoid-column;
    padding-top: 26px;
  }

  .section-title {
    font-size: 19px;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: ${THEME.sunsetMid};
    padding-bottom: 12px;
    margin-bottom: 14px;
    border-bottom: 1px solid rgba(255, 210, 63, 0.22);
  }

  .items { list-style: none; }

  /* Dotted leader between name and price, the way a printed menu sets it. */
  .item {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 9px 0;
    font-size: 25px;
    font-weight: 500;
    line-height: 1.35;
  }
  .item-name { flex: 0 1 auto; }
  .leader {
    flex: 1 1 auto;
    min-width: 18px;
    margin-bottom: 7px;
    border-bottom: 1px dotted rgba(255, 251, 245, 0.28);
  }
  .item-price { flex: 0 0 auto; font-weight: 600; color: ${THEME.sunsetEnd}; }

  footer {
    margin-top: 34px;
    padding-top: 18px;
    border-top: 1px solid rgba(255, 251, 245, 0.14);
    display: flex;
    justify-content: space-between;
    font-size: 17px;
    letter-spacing: 0.06em;
    color: rgba(255, 251, 245, 0.55);
  }
  .brand { color: ${THEME.sunsetEnd}; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; }
</style>
</head>
<body>
  <div class="board">
    <header>
      <p class="eyebrow">Happy Hour</p>
      <h1 class="venue-name">${escapeHtml(venueName)}</h1>
      <div class="rule"></div>
      <div class="hours">
        ${hoursLines.map((line) => `<span>${escapeHtml(line)}</span>`).join('')}
      </div>
      ${board.note ? `<p class="note">${escapeHtml(board.note)}</p>` : ''}
    </header>
    <div class="sections">
      ${(board.sections || []).map((section) => sectionHtml(section)).join('')}
    </div>
    <footer>
      <span class="brand">Happy Hour SD</span>
      <span>Prices and offers subject to change</span>
    </footer>
  </div>
</body>
</html>`;
}

/** Rasterize one board in an already-open Playwright context. */
export async function renderMenuBoardImage(board, venue = {}, options = {}) {
  if (!board?.sections?.length) return null;

  const { context, timeoutMs = 15_000 } = options;
  if (!context) throw new Error('renderMenuBoardImage requires a Playwright context');

  const page = await context.newPage();
  try {
    await page.setContent(buildBoardHtml(board, venue), { waitUntil: 'load', timeout: timeoutMs });
    // Webfonts arrive after load; screenshotting early bakes in fallback type.
    await page.evaluate(() => document.fonts.ready);
    const bytes = await page.locator('body').screenshot({ type: 'png' });
    return {
      bytes: Buffer.from(bytes),
      mediaType: 'image/png',
      kind: 'image',
      url: venue.website || null,
      sourceUrl: board.sourceUrl || venue.website || null,
      generated: true,
    };
  } finally {
    await page.close();
  }
}

/**
 * Board rendering needs its own Chrome regardless of whether the crawl is
 * running in browser mode, so the renderer owns one and launches it lazily —
 * a run with no HTML-only venues never pays for a browser at all.
 */
export function createMenuBoardRenderer(options = {}) {
  const { useChrome = process.env.PLAYWRIGHT_USE_CHROME !== '0' } = options;
  let browser = null;
  let context = null;

  return {
    async render(board, venue) {
      if (!board?.sections?.length) return null;
      if (!context) {
        const { chromium } = await import('playwright');
        browser = await chromium.launch({
          headless: true,
          channel: useChrome ? 'chrome' : undefined,
        });
        context = await browser.newContext({
          viewport: { width: WIDTH, height: 1200 },
          deviceScaleFactor: DEVICE_SCALE,
        });
      }
      return renderMenuBoardImage(board, venue, { context });
    },
    async close() {
      await context?.close();
      await browser?.close();
      context = null;
      browser = null;
    },
  };
}
