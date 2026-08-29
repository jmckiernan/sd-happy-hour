/**
 * Discover happy-hour / specials candidate pages via sitemap.xml (fast, plain HTTP).
 */

import { isCloudflareChallenge } from './cloudflare-challenge.mjs';
import { classifyUrl, scoreMediaUrl } from './media.mjs';

const USER_AGENT = 'SDHappyHoursImport/1.0 (+https://sdhappyhours.com)';

function sameHostname(urlA, urlB) {
  try {
    const normalize = (h) => h.replace(/^www\./i, '').toLowerCase();
    return normalize(new URL(urlA).hostname) === normalize(new URL(urlB).hostname);
  } catch {
    return false;
  }
}

/** Extract <loc> URLs from sitemap XML. */
export function parseSitemapLocs(xml) {
  if (!xml || isCloudflareChallenge(xml)) return [];
  const locs = [];
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    locs.push(match[1].trim());
  }
  return locs;
}

export function isSitemapIndex(xml) {
  return typeof xml === 'string' && /<sitemapindex/i.test(xml);
}

/** Score a sitemap URL for happy-hour / specials relevance. */
export function scoreSitemapUrl(url) {
  const lower = String(url || '').toLowerCase();
  if (/privacy|terms|contact|career|blog|event|calendar|gallery|gift|cart|login|account/i.test(lower)) {
    return 0;
  }
  const kind = classifyUrl(url);
  if (kind === 'pdf' || kind === 'image') return scoreMediaUrl(url);
  if (/specials[-/ ]*happy|happy[-/ ]*hours?[-/ ]*special/i.test(lower)) return 60;
  if (/happy[-/ ]*hours?|happyhour/i.test(lower)) return 50;
  if (/\/specials?\/?$/.test(lower) || /\/specials\//.test(lower)) return 35;
  if (/promotions?|offers?/.test(lower)) return 25;
  if (/taco|wine-?wed|thirsty|industry.?night|daily.?special/i.test(lower)) return 22;
  if (/\/(?:drinks|cocktails|bar)\/?$/.test(lower)) return 15;
  if (/\/menus?\/?$/.test(lower)) return 20;
  return 0;
}

export function rankSitemapUrls(urls, origin) {
  const ranked = [];
  const seen = new Set();

  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (!sameHostname(url, origin)) continue;
      if (/\.(?:svg|zip|mp4|webm)(?:\?|$)/i.test(parsed.pathname)) continue;
      parsed.hash = '';
      const key = parsed.href;
      if (seen.has(key)) continue;
      seen.add(key);
      const score = scoreSitemapUrl(key);
      if (score <= 0) continue;
      ranked.push({ url: key, score, source: 'sitemap' });
    } catch {
      // skip invalid URLs
    }
  }

  return ranked.sort((a, b) => b.score - a.score);
}

async function fetchSitemapText(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml,text/xml,text/plain,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
      sdhhWaitMode: 'discovery',
    });
    if (!response) return null;
    const text = await response.text();
    if (isCloudflareChallenge(text)) return null;
    if (!/<\?xml|<urlset|<sitemapindex/i.test(text)) {
      if (!response.ok) return null;
    }
    return text.slice(0, 2_000_000);
  } catch {
    return null;
  }
}

/**
 * Discover HH candidate URLs from robots.txt + sitemap(s).
 * Returns { candidates: [{ url, score, source }], sitemapFound }.
 */
export async function discoverFromSitemap(websiteUri, options = {}) {
  const { fetchImpl = fetch, maxSitemaps = 6, maxCandidates = 20 } = options;

  let origin;
  try {
    const parsed = new URL(websiteUri);
    origin = parsed.origin;
    // Prefer HTTPS for sitemap fetches when site supports both.
    if (parsed.protocol === 'http:') {
      origin = `https://${parsed.hostname}`;
    }
  } catch {
    return { candidates: [], sitemapFound: false };
  }

  const sitemapQueue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  if (websiteUri.startsWith('http://')) {
    try {
      const httpOrigin = new URL(websiteUri).origin;
      sitemapQueue.push(`${httpOrigin}/sitemap.xml`, `${httpOrigin}/sitemap_index.xml`);
    } catch {
      // ignore
    }
  }
  const visited = new Set();
  const pageUrls = [];
  let sitemapFound = false;

  const robots = await fetchSitemapText(`${origin}/robots.txt`, fetchImpl);
  if (robots && !isCloudflareChallenge(robots)) {
    for (const match of robots.matchAll(/^Sitemap:\s*(\S+)/gim)) {
      const loc = match[1].trim();
      if (!sitemapQueue.includes(loc)) sitemapQueue.unshift(loc);
    }
  }

  while (sitemapQueue.length && visited.size < maxSitemaps) {
    const sitemapUrl = sitemapQueue.shift();
    if (visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    const xml = await fetchSitemapText(sitemapUrl, fetchImpl);
    if (!xml) continue;
    sitemapFound = true;

    if (isSitemapIndex(xml)) {
      for (const loc of parseSitemapLocs(xml)) {
        if (!visited.has(loc)) sitemapQueue.push(loc);
      }
    } else {
      pageUrls.push(...parseSitemapLocs(xml));
    }
  }

  const candidates = rankSitemapUrls(pageUrls, origin).slice(0, maxCandidates);
  return { candidates, sitemapFound };
}
