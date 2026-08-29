import { isCloudflareChallenge } from './website-crawl.mjs';
import { readPageCache, writePageCache } from './page-cache.mjs';
import { applySniffedMedia, looksLikeBinaryResponse, mediaKindFromContentType } from './media.mjs';

const MAX_TEXT_BYTES = 500_000;
const MAX_BINARY_BYTES = 4_500_000;

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headersFrom(response) {
  const contentType = response.headers?.get?.('content-type') || 'text/html';
  return { get: () => contentType };
}

function toFetchResponse(entry) {
  const bytes = entry.bytes || null;
  return {
    ok: Boolean(entry.ok),
    status: entry.status || (entry.ok ? 200 : 0),
    cached: Boolean(entry.cached),
    kind: entry.kind || 'html',
    blocked: Boolean(entry.blocked),
    reason: entry.reason || null,
    headers: headersFrom({ headers: { get: () => entry.contentType || 'text/html' } }),
    text: async () => entry.html || entry.text || '',
    visibleText: async () => entry.text || '',
    arrayBuffer: async () => bytes || new Uint8Array(),
  };
}

async function plainFetch(url, requestInit = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,text/xml,application/xml,application/pdf,image/*,*/*',
        ...(requestInit.headers || {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    const contentType = response.headers.get('content-type') || '';
    const blockedStatus = response.status === 403 || response.status === 429;
    const binary = looksLikeBinaryResponse(url, contentType);

    if (binary) {
      const buf = Buffer.from(await response.arrayBuffer());
      const kind = mediaKindFromContentType(contentType, url) || 'pdf';
      const tooLarge = buf.length > MAX_BINARY_BYTES;
      return applySniffedMedia({
        url,
        ok: response.ok && !tooLarge && buf.length > 0,
        method: 'fetch',
        status: response.status,
        contentType,
        kind,
        html: '',
        text: '',
        bytes: tooLarge ? null : buf,
        blocked: blockedStatus,
        reason: tooLarge ? 'too_large' : blockedStatus ? (response.status === 429 ? 'challenge_429' : 'cloudflare') : response.ok ? null : `http_${response.status}`,
      });
    }

    const body = await response.text();
    const html = body.slice(0, MAX_TEXT_BYTES);
    const text = stripHtml(html);
    const blocked = isCloudflareChallenge(html) || blockedStatus;
    const looksUseful =
      /xml|html|plain|javascript/i.test(contentType)
      || /<\?xml|<html|<urlset|<sitemapindex/i.test(html.slice(0, 400));
    return {
      url,
      ok: response.ok && looksUseful && !blocked,
      method: 'fetch',
      status: response.status,
      contentType,
      kind: 'html',
      html,
      text,
      blocked,
      reason: blocked ? (response.status === 429 ? 'challenge_429' : 'cloudflare') : response.ok ? null : `http_${response.status}`,
    };
  } catch (error) {
    return {
      url,
      ok: false,
      method: 'fetch',
      status: 0,
      kind: 'html',
      html: '',
      text: '',
      blocked: false,
      reason: error.name === 'TimeoutError' ? 'timeout' : 'network',
    };
  }
}

async function browserToEntry(url, browserFetch, requestInit) {
  const response = await browserFetch(url, requestInit);
  const contentType = response.headers?.get?.() || 'text/html';
  if (looksLikeBinaryResponse(url, contentType) && typeof response.arrayBuffer === 'function') {
    const buf = Buffer.from(await response.arrayBuffer());
    const kind = mediaKindFromContentType(contentType, url) || 'pdf';
    return applySniffedMedia({
      url,
      ok: Boolean(response.ok) && buf.length > 0 && buf.length <= MAX_BINARY_BYTES,
      method: 'browser',
      status: response.status || (response.ok ? 200 : 0),
      contentType,
      kind,
      html: '',
      text: '',
      bytes: buf.length <= MAX_BINARY_BYTES ? buf : null,
      blocked: false,
      reason: null,
    });
  }

  const html = await response.text();
  const text = typeof response.visibleText === 'function' ? await response.visibleText() : html;
  const blocked = isCloudflareChallenge(html);
  return {
    url,
    ok: Boolean(response.ok) && !blocked,
    method: 'browser',
    status: response.status || (response.ok ? 200 : 0),
    contentType,
    kind: 'html',
    html,
    text,
    blocked,
    reason: blocked ? 'cloudflare' : null,
  };
}

function isSpaRestaurantHost(url) {
  try {
    return /(?:^|\.)(?:square\.site|toasttab\.com|popmenu\.com|getbento\.com)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function looksLikeJsMenuShell(entry) {
  const html = entry.html || '';
  const visible = stripHtml(entry.text || html);
  if (/load more content/i.test(visible)) return true;
  if (/\bpopmenu\b/i.test(html) && !/\$\s?\d/.test(visible)) return true;
  return false;
}

function needsBrowser(entry) {
  if (entry.kind && entry.kind !== 'html') return false;
  if (isSpaRestaurantHost(entry.url)) return true;
  if (looksLikeJsMenuShell(entry)) return true;
  if (entry.blocked) return true;
  if (!entry.ok) {
    return entry.reason === 'timeout'
      || entry.status === 401
      || entry.status === 403
      || entry.status === 429
      || entry.status === 503;
  }
  return stripHtml(entry.text || entry.html || '').length < 500 && !/<\?xml|<urlset/i.test(entry.html || '');
}

function shouldCache(entry) {
  if (entry.method !== 'browser' && (entry.status === 429 || entry.blocked)) return false;
  return true;
}

function limitCalls(fn, max) {
  if (!fn || max < 1) return fn;
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { args, resolve, reject } = queue.shift();
    Promise.resolve(fn(...args))
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  };
  return (...args) =>
    new Promise((resolve, reject) => {
      queue.push({ args, resolve, reject });
      runNext();
    });
}

/**
 * Fetch implementation for the crawler: disk cache, then plain HTTP, then
 * Playwright only when the cheap HTML path clearly failed.
 */
export function createCachedFetch({ browserFetch = null, refresh = false, browserConcurrency = 3 } = {}) {
  const gatedBrowser = limitCalls(browserFetch, browserConcurrency);
  return async function cachedFetch(url, requestInit = {}) {
    if (!refresh) {
      const hit = readPageCache(url);
      if (hit) return toFetchResponse({ ...hit, cached: true });
    }

    let entry = await plainFetch(url, requestInit);
    if (needsBrowser(entry) && gatedBrowser) {
      try {
        entry = await browserToEntry(url, gatedBrowser, requestInit);
      } catch (error) {
        entry = { ...entry, reason: entry.reason || error.message, method: 'browser' };
      }
    }

    if (shouldCache(entry)) writePageCache(url, entry);
    return toFetchResponse({ ...entry, cached: false });
  };
}

export async function mapPool(items, concurrency, fn) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
