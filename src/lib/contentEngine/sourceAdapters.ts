import type { ContentSource, RawSourceItem } from './types';
import { decodeHtmlEntities, normalizeText, stripHtml } from './normalize';
import { lookup } from 'node:dns/promises';

const USER_AGENT = 'SDHappyHours-ContentEngine/1.0 (+https://happyhoursd.com/about/)';
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface SourceFetchResult {
  items: RawSourceItem[];
  etag?: string | null;
  lastModified?: string | null;
  notModified: boolean;
}

function privateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function privateIp(address: string): boolean {
  const lower = address.toLowerCase();
  if (privateIpv4(lower)) return true;
  if (!lower.includes(':')) return false;
  return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd')
    || /^fe[89ab]/.test(lower) || lower.startsWith('::ffff:127.') || lower.startsWith('::ffff:10.')
    || lower.startsWith('::ffff:192.168.') || lower.startsWith('::ffff:169.254.');
}

export function isSafePublicSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password
      && hostname !== 'localhost' && !hostname.endsWith('.localhost') && !hostname.endsWith('.local')
      && !privateIp(hostname);
  } catch {
    return false;
  }
}

async function assertPublicDestination(value: string): Promise<void> {
  if (!isSafePublicSourceUrl(value)) throw new Error('Source URL must use a public HTTP(S) host.');
  const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '');
  if (privateIp(hostname)) throw new Error('Source URL resolved to a private network.');
  // Literal public IPs need no DNS lookup. Hostnames are checked immediately
  // before the request, and every redirect is checked again.
  if (/^[0-9.]+$/.test(hostname) || hostname.includes(':')) return;
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((result) => privateIp(result.address))) {
    throw new Error('Source URL resolved to a private network.');
  }
}

async function safeFetch(
  initialUrl: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    // Custom fetch implementations are used by unit tests and do not perform
    // network I/O; the production global fetch always gets DNS validation.
    if (fetchImpl === fetch) await assertPublicDestination(currentUrl);
    else if (!isSafePublicSourceUrl(currentUrl)) throw new Error('Source URL must use a public HTTP(S) host.');
    const response = await fetchImpl(currentUrl, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error('Source redirect did not include a destination.');
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new Error(`Source exceeded ${MAX_REDIRECTS} redirects.`);
}

function unCdata(value: string): string {
  return value.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1').trim();
}

function tagValue(block: string, names: string[]): string {
  for (const name of names) {
    const escaped = name.replace(':', '\\:');
    const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
    if (match) return decodeHtmlEntities(unCdata(match[1])).trim();
  }
  return '';
}

function linkValue(block: string): string {
  const atomAlternate = block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i)
    || block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  if (atomAlternate) return decodeHtmlEntities(atomAlternate[1]);
  return tagValue(block, ['link']);
}

function attributeUrls(block: string): string[] {
  const urls: string[] = [];
  const patterns = [
    /<(?:media:content|media:thumbnail|enclosure)\b[^>]*\burl=["']([^"']+)["'][^>]*>/gi,
    /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(block))) urls.push(decodeHtmlEntities(match[1]));
  }
  return [...new Set(urls)];
}

function labeledHtmlValue(html: string, label: string): string {
  const match = html.match(new RegExp(
    `<strong>\\s*${label}\\s*:\\s*<\\/strong>\\s*([\\s\\S]*?)(?:<\\/p>|<br\\s*\\/?>)`, 'i'
  ));
  return match ? stripHtml(match[1]) : '';
}

function pacificWallClockIso(input: {
  year: number; month: number; day: number; hour: number; minute: number;
}): string | null {
  // Convert a San Diego wall clock to an instant without relying on the
  // server's own timezone (Netlify functions run in UTC). Two iterations
  // handle the UTC offset and DST boundary deterministically.
  let instant = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  for (let index = 0; index < 2; index++) {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (type: string) => Number(parts.find((value) => value.type === type)?.value || 0);
    const represented = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'));
    instant += Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute) - represented;
  }
  const result = new Date(instant);
  return Number.isFinite(result.valueOf()) ? result.toISOString() : null;
}

const MONTH_NUMBER: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

function clockParts(value: string): { hour: number; minute: number } | null {
  const cleaned = value.trim().toLowerCase().replace(/\./g, '');
  if (cleaned === 'noon') return { hour: 12, minute: 0 };
  if (cleaned === 'midnight') return { hour: 0, minute: 0 };
  const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3] === 'pm') hour += 12;
  return { hour, minute: Number(match[2] || 0) };
}

function parseLabeledWhen(value: string): { startAt: string | null; endAt: string | null } {
  const match = value.match(
    /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+([A-Za-z]+)\.?\s+(\d{1,2}),\s+(\d{4})(?:,\s+(.+?))?(?:\s+to\s+(.+))?$/i
  );
  if (!match) return { startAt: null, endAt: null };
  const month = MONTH_NUMBER[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month) return { startAt: null, endAt: null };
  const startClock = clockParts(match[4] || '12 am');
  const endClock = match[5] ? clockParts(match[5]) : null;
  if (!startClock) return { startAt: null, endAt: null };
  return {
    startAt: pacificWallClockIso({ year, month, day, ...startClock }),
    endAt: endClock ? pacificWallClockIso({ year, month, day, ...endClock }) : null,
  };
}

function semanticRssFields(descriptionHtml: string) {
  const when = labeledHtmlValue(descriptionHtml, 'When');
  const where = labeledHtmlValue(descriptionHtml, 'Where');
  const cost = labeledHtmlValue(descriptionHtml, 'Cost');
  const age = labeledHtmlValue(descriptionHtml, 'Age limit');
  const description = labeledHtmlValue(descriptionHtml, 'Description');
  const parsedWhen = parseLabeledWhen(when);
  const whereParts = where.split(',').map((part) => normalizeText(part)).filter(Boolean);
  return {
    ...parsedWhen,
    venueName: whereParts[0] || null,
    address: where || null,
    area: whereParts.length > 1 ? whereParts[whereParts.length - 1] : null,
    description: normalizeText([
      description || stripHtml(descriptionHtml),
      cost ? `Cost: ${cost}.` : '',
      age ? `Age limit: ${age}.` : '',
    ].filter(Boolean).join(' ')),
  };
}

function parseFeed(xml: string): RawSourceItem[] {
  const blocks = [
    ...(xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || []),
    ...(xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || []),
  ];
  return blocks.map((block) => {
    const descriptionHtml = tagValue(block, ['content:encoded', 'content', 'description', 'summary']);
    const title = normalizeText(tagValue(block, ['title'])).replace(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\/\d{1,2}:\s*/i, '');
    const url = linkValue(block);
    const externalId = tagValue(block, ['guid', 'id']);
    const publishedAt = tagValue(block, ['pubDate', 'published', 'updated', 'dc:date']);
    const startAt = tagValue(block, ['ev:startdate', 'event:startdate', 'dtstart', 'startDate']);
    const endAt = tagValue(block, ['ev:enddate', 'event:enddate', 'dtend', 'endDate']);
    const semantics = semanticRssFields(descriptionHtml);
    const categoryMatches = [...block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
      .map((match) => normalizeText(unCdata(match[1]))).filter(Boolean);
    return {
      externalId: normalizeText(externalId) || url,
      url,
      title,
      description: semantics.description,
      venueName: semantics.venueName,
      startAt: startAt || semantics.startAt || null,
      endAt: endAt || semantics.endAt || null,
      area: semantics.area,
      address: semantics.address,
      publishedAt: publishedAt || null,
      imageUrls: attributeUrls(`${block}\n${descriptionHtml}`),
      tags: categoryMatches,
      raw: {
        feedTitle: title,
        // Retain bounded original markup for traceability without letting one
        // oversized entry dominate the database.
        xml: block.slice(0, 20_000),
      },
    };
  }).filter((item) => item.title && item.url);
}

function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function jsonLdNodes(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdNodes);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, any>;
  return [object, ...array(object['@graph']).flatMap(jsonLdNodes)];
}

function addressText(address: unknown): string {
  if (typeof address === 'string') return normalizeText(address);
  if (!address || typeof address !== 'object') return '';
  const value = address as Record<string, unknown>;
  return normalizeText([
    value.streetAddress, value.addressLocality, value.addressRegion, value.postalCode,
  ].filter(Boolean).join(', '));
}

function locationDetails(value: unknown): { venueName: string; address: string; area: string } {
  if (typeof value === 'string') return { venueName: normalizeText(value), address: '', area: '' };
  if (!value || typeof value !== 'object') return { venueName: '', address: '', area: '' };
  const location = value as Record<string, any>;
  const address = location.address;
  return {
    venueName: normalizeText(location.name),
    address: addressText(address),
    area: normalizeText(address?.addressLocality),
  };
}

function imageUrls(value: unknown): string[] {
  return [...new Set(array(value).flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (item && typeof item === 'object' && typeof (item as any).url === 'string') return [(item as any).url];
    return [];
  }))];
}

function typeNames(value: unknown): string[] {
  return array(value).map((item) => normalizeText(item)).filter(Boolean);
}

function parseJsonLd(html: string, pageUrl: string): RawSourceItem[] {
  const scripts = [...html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];
  const nodes: Record<string, any>[] = [];
  for (const script of scripts) {
    try {
      nodes.push(...jsonLdNodes(JSON.parse(decodeHtmlEntities(script[1]).trim())));
    } catch {
      // One malformed block must not discard other valid Event blocks.
    }
  }
  return nodes.filter((node) => typeNames(node['@type']).some((type) => /event$/i.test(type))).map((node) => {
    const location = locationDetails(node.location);
    const offers = array(node.offers).map((offer) => typeof offer === 'object' ? (offer as any).description : '').filter(Boolean);
    const url = typeof node.url === 'string' ? node.url : pageUrl;
    return {
      externalId: normalizeText(node['@id']) || url,
      url,
      title: normalizeText(node.name || node.headline),
      description: normalizeText([node.description, ...offers].filter(Boolean).join(' ')),
      venueName: location.venueName || null,
      startAt: node.startDate || null,
      endAt: node.endDate || null,
      allDay: typeof node.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(node.startDate),
      area: location.area || null,
      address: location.address || null,
      publishedAt: node.datePublished || node.dateModified || null,
      imageUrls: imageUrls(node.image),
      eventTypes: typeNames(node['@type']),
      tags: array(node.keywords).flatMap((value) => String(value).split(',')).map(normalizeText).filter(Boolean),
      raw: node,
    };
  }).filter((item) => item.title && item.url);
}

export async function fetchSourceItems(
  source: ContentSource,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<SourceFetchResult> {
  if (source.kind === 'webhook') return { items: [], notModified: false };
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
  try {
    const headers: Record<string, string> = {
      accept: source.kind === 'json_ld'
        ? 'text/html,application/xhtml+xml'
        : 'application/rss+xml,application/atom+xml,application/xml,text/xml',
      'user-agent': USER_AGENT,
      ...(source.config.requestHeaders || {}),
    };
    if (source.etag) headers['if-none-match'] = source.etag;
    if (source.lastModified) headers['if-modified-since'] = source.lastModified;
    const response = await safeFetch(source.url, { headers, signal: controller.signal }, fetchImpl);
    if (response.status === 304) {
      return {
        items: [], notModified: true,
        etag: response.headers.get('etag') || source.etag,
        lastModified: response.headers.get('last-modified') || source.lastModified,
      };
    }
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('Source response exceeded 5 MB limit');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('Source response exceeded 5 MB limit');
    const items = source.kind === 'json_ld' ? parseJsonLd(text, response.url || source.url) : parseFeed(text);
    return {
      items,
      notModified: false,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const sourceAdapterInternals = { parseFeed, parseJsonLd, parseLabeledWhen, semanticRssFields };
