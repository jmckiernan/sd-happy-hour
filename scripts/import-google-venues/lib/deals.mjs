export const FALLBACK_DEALS = ['Happy hour'];

const PLACEHOLDER_RE = /confirm current offers|happy hour specials\s*[—–-]/i;
const JUNK_RE = /instagram|facebook|twitter|tiktok|photos and videos|follow us|subscribe|cookie|privacy policy|javascript|all rights reserved|@\w{2,}|click here|order online|reservations?|gift cards?|private parties?|corporate events?|social events?|opening hours|sustainable development|map of the|explore our|event tags?|watch party|about history|birthdays and promotions|tags:/i;
const MENU_HEADER_RE = /^(?:appetizers|entrees|desserts|drinks|cocktails|wine|beer|margaritas|tacos|burritos|menus?|brunch|lunch|dinner|specials?|buckets|platters|bowls|buns)(?:\s+menu)?\.?$/i;
const HOURS_RE = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;

export function decodeHtmlEntities(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, '"')
    .replace(/&ldquo;/gi, '"')
    .replace(/&hellip;/gi, '...')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–');
}

export function normalizeDealKey(value) {
  return decodeHtmlEntities(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s$%.-]/g, '')
    .trim();
}

export function isJunkDealLine(line) {
  const text = decodeHtmlEntities(line).trim();
  if (!text || text.length < 3 || text.length > 120) return true;
  if (PLACEHOLDER_RE.test(text)) return true;
  if (JUNK_RE.test(text)) return true;
  if (MENU_HEADER_RE.test(text)) return true;
  if (HOURS_RE.test(text) && !/\$/.test(text)) return true;
  if (/^happy hour(?: menu| specials?| times?| details?)?\.?$/i.test(text)) return true;
  if (/^specialty(?: sandwiches| drinks| cocktails?)?\.?$/i.test(text) && !/\$/.test(text)) return true;
  if (/^all specials?\.?$/i.test(text)) return true;
  if (/^today'?s happy hour\.?$/i.test(text)) return true;
  return false;
}

export function isRealDealLine(line) {
  if (isJunkDealLine(line)) return false;
  const text = decodeHtmlEntities(line);
  return /\$\s?\d+(?:\.\d{2})?|\d+\s*for\s*\$|half[- ]?price|\d+%\s*off|buy one get one|bogo|free (?:domestic )?(?:beer|drink|appetizer|wing)/i.test(text);
}

export function cleanDealLine(line) {
  return decodeHtmlEntities(line)
    .replace(/^[-•*▪·]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanDeals(rawDeals = []) {
  const cleaned = [];
  const seen = new Set();
  for (const raw of rawDeals) {
    const line = cleanDealLine(raw);
    if (!line || isJunkDealLine(line)) continue;
    const key = normalizeDealKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(line);
  }
  return cleaned.slice(0, 8);
}

export function finalizeDeals(rawDeals = []) {
  const cleaned = cleanDeals(rawDeals);
  if (!cleaned.length) return [...FALLBACK_DEALS];
  const real = cleaned.filter(isRealDealLine);
  if (real.length) return real.slice(0, 8);
  return cleaned.slice(0, 8);
}

export function needsDealRefresh(deals = []) {
  if (!deals.length) return true;
  return deals.some((deal) => isJunkDealLine(deal) || PLACEHOLDER_RE.test(deal))
    || new Set(deals.map(normalizeDealKey)).size < deals.length;
}
