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

import sharp from 'sharp';
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
/** El Pueblo's board is the reference minimum requested for every generated
 * menu. At the 2x screenshot scale this produces a 2160x2496 WebP. */
export const MIN_BOARD_HEIGHT = 1248;
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
      // A saving is not a cost, so it must not read as one. Both sit in the
      // same right-hand column a printed menu uses, but a discount is set in
      // the lighter weight and cooler colour reserved for it, so a glance down
      // the column tells "this costs $8" from "this is $2 cheaper than usual".
      const discount = item.offer?.kind === 'amount_off' || item.offer?.kind === 'percent_off';
      const priceClass = discount ? 'item-price item-discount' : 'item-price';
      return `
        <li class="item">
          <span class="item-name">${escapeHtml(item.name)}</span>
          ${price ? `<span class="leader"></span><span class="${priceClass}">${escapeHtml(price)}</span>` : ''}
        </li>`;
    })
    .join('');
  // A section too long for one page carries on overleaf under its own name, so
  // the second half of a drinks list is not read as a new category.
  const title = `${escapeHtml(section.title || 'Happy Hour')}${section.continued ? ' <span class="continued">continued</span>' : ''}`;
  return `
    <section class="menu-section">
      <h2 class="section-title">${title}</h2>
      <ul class="items">${items}</ul>
    </section>`;
}

/**
 * @param {object} options
 * @param {number} [options.page] 1-based page number.
 * @param {number} [options.pageCount] Total pages; a marker is drawn only when
 *   this is above one.
 * @param {boolean} [options.twoColumn] Force the column count. Pagination sets
 *   this per page, because whether two columns are wanted depends on whether
 *   the page fits without them, not on an item count alone: a menu of four
 *   short sections has few items and still needs the second column.
 */
export function buildBoardHtml(board, venue = {}, options = {}) {
  const venueName = String(venue.name || 'Happy Hour').replace(/\s+/g, ' ').trim();
  const hoursLines = boardHoursLines(board, venue);
  const { page = 1, pageCount = 1 } = options;
  const twoColumn = options.twoColumn ?? countItems(board) >= TWO_COLUMN_ITEM_COUNT;

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
    min-height: ${MIN_BOARD_HEIGHT}px;
    display: flex;
    font-family: 'Outfit', -apple-system, sans-serif;
    /* Night navy into ocean deep: the same dusk the site backdrop sits in. */
    background:
      radial-gradient(120% 80% at 50% -10%, rgba(255, 107, 53, 0.28), transparent 60%),
      linear-gradient(168deg, ${THEME.night} 0%, ${THEME.nightSoft} 55%, ${THEME.oceanDeep} 100%);
    color: ${THEME.sand};
    padding: 56px;
  }

  .board {
    width: 100%;
    min-height: ${MIN_BOARD_HEIGHT - 112}px;
    display: flex;
    flex-direction: column;
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

  .sections {
    columns: ${twoColumn ? 2 : 1};
    column-gap: 48px;
    /* This is the normal menu-to-footer breathing room. Any height added to
       meet the minimum joins it here because the footer is bottom-anchored. */
    padding-bottom: 34px;
  }

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
  .item-price { flex: 0 0 auto; font-weight: 600; color: ${THEME.sunsetEnd}; white-space: nowrap; }
  /* A discount is a phrase, not a figure: lighter and cooler so it cannot be
     misread as the price, but still bright enough to read zoomed on a phone. */
  .item-discount { font-weight: 500; color: rgba(255, 251, 245, 0.86); font-style: italic; }

  footer {
    margin-top: auto;
    padding-top: 18px;
    border-top: 1px solid rgba(255, 251, 245, 0.14);
    display: flex;
    justify-content: space-between;
    font-size: 17px;
    letter-spacing: 0.06em;
    color: rgba(255, 251, 245, 0.55);
  }
  .brand { color: ${THEME.sunsetEnd}; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; }
  .page-marker { color: ${THEME.sunsetEnd}; font-weight: 600; letter-spacing: 0.1em; }
  .continued {
    font-size: 15px;
    font-weight: 500;
    letter-spacing: 0.12em;
    color: rgba(255, 251, 245, 0.5);
  }
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
      ${pageCount > 1 ? `<span class="page-marker">Page ${page} of ${pageCount}</span>` : ''}
      <span>Prices and offers subject to change</span>
    </footer>
  </div>
</body>
</html>`;
}

/**
 * How tall a page may get, in CSS pixels, at the board's 1080px width.
 *
 * This is a readability limit, not a technical one — the renderer screenshots
 * the whole body, so a board will happily grow to any height. Past roughly this
 * ratio a board stops looking like a menu page and becomes a strip that is
 * unreadable as a gallery thumbnail and tedious to pan on a phone.
 */
const MAX_PAGE_HEIGHT = 1500;

/**
 * A generous sanity bound, not a design limit. The longest happy-hour menu in
 * the catalog is a page and a half; six pages is far past anything a venue has
 * published, and hitting it means the menu is not a menu.
 */
export const MAX_BOARD_PAGES = 6;

async function measureBoardHeight(html, context, timeoutMs) {
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
    await page.evaluate(() => document.fonts.ready);
    return page.evaluate(() => document.body.getBoundingClientRect().height);
  } finally {
    await page.close();
  }
}

/** Split one oversized section into `parts` slices of near-equal length. */
function sliceSection(section, parts) {
  const items = section.items || [];
  const per = Math.ceil(items.length / parts);
  const slices = [];
  for (let start = 0; start < items.length; start += per) {
    slices.push({
      ...section,
      items: items.slice(start, start + per),
      ...(start > 0 ? { continued: true } : {}),
    });
  }
  return slices;
}

/**
 * Break a menu into pages that each fit `MAX_PAGE_HEIGHT`.
 *
 * Page breaks are decided by measuring, not by counting. The old four-section
 * cap threw away whatever did not fit an assumed layout, which is how Amigo
 * Cantina lost a tequila flight section; what actually fits depends on how many
 * items each section holds and how long their names are, so the only honest
 * test is to lay the page out and read its height.
 *
 * Sections are packed greedily and a section is kept whole wherever it can be,
 * because a category starting on a fresh page reads better than one broken
 * mid-list. A single section too long for any page is the exception, and it is
 * split into near-equal slices rather than filling one page and leaving a
 * remainder of two items on the next.
 */
export async function packMenuSections(sections, fits, maxPages = MAX_BOARD_PAGES) {
  if (!sections?.length) return [];
  // The common case, and the only measurement most venues need.
  if (await fits(sections, 1)) return [sections];

  const queue = [...sections];
  const pages = [];
  while (queue.length && pages.length < maxPages) {
    // On the final allowed page, take everything left rather than drop it.
    // Overflowing one board is a cosmetic failure; losing a venue's food menu
    // because its drinks list was long is a data one.
    if (pages.length === maxPages - 1) {
      pages.push(queue.splice(0));
      break;
    }

    let taken = 0;
    for (let count = 1; count <= queue.length; count += 1) {
      // Probe as though there are two pages: the marker is one line and does
      // not change which sections fit.
      if (!(await fits(queue.slice(0, count), 2))) break;
      taken = count;
    }

    if (taken === 0) {
      // Not even the first section fits, so it has to be divided. Slices are
      // near-equal rather than max-filled, so a long list does not leave a
      // final page holding two items.
      const section = queue.shift();
      let slices = [section];
      for (let parts = 2; parts <= maxPages; parts += 1) {
        slices = sliceSection(section, parts);
        if (await fits([slices[0]], 2)) break;
      }
      pages.push([slices[0]]);
      queue.unshift(...slices.slice(1));
      continue;
    }

    pages.push(queue.splice(0, taken));
  }

  // Anything still queued would be silently dropped, which is the bug this
  // whole change exists to remove.
  if (queue.length) pages[pages.length - 1].push(...queue.splice(0));
  return pages;
}

export async function paginateMenuBoard(board, venue = {}, options = {}) {
  const { context, timeoutMs = 15_000 } = options;
  if (!board?.sections?.length) return [];
  if (!context) throw new Error('paginateMenuBoard requires a Playwright context');

  const pageBoard = (sections) => ({ ...board, sections });

  /**
   * The narrowest layout this page fits in, or null if it fits in neither.
   *
   * One column is preferred because a full-width list with the price at the
   * right margin is how a menu reads; the second column is a way of fitting
   * more on the page, so it is only reached for when one column overflows.
   * Deciding by item count instead left a menu of four three-item sections in
   * one tall column and split it needlessly across two pages.
   */
  const layoutFor = async (sections, pageCount) => {
    for (const twoColumn of [false, true]) {
      const html = buildBoardHtml(pageBoard(sections), venue, { page: 1, pageCount, twoColumn });
      if ((await measureBoardHeight(html, context, timeoutMs)) <= MAX_PAGE_HEIGHT) return { twoColumn };
    }
    return null;
  };

  const pages = await packMenuSections(
    board.sections,
    async (sections, pageCount) => Boolean(await layoutFor(sections, pageCount)),
  );

  const out = [];
  for (const sections of pages) {
    // The last page of an over-long menu is taken whole and may not fit
    // either way; two columns is the better failure.
    const layout = (await layoutFor(sections, pages.length)) || { twoColumn: true };
    out.push({ ...pageBoard(sections), twoColumn: layout.twoColumn });
  }
  return out;
}

/** Rasterize every page of a board. */
export async function renderMenuBoardPages(board, venue = {}, options = {}) {
  const pages = await paginateMenuBoard(board, venue, options);
  if (!pages.length) return [];
  const images = [];
  for (const [index, pageBoard] of pages.entries()) {
    const image = await renderMenuBoardImage(pageBoard, venue, {
      ...options,
      page: index + 1,
      pageCount: pages.length,
      twoColumn: pageBoard.twoColumn,
    });
    if (image?.bytes?.length) images.push(image);
  }
  return images;
}

/** Rasterize one board in an already-open Playwright context. */
export async function renderMenuBoardImage(board, venue = {}, options = {}) {
  if (!board?.sections?.length) return null;

  const { context, timeoutMs = 15_000, page: pageNumber = 1, pageCount = 1, twoColumn } = options;
  if (!context) throw new Error('renderMenuBoardImage requires a Playwright context');

  const page = await context.newPage();
  try {
    const html = buildBoardHtml(board, venue, { page: pageNumber, pageCount, twoColumn });
    await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
    // Webfonts arrive after load; screenshotting early bakes in fallback type.
    await page.evaluate(() => document.fonts.ready);
    // Playwright only writes PNG or JPEG, and PNG of a 2160px board runs to
    // about 1.2MB — 352 boards came to 373MB, over half of everything committed
    // under public/images. WebP takes the same board to roughly 180KB.
    //
    // q82 was chosen by measurement, not by feel. On the densest boards the
    // error against the PNG barely moves between q82 and q92 (RMSE 2.71 vs 2.51
    // on Hooleys' twelve-section board) because what is left is ringing on
    // glyph edges, which more quality does not buy back — while the file grows
    // 40%. At 1:1, which is the most a reader can zoom to, q82 is
    // indistinguishable from the original down to the dotted leader lines.
    const png = await page.locator('body').screenshot({ type: 'png' });
    const bytes = await sharp(png).webp({ quality: 82, effort: 6 }).toBuffer();
    return {
      bytes: Buffer.from(bytes),
      mediaType: 'image/webp',
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

  async function ensureContext() {
    if (context) return;
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

  return {
    async render(board, venue) {
      if (!board?.sections?.length) return null;
      await ensureContext();
      return renderMenuBoardImage(board, venue, { context });
    },
    /** Every page of the menu, in order. */
    async renderPages(board, venue) {
      if (!board?.sections?.length) return [];
      await ensureContext();
      return renderMenuBoardPages(board, venue, { context });
    },
    async close() {
      await context?.close();
      await browser?.close();
      context = null;
      browser = null;
    },
  };
}
