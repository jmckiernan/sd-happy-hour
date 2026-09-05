import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { RawSourceItem } from './types';

const MAX_SUBJECT_LENGTH = 500;
const MAX_FROM_LENGTH = 500;
const MAX_BODY_LENGTH = 250_000;
const MAX_HTML_LENGTH = 500_000;
const MAX_LINKS = 100;
const MAX_LINK_LENGTH = 2_048;
const MAX_ITEMS = 12;

const ALLOWED_INPUT_KEYS = new Set(['emailId', 'subject', 'from', 'date', 'text', 'html', 'links']);
const ALLOWED_LINK_KEYS = new Set(['url', 'title']);
const TRACKING_PARAMETERS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'mkt_tok', '_hsenc', '_hsmi', 'vero_conv',
]);
const NON_CONTENT_LINK = /(?:^|[\/_?&=.-])(unsubscribe|opt[\s_-]?out|email[\s_-]?preferences?|manage[\s_-]?(?:subscription|preferences?)|view[\s_-]?in[\s_-]?browser|privacy|terms|facebook|instagram|tiktok|twitter|linkedin)(?:$|[\/_?&=.-])/i;
const GENERIC_LINK_TITLE = /^(?:read more|learn more|details|more info|click here|website|view event|buy tickets|tickets?)$/i;

export interface NewsletterLinkInput {
  url: string;
  title?: string;
}

export interface NewsletterEmailInput {
  emailId: string;
  subject: string;
  from: string;
  date: string;
  text: string;
  html: string;
  links: NewsletterLinkInput[];
}

export interface NewsletterExtractionContext {
  publisherName: string;
  websiteUrl: string;
  allowedLinkDomains?: string[];
}

export class NewsletterPayloadError extends Error {}

export function verifyResendWebhookSignature(input: {
  payload: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  nowSeconds?: number;
}): boolean {
  if (!input.id || !input.timestamp || !input.signature || !input.secret.startsWith('whsec_')) return false;
  if (!/^\d{10}$/.test(input.timestamp)) return false;
  const timestamp = Number(input.timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300) return false;
  let key: Buffer;
  try {
    key = Buffer.from(input.secret.slice(6), 'base64');
  } catch {
    return false;
  }
  if (!key.length) return false;
  const expected = createHmac('sha256', key)
    .update(`${input.id}.${input.timestamp}.${input.payload}`)
    .digest();
  return input.signature.split(/\s+/).some((entry) => {
    const [version, encoded] = entry.split(',', 2);
    if (version !== 'v1' || !encoded) return false;
    try {
      const candidate = Buffer.from(encoded, 'base64');
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    } catch {
      return false;
    }
  });
}

function boundedString(value: unknown, field: string, maximum: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new NewsletterPayloadError(`${field} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw new NewsletterPayloadError(`${field} must be a string.`);
  if (value.length > maximum) throw new NewsletterPayloadError(`${field} is too long.`);
  const output = value.trim();
  if (required && !output) throw new NewsletterPayloadError(`${field} is required.`);
  return output;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function parseNewsletterPayload(value: unknown): NewsletterEmailInput {
  if (!plainObject(value)) throw new NewsletterPayloadError('JSON body must be an object.');
  const unknown = Object.keys(value).filter((key) => !ALLOWED_INPUT_KEYS.has(key));
  if (unknown.length) throw new NewsletterPayloadError(`Unknown field: ${unknown[0]}.`);

  const emailId = boundedString(value.emailId, 'emailId', 300, true);
  if (/[\u0000-\u001f\u007f]/.test(emailId)) {
    throw new NewsletterPayloadError('emailId contains control characters.');
  }
  const subject = boundedString(value.subject, 'subject', MAX_SUBJECT_LENGTH, true);
  const from = boundedString(value.from, 'from', MAX_FROM_LENGTH, true);
  const date = boundedString(value.date, 'date', 100, true);
  const parsedDate = new Date(date);
  if (!Number.isFinite(parsedDate.valueOf())) throw new NewsletterPayloadError('date must be a valid timestamp.');
  const text = boundedString(value.text, 'text', MAX_BODY_LENGTH);
  const html = boundedString(value.html, 'html', MAX_HTML_LENGTH);
  if (!text && !html) throw new NewsletterPayloadError('text or html is required.');

  if (value.links !== undefined && !Array.isArray(value.links)) {
    throw new NewsletterPayloadError('links must be an array.');
  }
  const suppliedLinks = (value.links || []) as unknown[];
  if (suppliedLinks.length > MAX_LINKS) throw new NewsletterPayloadError('links has too many entries.');
  const links = suppliedLinks.map((entry, index): NewsletterLinkInput => {
    if (typeof entry === 'string') {
      return { url: boundedString(entry, `links[${index}]`, MAX_LINK_LENGTH, true) };
    }
    if (!plainObject(entry)) throw new NewsletterPayloadError(`links[${index}] must be a string or object.`);
    const extra = Object.keys(entry).filter((key) => !ALLOWED_LINK_KEYS.has(key));
    if (extra.length) throw new NewsletterPayloadError(`Unknown links[${index}] field: ${extra[0]}.`);
    return {
      url: boundedString(entry.url, `links[${index}].url`, MAX_LINK_LENGTH, true),
      title: boundedString(entry.title, `links[${index}].title`, MAX_SUBJECT_LENGTH) || undefined,
    };
  });

  return {
    emailId,
    subject,
    from,
    date: parsedDate.toISOString(),
    text,
    html,
    links,
  };
}

export function extractSenderEmail(from: string): string | null {
  const bracketed = from.match(/<\s*([^<>\s@]+@[^<>\s@]+)\s*>/);
  const bare = bracketed?.[1] || from.match(/(?:^|\s)([^<>\s@]+@[^<>\s@]+)(?:$|\s)/)?.[1] || '';
  const normalized = bare.toLowerCase().replace(/^mailto:/, '').replace(/[>,;]$/, '');
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(normalized)) return null;
  return normalized;
}

function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  };
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? match;
    const hex = entity[1]?.toLowerCase() === 'x';
    const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(number) || number < 0 || number > 0x10ffff) return match;
    try { return String.fromCodePoint(number); } catch { return match; }
  });
}

/** Converts untrusted newsletter markup into inert, length-bounded prose. */
export function sanitizeNewsletterText(value: string, maximum = 12_000): string {
  return decodeEntities(value
    .replace(/<(script|style|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(?:p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maximum)
    .trim();
}

function htmlLinks(html: string): NewsletterLinkInput[] {
  const output: NewsletterLinkInput[] = [];
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    output.push({ url: decodeEntities(match[1] || match[2] || match[3] || ''), title: sanitizeNewsletterText(match[4] || '', 500) });
    if (output.length >= MAX_LINKS) break;
  }
  return output;
}

function normalizeDomain(value: string): string | null {
  try {
    const parsed = value.includes('://') ? new URL(value) : new URL(`https://${value}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

function domainMatches(hostname: string, allowedDomain: string): boolean {
  return hostname === allowedDomain || hostname.endsWith(`.${allowedDomain}`);
}

function safeOfficialUrl(value: string, allowedDomains: string[]): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    if (!allowedDomains.some((domain) => domainMatches(host, domain))) return null;
    if (NON_CONTENT_LINK.test(`${url.hostname}${url.pathname}${url.search}`)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return null;
  }
}

function meaningfulTitle(input: string): string {
  const title = sanitizeNewsletterText(input, 180)
    .replace(/^(?:new|featured)\s*:\s*/i, '')
    .trim();
  if (title.length < 4 || GENERIC_LINK_TITLE.test(title) || NON_CONTENT_LINK.test(title)) return '';
  return title;
}

export function newsletterPayloadSha256(input: NewsletterEmailInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/**
 * Extracts only first-party, human-facing links. Newsletter prose remains
 * untrusted data; this deterministic function never interprets it as a prompt
 * or permits it to select a source, URL host, or executable behavior.
 */
export function extractNewsletterItems(
  input: NewsletterEmailInput,
  context: NewsletterExtractionContext
): RawSourceItem[] {
  const allowedDomains = [context.websiteUrl, ...(context.allowedLinkDomains || [])]
    .map(normalizeDomain)
    .filter((domain): domain is string => Boolean(domain));
  if (!allowedDomains.length) return [];

  const candidates = [...input.links, ...htmlLinks(input.html)];
  const body = sanitizeNewsletterText(input.text || input.html);
  const subject = meaningfulTitle(input.subject);
  const seen = new Set<string>();
  const usable: Array<{ url: string; title: string }> = [];
  for (const candidate of candidates) {
    const url = safeOfficialUrl(candidate.url, allowedDomains);
    if (!url || seen.has(url)) continue;
    const candidateTitle = meaningfulTitle(candidate.title || '');
    if (candidate.title && !candidateTitle) continue;
    seen.add(url);
    usable.push({ url, title: candidateTitle });
  }

  // Multiple records are safe only when links have descriptive labels. Bare
  // URLs all refer to the one newsletter subject, so retain just the first.
  const titled = usable.filter((candidate) => candidate.title);
  const selected = titled.length ? titled.slice(0, MAX_ITEMS) : usable.slice(0, 1);
  return selected.map((candidate, index) => ({
    externalId: `resend:${input.emailId}:${index + 1}`,
    url: candidate.url,
    title: candidate.title || subject || `${context.publisherName} newsletter update`,
    description: body,
    venueName: context.publisherName,
    county: 'San Diego',
    publishedAt: input.date,
    attribution: context.publisherName,
    tags: ['newsletter'],
    raw: {
      inputKind: 'newsletter_email',
      untrustedText: true,
      resendEmailId: input.emailId,
      newsletterSubject: subject || input.subject,
    },
  }));
}

export type ConfirmationLinkDecision =
  | { status: 'not_confirmation' }
  | { status: 'manual_required'; reason: 'missing_link' | 'ambiguous_links' }
  | { status: 'ready'; url: string };

const CONFIRMATION_INTENT = /\b(confirm|verify|activate|complete)\b.{0,50}\b(subscri(?:be|ption)|email|newsletter)\b|\b(subscri(?:be|ption)|email|newsletter)\b.{0,50}\b(confirm|verify|activate|complete)\b/i;
const CONFIRMATION_LINK = /(?:confirm|verify|activate|subscribe|double[\s_-]?opt[\s_-]?in)/i;
const SENSITIVE_LINK = /(?:unsubscribe|opt[\s_-]?out|password|passcode|account|security|sign[\s_-]?in|log[\s_-]?in|recover|reset)/i;

function syntacticallyPublicHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
    if (/^(?:127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) return null;
    if (host === '::1' || host === '[::1]') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Selects a link only when the message and exactly one link clearly describe subscription confirmation. */
export function selectConfirmationLink(input: NewsletterEmailInput): ConfirmationLinkDecision {
  const body = sanitizeNewsletterText(input.text || input.html, 20_000);
  if (!CONFIRMATION_INTENT.test(`${input.subject}\n${body}`)) return { status: 'not_confirmation' };
  const candidates = [...input.links, ...htmlLinks(input.html)];
  const selected = new Set<string>();
  for (const candidate of candidates) {
    const url = syntacticallyPublicHttpUrl(candidate.url);
    if (!url) continue;
    const parsed = new URL(url);
    const evidence = `${candidate.title || ''} ${parsed.pathname}`;
    if (!CONFIRMATION_LINK.test(evidence) || SENSITIVE_LINK.test(evidence)) continue;
    selected.add(url);
  }
  if (!selected.size) return { status: 'manual_required', reason: 'missing_link' };
  if (selected.size !== 1) return { status: 'manual_required', reason: 'ambiguous_links' };
  return { status: 'ready', url: [...selected][0] };
}

export const newsletterExtractionLimits = {
  maxRequestBytes: 256_000,
  maxRetrievedEmailBytes: 800_000,
  maxLinks: MAX_LINKS,
  maxItems: MAX_ITEMS,
};
