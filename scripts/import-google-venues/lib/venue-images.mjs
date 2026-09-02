import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { sniffMediaFromBytes } from './media.mjs';
import { placesMentioned } from './location-page.mjs';

const REJECT_URL_RE = /(?:^|[/_.-])(?:logo|icon|favicon|sprite|avatar|placeholder|loading|spinner|badge|wordmark|brandmark|payment|footer|header-logo|app-store|google-play)(?:[/_.-]|$)/i;
const REJECT_TEXT_RE = /\b(?:logo|icon|wordmark|avatar|placeholder|loading|spinner|badge|gift card|app store|google play)\b/i;
const POSITIVE_TEXT_RE = /\b(?:hero|restaurant|bar|interior|exterior|patio|dining|cocktail|food|venue|location|gallery|hospitality)\b/i;
const SOCIAL_HOST_RE = /(?:^|\.)(?:instagram\.com|facebook\.com|fbcdn\.net|twimg\.com|tiktokcdn\.com)$/i;
const TRACKING_HOST_RE = /(?:^|\.)(?:doubleclick\.net|google-analytics\.com|googletagmanager\.com)$/i;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SOURCE_SCORES = {
  og_image: 74,
  twitter_image: 70,
  json_ld: 68,
  image_src: 64,
  hero_img: 58,
  page_img: 36,
  css_background: 32,
};

function decodeEntities(value = '') {
  return String(value)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x2f;/gi, '/')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function attr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\s${escaped}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, 'i'));
  return decodeEntities(match?.[1] || match?.[2] || '').trim();
}

function metaContent(html, key, value) {
  for (const match of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (attr(tag, key).toLowerCase() !== value.toLowerCase()) continue;
    const content = attr(tag, 'content');
    if (content) return content;
  }
  return '';
}

function absoluteImageUrl(raw, pageUrl) {
  const cleaned = decodeEntities(raw).trim().replace(/^['"]|['"]$/g, '');
  if (!cleaned || /^(?:data|blob|javascript):/i.test(cleaned)) return null;
  try {
    const url = new URL(cleaned, pageUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (url.pathname.toLowerCase().endsWith('.svg')) return null;
    if (TRACKING_HOST_RE.test(url.hostname)) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function bestSrcsetUrl(value, pageUrl) {
  const choices = String(value || '')
    .split(',')
    .map((item) => {
      const [raw, descriptor = ''] = item.trim().split(/\s+/);
      const weight = descriptor.endsWith('w') ? Number(descriptor.slice(0, -1)) : descriptor.endsWith('x') ? Number(descriptor.slice(0, -1)) * 1000 : 0;
      return { url: absoluteImageUrl(raw, pageUrl), weight: Number.isFinite(weight) ? weight : 0 };
    })
    .filter((row) => row.url)
    .sort((a, b) => b.weight - a.weight);
  return choices[0]?.url || null;
}

function venueTokens(venue = {}) {
  return String(venue.name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !['restaurant', 'kitchen', 'company'].includes(word));
}

function candidateScore(candidate, venue = {}) {
  let score = SOURCE_SCORES[candidate.source] || 0;
  const haystack = `${candidate.url} ${candidate.alt || ''} ${candidate.className || ''}`.toLowerCase();
  if (REJECT_URL_RE.test(candidate.url) || REJECT_TEXT_RE.test(haystack)) score -= 100;
  if (POSITIVE_TEXT_RE.test(haystack)) score += 12;
  if (candidate.declaredWidth >= 1200) score += 8;
  if (candidate.declaredHeight >= 650) score += 5;
  if (candidate.declaredWidth && candidate.declaredHeight && candidate.declaredWidth / candidate.declaredHeight >= 1.35) score += 5;
  if (venueTokens(venue).some((token) => haystack.includes(token))) score += 8;
  // Branch galleries often encode the neighborhood in the filename (bg_bonita1.jpg).
  const placeHints = placesMentioned(`${venue.neighborhood || ''} ${venue.address || ''}`);
  if (placeHints.some((place) => haystack.replace(/[^a-z0-9]+/g, '').includes(place.replace(/\s+/g, '')))) {
    score += 24;
  }
  try {
    if (SOCIAL_HOST_RE.test(new URL(candidate.url).hostname)) score -= 18;
  } catch {
    score -= 100;
  }
  return score;
}

function addCandidate(rows, seen, raw, pageUrl, source, extra = {}, venue = {}) {
  const url = absoluteImageUrl(raw, pageUrl);
  if (!url || seen.has(url)) return;
  const candidate = {
    url,
    pageUrl,
    source,
    alt: String(extra.alt || '').trim(),
    className: String(extra.className || '').trim(),
    declaredWidth: Number(extra.declaredWidth) || 0,
    declaredHeight: Number(extra.declaredHeight) || 0,
  };
  candidate.score = candidateScore(candidate, venue);
  if (candidate.score <= 0) return;
  seen.add(url);
  rows.push(candidate);
}

/** Extract and rank possible hero photographs from a venue-owned web page. */
export function discoverVenueImageCandidates(html, pageUrl, venue = {}, max = 20) {
  const rows = [];
  const seen = new Set();
  const body = String(html || '');

  addCandidate(rows, seen, metaContent(body, 'property', 'og:image'), pageUrl, 'og_image', {}, venue);
  addCandidate(rows, seen, metaContent(body, 'property', 'og:image:secure_url'), pageUrl, 'og_image', {}, venue);
  addCandidate(rows, seen, metaContent(body, 'name', 'twitter:image'), pageUrl, 'twitter_image', {}, venue);
  addCandidate(rows, seen, metaContent(body, 'property', 'twitter:image'), pageUrl, 'twitter_image', {}, venue);

  for (const match of body.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/^(?:image_src|preload)$/i.test(attr(tag, 'rel'))) continue;
    if (/^preload$/i.test(attr(tag, 'rel')) && attr(tag, 'as').toLowerCase() !== 'image') continue;
    addCandidate(rows, seen, attr(tag, 'href'), pageUrl, 'image_src', {}, venue);
  }

  // JSON-LD commonly carries the best original asset, but malformed third-party
  // blocks are routine. Pull only image-shaped strings instead of failing the page.
  for (const match of body.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const image of match[1].matchAll(/["'](?:image|contentUrl|thumbnailUrl)["']\s*:\s*(?:\{[^{}]*["']url["']\s*:\s*)?["']([^"']+)["']/gi)) {
      addCandidate(rows, seen, image[1], pageUrl, 'json_ld', {}, venue);
    }
  }

  for (const match of body.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const className = `${attr(tag, 'class')} ${attr(tag, 'id')}`.trim();
    const src = bestSrcsetUrl(attr(tag, 'srcset') || attr(tag, 'data-srcset'), pageUrl)
      || absoluteImageUrl(attr(tag, 'src') || attr(tag, 'data-src') || attr(tag, 'data-lazy-src'), pageUrl);
    const source = /\b(?:hero|masthead|banner|cover|featured)\b/i.test(className) ? 'hero_img' : 'page_img';
    addCandidate(rows, seen, src, pageUrl, source, {
      alt: attr(tag, 'alt'),
      className,
      declaredWidth: attr(tag, 'width'),
      declaredHeight: attr(tag, 'height'),
    }, venue);
  }

  for (const match of body.matchAll(/(?:background(?:-image)?\s*:[^;}{]*url\(|data-(?:background|bg)\s*=\s*["'])([^)'"\s]+)[)'"]?/gi)) {
    addCandidate(rows, seen, match[1], pageUrl, 'css_background', {}, venue);
  }

  return rows.sort((a, b) => b.score - a.score).slice(0, max);
}

export function sniffImageDimensions(bytes, contentType = '') {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (data.length < 12) return null;
  if (contentType === 'image/png' && data.length >= 24) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (contentType === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break;
      const length = data.readUInt16BE(offset + 2);
      if (length < 2) break;
      const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (sof) return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      offset += 2 + length;
    }
  }
  if (contentType === 'image/webp' && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = data.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && data.length >= 30) {
      return {
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
      };
    }
    if (chunk === 'VP8 ' && data.length >= 30 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const normalized = String(address || '').toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc')
    || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff');
}

async function assertPublicUrl(url) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('unsupported_protocol');
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('private_host');
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error('private_host');
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((row) => isPrivateAddress(row.address))) throw new Error('private_host');
}

async function fetchWithSafeRedirects(url, init, fetchImpl) {
  // Tests pass a local fake fetch with no DNS. The public-network guard is for
  // the real downloader, where a compromised venue page could otherwise point
  // the batch process at localhost or a cloud metadata endpoint.
  if (fetchImpl !== globalThis.fetch) return fetchImpl(url, init);
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await assertPublicUrl(current);
    const response = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers?.get?.('location');
    if (!location) return response;
    current = new URL(location, current).href;
  }
  throw new Error('too_many_redirects');
}

async function normalizeVenuePhoto(bytes, contentType, width, height) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const maxWidth = 2400;
  const scale = Math.min(1, maxWidth / width);
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  const image = await loadImage(bytes);
  const canvas = createCanvas(outputWidth, outputHeight);
  const context = canvas.getContext('2d');
  context.fillStyle = '#f5f0e7';
  context.fillRect(0, 0, outputWidth, outputHeight);
  context.drawImage(image, 0, 0, outputWidth, outputHeight);
  // Re-encoding removes EXIF/GPS, ICC/XMP/IPTC, comments and appended payloads
  // from website assets before they enter the repository.
  const normalized = await canvas.encode('jpeg', 86);
  if (!normalized?.length) throw new Error(`normalization_failed_${contentType}`);
  return { bytes: Buffer.from(normalized), contentType: 'image/jpeg', width: outputWidth, height: outputHeight };
}

/** Download one candidate with byte, type, dimension, and aspect-ratio gates. */
export async function fetchVenueImageCandidate(candidate, fetchImpl = fetch, options = {}) {
  const minWidth = Number(options.minWidth) || 1000;
  const minHeight = Number(options.minHeight) || 560;
  const maxBytes = Number(options.maxBytes) || 12 * 1024 * 1024;
  try {
    const response = await fetchWithSafeRedirects(candidate.url, {
      headers: {
        'User-Agent': 'SDHappyHoursImport/1.0 (+https://sdhappyhours.com)',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5',
        Referer: candidate.pageUrl,
      },
      signal: AbortSignal.timeout(25_000),
    }, fetchImpl);
    if (!response?.ok) return { ok: false, reason: `http_${response?.status || 0}` };
    const declaredLength = Number(response.headers?.get?.('content-length')) || 0;
    if (declaredLength > maxBytes) return { ok: false, reason: 'too_large' };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes) return { ok: false, reason: bytes.length ? 'too_large' : 'empty' };
    const sniffed = sniffMediaFromBytes(bytes);
    if (sniffed?.kind !== 'image' || !ALLOWED_TYPES.has(sniffed.mediaType)) return { ok: false, reason: 'unsupported_type' };
    const dimensions = sniffImageDimensions(bytes, sniffed.mediaType);
    if (!dimensions) return { ok: false, reason: 'unknown_dimensions' };
    if (dimensions.width > 8000 || dimensions.height > 8000) return { ok: false, reason: 'too_large_dimensions', ...dimensions };
    if (dimensions.width < minWidth || dimensions.height < minHeight) return { ok: false, reason: 'too_small', ...dimensions };
    const aspectRatio = dimensions.width / dimensions.height;
    if (aspectRatio < 1.15 || aspectRatio > 4.2) return { ok: false, reason: 'bad_aspect_ratio', ...dimensions };
    const normalized = await normalizeVenuePhoto(bytes, sniffed.mediaType, dimensions.width, dimensions.height);
    return {
      ok: true,
      bytes: normalized.bytes,
      contentType: normalized.contentType,
      width: normalized.width,
      height: normalized.height,
      aspectRatio,
      score: candidate.score + (aspectRatio >= 1.4 && aspectRatio <= 2.8 ? 10 : 0),
    };
  } catch (error) {
    return { ok: false, reason: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

export function extensionForImage(contentType) {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  return 'jpg';
}

export function venueImageFilename(venue, contentType) {
  const slug = String(venue.name || 'venue').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `${venue.id}-${slug}-website.${extensionForImage(contentType)}`;
}

export function relativeVenueImagePath(filename) {
  return `/images/venues/${path.basename(filename)}`;
}
