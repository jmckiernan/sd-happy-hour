import { decodeHtmlEntities } from './deals.mjs';
import { sleep } from './io.mjs';
import { isCloudflareChallenge } from './cloudflare-challenge.mjs';
import { discoverFromSitemap } from './sitemap-discover.mjs';
import {
  LOCATOR_CANDIDATE_PATHS,
  detectLocatorApis,
  fetchLocatorRecords,
} from './locator-widgets.mjs';
import {
  classifyUrl,
  discoverSocialLinks,
  discoverSpecialsMedia,
  isMediaUrl,
  mediaKindFromContentType,
  applySniffedMedia,
  scoreMediaUrl,
  socialSnippetFromHtml,
} from './media.mjs';
import {
  conflictsWithVenue,
  discoverBranchLocationLinksFromHtml,
  pickLocationPage,
  scoreLocationUrl,
} from './location-page.mjs';

export { isCloudflareChallenge };

export const USER_AGENT = 'HappyHourSDImport/1.0 (+https://happyhoursd.com)';

/** Always guessed and sent to the model: home, menu, happy hour, specials. */
/**
 * Paths to try only when a site gives us nothing to follow.
 *
 * Deliberately short, and deliberately only real web conventions. Guessing is
 * a last resort, not a strategy: every guess costs a fetch out of a small
 * budget, and a long guess list starves the pages we actually found — that is
 * how a splash-page venue whose menu PDF was linked from its homepage got
 * reported as `no_candidates` while we 404'd through a dozen invented URLs.
 *
 * Venue-specific naming ("golden hour", Popmenu's `/list`, one restaurant's
 * `/specials--happy-hour`) belongs in the link *recognizers* below, so those
 * pages are still crawled when a site links them — which is evidence — rather
 * than probed blindly on all 611 domains, which is not.
 */
export const CONVENTIONAL_CANDIDATE_PATHS = [
  { path: '/happy-hour', score: 16 },
  { path: '/happy-hours', score: 16 },
  { path: '/happyhour', score: 14 },
  { path: '/specials', score: 13 },
  { path: '/menu', score: 12 },
  { path: '/menus', score: 12 },
];

/**
 * A discovered link at or above this score is real evidence (a sitemap entry,
 * a nav link, a linked menu document), which makes guessing unnecessary.
 */
const EVIDENCE_SCORE = 20;

const HOMEPAGE_PATH = '/';

const HH_LINK_RE = /happy\s*hour|happyhour|golden\s*hour|goldenhour|after\s*five|specials?|promotions?|offers?|drink specials?|taco\s*tues|wine\s*wed|daily special/i;
const HH_URL_RE = /happy[-_/ ]?hour|happyhour|golden[-_/ ]?hour|goldenhour|after[-_]?five|specials|promotions|offers|taco|wine-?night|daily-?special|(?:^|\/)list(?:\/|$)/i;
const MENU_PATH_RE = /(?:^|\/)menus?(?:\/|$)/i;
const MENU_ANCHOR_RE = /\b(?:food\s+)?menus?\b|\bview (?:the )?menu\b|\bour menu\b/i;
const SPECIALS_TEXT_RE = /happy\s*hour|daily\s+specials?|drink\s+specials?|taco\s+tues|wine\s+wednes|thirsty\s+thurs|industry\s+night|half[- ]?price|1\/2\s*price|\d+%\s*off|\$\s?\d{1,2}(?:\.\d{2})?\b/i;
const MENU_ITEM_PATH_RE = /\/(?:items?|products?|p)\/[^/]+/i;
/**
 * A multi-location brand's locator. Worth following only because the offer is
 * sometimes published nowhere else (see locator-widgets.mjs) — the page's own
 * text almost never mentions happy hour, so it scores near the floor and must
 * never outrank a specials or menu link.
 */
const LOCATOR_PATH_RE = /(?:^|\/)(?:locations?|store-?locator|find-?us|our-?locations?)(?:\/|$|\?)/i;
const LOCATOR_ANCHOR_RE = /\b(?:locations?|store locator|find us|find a location)\b/i;

/** Single dish/product permalinks are not inventory pages. */
export function isMenuItemDetailUrl(url) {
  try {
    return MENU_ITEM_PATH_RE.test(new URL(url, 'https://example.com').pathname);
  } catch {
    return MENU_ITEM_PATH_RE.test(String(url || ''));
  }
}

export function urlLooksLikeMenuPage(url) {
  try {
    return MENU_PATH_RE.test(new URL(url, 'https://example.com').pathname);
  } catch {
    return MENU_PATH_RE.test(String(url || ''));
  }
}

export function urlLooksLikeHappyHourPage(url) {
  return HH_URL_RE.test(String(url || '')) || urlLooksLikeMenuPage(url);
}

export function isCoreCandidateUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path === '/' || path === '') return true;
    return CONVENTIONAL_CANDIDATE_PATHS.some((row) => path === row.path || path === `${row.path}/`);
  } catch {
    return false;
  }
}

const SKIP_LINK_RE = /\.(?:svg|zip|mp4|webm)(?:\?|$)/i;

function sameSiteHost(urlA, urlB) {
  const normalize = (hostname) => String(hostname || '').replace(/^www\./i, '').toLowerCase();
  try {
    return normalize(new URL(urlA).hostname) === normalize(new URL(urlB).hostname);
  } catch {
    return false;
  }
}

export async function fetchPageContent(url, fetchImpl = fetch, options = {}) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/pdf,image/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
    sdhhWaitMode: options.waitMode || (urlLooksLikeHappyHourPage(url) ? 'content' : 'discovery'),
  });
  if (!response) {
    return { ok: false, url, kind: 'html', html: null, text: null, blocked: false, status: 0 };
  }

  const contentType = response.headers.get('content-type') || '';
  const kind = response.kind || mediaKindFromContentType(contentType, url) || classifyUrl(url);
  const status = response.status || (response.ok ? 200 : 0);

  if (kind === 'pdf' || kind === 'image') {
    const bytes = typeof response.arrayBuffer === 'function' ? Buffer.from(await response.arrayBuffer()) : null;
    return applySniffedMedia({
      url,
      ok: Boolean(response.ok && bytes?.length),
      kind,
      html: '',
      text: '',
      bytes,
      contentType,
      cached: Boolean(response.cached),
      blocked: Boolean(response.blocked),
      status,
    });
  }

  if (!response.ok) {
    return {
      url,
      ok: false,
      kind: 'html',
      html: null,
      text: null,
      cached: Boolean(response.cached),
      blocked: Boolean(response.blocked) || status === 403 || status === 429,
      status,
    };
  }

  const html = (await response.text()).slice(0, 500_000);
  const pageBlocked = isCloudflareChallenge(html);
  const htmlText = htmlToText(html);
  let visible = '';
  if (typeof response.visibleText === 'function') {
    visible = await response.visibleText();
  }
  const merged = dedupeTextLines(
    [visible, htmlText].filter((part) => part && part.trim()).join('\n\n')
  );
  const text = preferSpecialsSlice(merged, 80_000);
  return {
    url,
    ok: !pageBlocked,
    kind: 'html',
    html,
    text,
    cached: Boolean(response.cached),
    blocked: pageBlocked,
    status,
  };
}

export async function fetchPageHtml(url, fetchImpl = fetch) {
  const content = await fetchPageContent(url, fetchImpl);
  return content?.html ?? null;
}

/**
 * Collapse repeated lines while keeping first-seen order.
 *
 * A rendered menu page is read once per tab we click, so the same nav, footer,
 * and menu sections arrive many times over. Left alone, that redundancy blows
 * past the per-page character budget and the truncation drops real menu
 * sections — a happy-hour menu would keep its food and lose its drinks purely
 * because the drinks came later in a pile of duplicates.
 */
export function dedupeTextLines(text) {
  const seen = new Set();
  const lines = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) {
      // Keep single blank lines as block separators.
      if (lines[lines.length - 1] !== '') lines.push('');
      continue;
    }
    const key = line.toLowerCase().replace(/\s+/g, ' ');
    // Short lines (prices, counts, "0") legitimately repeat.
    if (key.length > 3) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    lines.push(line);
  }
  return lines.join('\n').trim();
}

export function htmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      // We cap fetched HTML, which can cut a page mid-<script>. Without this
      // the leftover tag never closes and a minified JS/JSON blob (Popmenu
      // ships a ~200KB Apollo cache) survives as "page text", crowding the
      // real menu out of the model's character budget.
      .replace(/<(script|style)\b[^>]*>[\s\S]*$/i, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|div|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function scoreSpecialsContext(near) {
  let score = 0;
  if (/\d{1,2}(?::\d{2})?\s*(?:am|pm)/i.test(near)) score += 2;
  if (/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(near)) score += 4;
  if (/\$\s?\d/.test(near)) score += 5;
  if (/\b(?:2|3|4|5)\s*(?::\d{2})?\s*pm\b/i.test(near)) score += 4;
  if (/happy hour lunch|brunch|breakfast|eggs? things/i.test(near)) score -= 8;
  if (/12\s*am/i.test(near)) score -= 6;
  return score;
}

/**
 * Long all-day menus bury happy hour at the bottom. Keep the section the
 * model needs instead of always sending the first N characters.
 */
export function preferSpecialsSlice(text, maxChars = 80_000) {
  const trimmed = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (!trimmed) return '';
  if (trimmed.length <= maxChars) return trimmed;

  const lower = trimmed.toLowerCase();
  let best = -1;
  let bestScore = -Infinity;
  let searchFrom = 0;
  while (searchFrom < lower.length) {
    const idx = lower.indexOf('happy hour', searchFrom);
    if (idx === -1) break;
    const score = scoreSpecialsContext(lower.slice(idx, idx + 800));
    if (score > bestScore) {
      bestScore = score;
      best = idx;
    }
    searchFrom = idx + 10;
  }
  if (best === -1) {
    for (const marker of ['daily specials', 'drink specials', 'weeknight specials']) {
      const idx = lower.indexOf(marker);
      if (idx !== -1) {
        best = idx;
        break;
      }
    }
  }

  const start = best === -1 ? 0 : Math.max(0, best - 200);
  const slice = trimmed.slice(start, start + maxChars);
  const prefix = start > 0 ? '[earlier menu truncated]\n' : '';
  const suffix = start + maxChars < trimmed.length ? '\n[truncated]' : '';
  return `${prefix}${slice}${suffix}`;
}

export function discoverInternalLinks(html, origin, maxLinks = 60) {
  const links = new Set();
  const originUrl = new URL(origin);

  for (const match of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    let href = match[1].trim();
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      continue;
    }
    try {
      const url = new URL(href, origin);
      if (!sameSiteHost(url.href, originUrl.href)) continue;
      if (SKIP_LINK_RE.test(url.pathname)) continue;
      url.hash = '';
      const path = url.pathname + url.search;
      if (isMediaUrl(url.href)) {
        const mediaScore = scoreMediaUrl(url.href);
        if (mediaScore > 0) links.add(path);
      } else {
        links.add(path);
      }
      if (links.size >= maxLinks) break;
    } catch {
      // skip invalid URLs
    }
  }

  return [...links];
}

/** Score how likely a page is to contain happy hour or other recurring specials. */
export function scoreHappyHourPage(url, html, text) {
  let score = 0;
  const lowerUrl = url.toLowerCase();
  const lowerText = String(text || '').toLowerCase();
  const lowerHtml = String(html || '').toLowerCase();
  const hasHappyHour = /happy\s*hour/i.test(lowerText);
  const hasSpecialsLanguage = SPECIALS_TEXT_RE.test(lowerText);
  const isMenuUrl = urlLooksLikeMenuPage(url);

  if (!hasHappyHour && !hasSpecialsLanguage && !/\$\s?\d/.test(lowerText) && !isMenuUrl) return 0;

  if (/specials[-/ ]*happy[-/ ]*hour|happy[-/ ]*hour/i.test(lowerUrl)) score += 50;
  else if (/happy[-/ ]*hour|happyhour/i.test(lowerUrl)) score += 40;
  else if (/\/specials/i.test(lowerUrl)) score += 25;
  else if (/taco|wine-?wed|thirsty|industry/i.test(lowerUrl)) score += 20;
  else if (isMenuUrl) score += 18;
  else if (/\/(?:drinks|bar)/i.test(lowerUrl)) score += 10;

  if (hasHappyHour) score += 12;
  if (/<h[1-3][^>]*>\s*happy\s*hour/i.test(lowerHtml)) score += 20;
  if (/<h[1-3][^>]*>\s*(?:daily |drink )?specials?/i.test(lowerHtml)) score += 12;
  if (/\$\s?\d/.test(lowerText)) score += 15;
  if (/half[- ]?price|\d+%\s*off|\d+\s*for\s*\$/i.test(lowerText)) score += 15;
  if (/discounted|taco\s+tues|wine\s+wednes|industry\s+night/i.test(lowerText)) score += 10;

  const hhIndex = lowerText.indexOf('happy hour');
  if (hhIndex !== -1) {
    const near = lowerText.slice(hhIndex, hhIndex + 200);
    if (/\d{1,2}(?::\d{2})?\s*(?:am|pm)/i.test(near)) score += 15;
  }

  if (/lunch menu|breakfast|brunch/i.test(lowerText) && !/happy\s*hour|specials/i.test(lowerUrl)) score -= 10;

  return score;
}

/** Extract location blocks (address + optional label) from HTML. */
export function extractLocationsFromHtml(html) {
  const locations = [];
  const seen = new Set();

  const addressPatterns = [
    /(\d{1,5}\s+[A-Za-z0-9\s.'-]+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Way|Ln|Lane|Ct|Court)(?:\s*(?:#|Ste|Suite)\s*\w+)?)/gi,
  ];

  for (const pattern of addressPatterns) {
    for (const match of html.matchAll(pattern)) {
      const address = match[1].replace(/\s+/g, ' ').trim();
      const key = address.toLowerCase();
      if (seen.has(key) || address.length < 8) continue;
      seen.add(key);

      const contextStart = Math.max(0, match.index - 300);
      const context = html.slice(contextStart, match.index + address.length + 200);
      const labelMatch = context.match(/<h[2-4][^>]*>([^<]{3,60})<\/h[2-4]>/i);
      locations.push({
        address,
        label: labelMatch ? htmlToText(labelMatch[1]) : null,
      });
    }
  }

  return locations;
}

/** Find internal links whose URL or anchor text suggests happy hour / specials content. */
export function discoverHappyHourLinksFromHtml(html, origin, maxLinks = 40) {
  const scored = new Map();
  const originUrl = new URL(origin);

  const add = (href, score) => {
    if (!href || href.startsWith('#')) return;
    try {
      const url = new URL(href, origin);
      if (!sameSiteHost(url.href, originUrl.href)) return;
      if (SKIP_LINK_RE.test(url.pathname)) return;
      if (isMenuItemDetailUrl(url.href)) return;
      const keepHash = /#menu=/i.test(url.hash) || /happy|golden|special/i.test(url.hash);
      if (!keepHash) url.hash = '';
      const key = url.pathname + url.search + (keepHash ? url.hash : '');
      scored.set(key, Math.max(scored.get(key) || 0, score));
    } catch {
      // skip invalid URLs
    }
  };

  for (const match of html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1].trim();
    if (/^(?:mailto:|tel:|javascript:)/i.test(href)) continue;
    const anchor = htmlToText(match[2]).toLowerCase();
    const combined = `${href} ${anchor}`.toLowerCase();
    const isMenu = MENU_PATH_RE.test(href) || MENU_ANCHOR_RE.test(anchor);
    const isLocator = LOCATOR_PATH_RE.test(href) || LOCATOR_ANCHOR_RE.test(anchor);
    if (!HH_LINK_RE.test(combined) && !HH_URL_RE.test(href) && !isMenu && !isLocator) continue;

    if (isLocator && !isMenu && !HH_LINK_RE.test(combined)) {
      add(href, 6);
      if (scored.size >= maxLinks) break;
      continue;
    }

    let score = 10;
    if (/happy\s*hour|happyhour|golden\s*hour/.test(combined)) score += 40;
    if (/specials?\s*\/\s*happy\s*hour|specials.*happy\s*hour/.test(combined)) score += 50;
    if (/\/specials|specials--happy-hour/i.test(href)) score += 30;
    if (/promotions?|offers?/.test(combined)) score += 15;
    if (isMenu) score += 18;
    add(href, score);
    if (scored.size >= maxLinks) break;
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([path, score]) => ({ path, score }));
}

export function isHomepageUrl(url, origin) {
  try {
    const page = new URL(url, origin);
    const home = new URL(origin);
    return page.origin === home.origin && (page.pathname === '/' || page.pathname === '');
  } catch {
    return false;
  }
}

function listingPathname(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return '';
  }
}

export function isListedWebsiteUrl(url, websiteUri) {
  try {
    const page = new URL(url);
    const listed = new URL(websiteUri);
    return page.origin === listed.origin && listingPathname(page) === listingPathname(listed);
  } catch {
    return false;
  }
}

export function buildCandidateUrls(origin, discoveredLinks = [], options = {}) {
  const includeHomepage = options.includeHomepage ?? true;
  const sitemapOnly = options.sitemapOnly ?? false;
  const scored = new Map();

  const addPath = (path, score) => {
    const url = path.startsWith('http') ? path : `${origin}${path.startsWith('/') ? path : `/${path}`}`;
    scored.set(url, Math.max(scored.get(url) || 0, score));
  };

  for (const entry of discoveredLinks) {
    if (typeof entry === 'string') {
      if (HH_URL_RE.test(entry)) addPath(entry, 25);
      continue;
    }
    addPath(entry.path, entry.score);
  }

  if (options.priorityUrl) {
    addPath(options.priorityUrl, 60);
  }

  // Guess only when the site published nothing we could follow. A strong
  // sitemap (`sitemapOnly`) is itself a full list of the site's pages, so a
  // path missing from it does not exist.
  const foundRealLinks = [...scored.values()].some((score) => score >= EVIDENCE_SCORE);
  if (!foundRealLinks && !sitemapOnly) {
    for (const row of CONVENTIONAL_CANDIDATE_PATHS) addPath(row.path, row.score);
    // Last, and below every specials/menu guess: a locator page is worth a
    // fetch only because multi-location brands sometimes publish the offer
    // nowhere else, and it costs a page out of a small budget.
    for (const row of LOCATOR_CANDIDATE_PATHS) addPath(row.path, row.score);
  }

  // Above the guesses: the homepage is the one page we know exists.
  if (includeHomepage) addPath(HOMEPAGE_PATH, 18);

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url);
}

function contentToCandidate(url, content, score, source) {
  return {
    url,
    kind: content.kind || 'html',
    html: content.html || '',
    text: content.text || '',
    bytes: content.bytes || null,
    contentType: content.contentType || '',
    score,
    source,
    blocked: Boolean(content.blocked),
    ok: Boolean(content.ok),
  };
}

/**
 * Inventory a website once. Callers map the same pages onto each location
 * instead of re-crawling a brand domain per venue.
 *
 * Returns { origin, sitemapFound, blocked, homepage, candidates, social }.
 */
export async function inventoryWebsite(websiteUri, options = {}) {
  const {
    delayMs = 400,
    maxPages = 6,
    maxFetches = 8,
    fetchImpl = fetch,
    minHappyHourScore = 8,
    priorityUrl = null,
    fetchSocial = true,
    venueContext = null,
  } = options;

  // One locator lookup per domain inventory, like every other source here.
  let locatorRecords = [];
  const locatorApisTried = new Set();

  if (!websiteUri || !/^https?:\/\//i.test(websiteUri)) {
    return { origin: null, sitemapFound: false, blocked: false, homepage: null, candidates: [], social: [] };
  }

  let origin;
  try {
    origin = new URL(websiteUri).origin;
  } catch {
    return { origin: null, sitemapFound: false, blocked: false, homepage: null, candidates: [], social: [] };
  }

  const { candidates: sitemapCandidates, sitemapFound } = await discoverFromSitemap(websiteUri, { fetchImpl });
  const sitemapScores = new Map(sitemapCandidates.map((c) => [c.url, c.score]));
  const strongSitemap = sitemapCandidates.some((c) => c.score >= 35);

  const discovered = sitemapCandidates.map((c) => {
    const parsed = new URL(c.url);
    return { path: parsed.pathname + parsed.search, score: c.score };
  });

  try {
    const listed = new URL(websiteUri);
    if (listed.pathname && listed.pathname !== '/') {
      discovered.unshift({ path: listed.pathname + listed.search, score: 40 });
    }
  } catch {
    // ignore
  }

  let homepageContent = await fetchPageContent(websiteUri, fetchImpl, { waitMode: 'discovery' });
  if (!homepageContent?.cached) await sleep(delayMs);

  const homepageHtml = homepageContent?.html || '';
  const homepageBlocked = Boolean(homepageContent?.blocked) || isCloudflareChallenge(homepageHtml);
  let branchPriorityUrl = null;
  if (homepageHtml && !homepageBlocked) {
    discovered.push(...discoverHappyHourLinksFromHtml(homepageHtml, origin));
    if (/\bpopmenu\b/i.test(homepageHtml)) {
      discovered.push({ path: '/menu#menu=happy-hour', score: 52 });
      discovered.push({ path: '/menu', score: 44 });
    }
    for (const link of discoverInternalLinks(homepageHtml, origin, 40)) {
      const linkUrl = `${origin}${link.startsWith('/') ? link : `/${link}`}`;
      if (isMenuItemDetailUrl(linkUrl)) continue;
      if (isMediaUrl(linkUrl)) {
        const mediaScore = scoreMediaUrl(linkUrl);
        if (mediaScore > 0) discovered.push({ path: link, score: mediaScore });
      } else if (HH_URL_RE.test(link) || MENU_PATH_RE.test(link)) {
        discovered.push({ path: link, score: MENU_PATH_RE.test(link) ? 28 : 20 });
      }
    }

    // Branch location pages rarely mention "happy hour" in the anchor, but that
    // is where chain brands publish the HH PDF and gallery. Prefer this venue's
    // own page when we can identify it.
    if (venueContext) {
      const branchLinks = discoverBranchLocationLinksFromHtml(homepageHtml, origin, venueContext);
      const absoluteBranches = [];
      for (const link of branchLinks) {
        const linkUrl = `${origin}${link.path.startsWith('/') ? link.path : `/${link.path}`}`;
        if (conflictsWithVenue(linkUrl, venueContext)) continue;
        const locationScore = scoreLocationUrl(linkUrl, venueContext);
        if (locationScore <= 0) continue;
        discovered.push({ path: link.path, score: 48 + locationScore });
        absoluteBranches.push(linkUrl);
      }
      branchPriorityUrl = pickLocationPage(
        [websiteUri, priorityUrl, ...absoluteBranches].filter(Boolean),
        venueContext
      )?.url || null;
    }
  }

  const effectivePriority =
    priorityUrl
    || branchPriorityUrl
    || (sitemapCandidates[0]?.score >= 35 ? sitemapCandidates[0].url : null);

  const candidateUrls = buildCandidateUrls(origin, discovered, {
    includeHomepage: true,
    sitemapOnly: strongSitemap && !priorityUrl,
    priorityUrl: effectivePriority,
  });

  const fetchLimit = maxFetches ?? 8;
  const results = [];
  const fetched = new Set();
  const queue = candidateUrls.slice(0, fetchLimit + 2);
  let sawBlock = homepageBlocked && !homepageContent?.ok;

  // The homepage is the only page we know exists, and it's already fetched, so
  // mine it for menu documents before spending the budget on guessed paths.
  // Small single-page sites (a splash screen whose only content is a linked
  // menu PDF, often on a CDN host) otherwise 404 through every guess and get
  // reported as no_candidates with their menu one href away.
  if (homepageHtml && !homepageBlocked) {
    const homepageMedia = discoverSpecialsMedia(homepageHtml, websiteUri, 6);
    for (const media of [...homepageMedia].reverse()) {
      if (!queue.includes(media.url)) queue.unshift(media.url);
    }
  }

  while (queue.length && fetched.size < fetchLimit + 8) {
    const url = queue.shift();
    if (fetched.has(url)) continue;
    if (isMenuItemDetailUrl(url)) continue;
    const htmlCount = results.filter((row) => row.kind === 'html').length;
    const mediaCount = results.filter((row) => row.kind === 'pdf' || row.kind === 'image').length;
    if (isMediaUrl(url) ? mediaCount >= 6 : htmlCount >= maxPages) continue;
    fetched.add(url);

    const sitemapScore = sitemapScores.get(url) || (isMediaUrl(url) ? scoreMediaUrl(url) : 0);

    try {
      const waitMode =
        isHomepageUrl(url, origin) ? 'discovery' :
        urlLooksLikeHappyHourPage(url) || sitemapScore >= 25 || isMediaUrl(url) ? 'content' : 'discovery';
      const content =
        (isHomepageUrl(url, origin) || isListedWebsiteUrl(url, websiteUri)) && homepageContent
          ? homepageContent
          : await fetchPageContent(url, fetchImpl, { waitMode });
      if (!content?.cached) await sleep(delayMs);

      if (content?.blocked || (content?.html && isCloudflareChallenge(content.html))) {
        sawBlock = true;
        continue;
      }
      if (!content?.ok) continue;

      if (content.kind === 'pdf' || content.kind === 'image') {
        const score = Math.max(scoreMediaUrl(url), sitemapScore);
        if (score <= 0) continue;
        results.push(contentToCandidate(url, content, score, sitemapScore ? 'sitemap' : 'media'));
        continue;
      }

      // Before scoring: a locator page scores zero on happy-hour text because
      // the widget renders client-side, so the offer never appears in this
      // HTML — only the script tag naming the account does. Reading it here
      // means the page still pays off even though it is about to be dropped
      // as a text candidate.
      if (!locatorRecords.length && content.html) {
        for (const api of detectLocatorApis(content.html, venueContext || {})) {
          if (locatorApisTried.has(api.url)) continue;
          locatorApisTried.add(api.url);
          const records = await fetchLocatorRecords(api);
          if (records.length) {
            locatorRecords = records;
            break;
          }
        }
      }

      const text = content.text || htmlToText(content.html || '');
      let score = scoreHappyHourPage(url, content.html, text);
      if (score <= 0 && sitemapScore >= 20) score = sitemapScore;

      if (isHomepageUrl(url, origin)) {
        for (const link of discoverHappyHourLinksFromHtml(content.html || '', origin)) {
          const linkUrl = `${origin}${link.path.startsWith('/') ? link.path : `/${link.path}`}`;
          if (isMenuItemDetailUrl(linkUrl)) continue;
          if (!fetched.has(linkUrl) && !queue.includes(linkUrl)) queue.unshift(linkUrl);
        }
        if (venueContext) {
          for (const link of discoverBranchLocationLinksFromHtml(content.html || '', origin, venueContext)) {
            const linkUrl = `${origin}${link.path.startsWith('/') ? link.path : `/${link.path}`}`;
            if (conflictsWithVenue(linkUrl, venueContext)) continue;
            if (scoreLocationUrl(linkUrl, venueContext) <= 0) continue;
            if (!fetched.has(linkUrl) && !queue.includes(linkUrl)) queue.unshift(linkUrl);
          }
        }
      }

      const locationMatchScore = venueContext ? scoreLocationUrl(url, venueContext) : 0;
      const corePage = isCoreCandidateUrl(url)
        || urlLooksLikeMenuPage(url)
        || isListedWebsiteUrl(url, websiteUri)
        || locationMatchScore > 0;
      if (!corePage) {
        if (score < minHappyHourScore && sitemapScore < 20) continue;
        if (score <= 0) continue;
      } else if (score <= 0) {
        score = Math.max(
          sitemapScore,
          locationMatchScore > 0 ? 22 + locationMatchScore : 0,
          urlLooksLikeMenuPage(url) ? 18 : 12
        );
      }

      results.push(contentToCandidate(url, { ...content, text }, score, sitemapScore ? 'sitemap' : 'crawl'));

      for (const media of discoverSpecialsMedia(content.html || '', url, 8)) {
        if (fetched.has(media.url) || queue.includes(media.url)) continue;
        if (media.kind === 'pdf' || media.score >= 40) queue.unshift(media.url);
        else queue.push(media.url);
      }

      const followLinks = urlLooksLikeHappyHourPage(url)
        || urlLooksLikeMenuPage(url)
        || isHomepageUrl(url, origin)
        || locationMatchScore > 0
        || (!strongSitemap && results.length <= 2);
      if (followLinks) {
        for (const link of discoverHappyHourLinksFromHtml(content.html || '', origin)) {
          const linkUrl = `${origin}${link.path.startsWith('/') ? link.path : `/${link.path}`}`;
          if (isMenuItemDetailUrl(linkUrl)) continue;
          if (!fetched.has(linkUrl) && !queue.includes(linkUrl)) queue.unshift(linkUrl);
        }
      }
    } catch {
      // try next URL
    }
  }

  if (
    !results.length
    && homepageContent?.ok
    && homepageHtml
    && !homepageBlocked
    && SPECIALS_TEXT_RE.test(homepageContent.text || '')
  ) {
    results.push(contentToCandidate(
      websiteUri,
      homepageContent,
      5,
      'homepage-fallback'
    ));
  }

  const social = [];
  if (fetchSocial && homepageHtml && !homepageBlocked) {
    for (const account of discoverSocialLinks(homepageHtml, websiteUri).slice(0, 2)) {
      try {
        const content = await fetchPageContent(account.url, fetchImpl, { waitMode: 'discovery' });
        if (!content?.cached) await sleep(delayMs);
        if (!content?.ok || content.blocked) {
          social.push({ ...account, fetchStatus: content?.blocked ? 'blocked' : 'failed' });
          continue;
        }
        const text = socialSnippetFromHtml(content.html || '');
        social.push({ ...account, text, fetchStatus: text ? 'ok' : 'empty' });
      } catch {
        social.push({ ...account, fetchStatus: 'failed' });
      }
    }
  }

  return {
    origin,
    sitemapFound: Boolean(sitemapFound),
    blocked: sawBlock && !results.length,
    homepage: homepageContent
      ? { url: websiteUri, ok: Boolean(homepageContent.ok), blocked: homepageBlocked, status: homepageContent.status }
      : null,
    candidates: results.sort((a, b) => b.score - a.score),
    social,
    locatorRecords,
  };
}

/**
 * Crawl a venue website for happy-hour-related pages.
 * Returns HTML candidates [{ url, html, text, score }] sorted by score.
 */
export async function crawlForHappyHourPages(websiteUri, options = {}) {
  const inventory = await inventoryWebsite(websiteUri, {
    ...options,
    fetchSocial: false,
    maxPages: options.maxPages ?? 12,
  });
  return inventory.candidates.filter((page) => page.kind === 'html');
}

/** Build location hint tokens from a venue for section matching. */
export function buildVenueLocationHints(venue = {}) {
  const hints = new Set();
  const add = (value) => {
    const v = String(value || '').toLowerCase().trim();
    if (v.length >= 4) hints.add(v);
  };

  add(venue.neighborhood);
  if (venue.address) {
    const street = venue.address.match(/^(\d+\s+[^,]+)/);
    if (street) add(street[1]);
    const parts = venue.address.split(',').map((p) => p.trim());
    for (const part of parts) add(part);
  }
  if (venue.name) {
    for (const word of venue.name.split(/\s+/)) {
      if (word.length >= 5) add(word);
    }
  }

  return [...hints];
}

/** Return true if text section appears relevant to this venue's location. */
export function sectionMatchesVenue(text, venueHints = []) {
  if (!venueHints.length) return true;
  const lower = text.toLowerCase();
  return venueHints.some((hint) => lower.includes(hint));
}
