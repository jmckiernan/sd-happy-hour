import { cleanDeals, decodeHtmlEntities, finalizeDeals } from './deals.mjs';
import { DAY_ABBR, DAY_NAMES } from './constants.mjs';
import { sleep } from './io.mjs';

const WEBSITE_PATHS = [
  '',
  '/happy-hour',
  '/happyhour',
  '/happy-hours',
  '/menu',
  '/menus',
  '/drinks',
  '/specials',
  '/bar',
];

const USER_AGENT = 'SDHappyHoursImport/1.0 (+https://sdhappyhours.com)';

function padTime(hour, minute = 0) {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isFinite(h) || !Number.isFinite(m) || m < 0 || m > 59) return null;
  const normalizedHour = ((h % 24) + 24) % 24;
  return `${String(normalizedHour).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function isValidTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function parseClockToken(token) {
  const match = token.trim().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = (match[3] || '').toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (!meridiem && hour <= 6) hour += 12;
  return padTime(hour, minute);
}

function daysFromRangeText(text) {
  const lower = text.toLowerCase();
  if (/daily|every\s*day|7\s*days|all\s*week/i.test(lower)) {
    return [...DAY_NAMES.slice(1), DAY_NAMES[0]];
  }
  if (/mon(?:day)?\s*[-–—to]+\s*(?:fri|friday)/i.test(lower) || /weekdays?/i.test(lower)) {
    return DAY_NAMES.slice(1, 6);
  }
  if (/mon(?:day)?\s*[-–—to]+\s*(?:sun|sunday)/i.test(lower)) {
    return DAY_NAMES.slice(1).concat(DAY_NAMES[0]);
  }
  const days = new Set();
  for (const [abbr, index] of Object.entries(DAY_ABBR)) {
    const re = new RegExp(`\\b${abbr}\\b`, 'i');
    if (re.test(lower)) days.add(DAY_NAMES[index]);
  }
  if (days.size) return DAY_NAMES.filter((day) => days.has(day));
  return null;
}

function parseTimeRange(text) {
  const match = text.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-–—to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  if (!match) return null;
  const start = parseClockToken(match[1]);
  const end = parseClockToken(match[2]);
  if (start && end) return { startTime: start, endTime: end };
  return null;
}

function htmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|div|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function extractHappyHourHtml(html) {
  const lower = html.toLowerCase();
  const index = lower.indexOf('happy hour');
  if (index === -1) return null;
  return html.slice(Math.max(0, index - 400), Math.min(html.length, index + 6000));
}

function extractDealsFromHtml(html) {
  const section = extractHappyHourHtml(html);
  if (!section) return [];
  const deals = [];
  for (const match of section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    deals.push(htmlToText(match[1]));
  }
  for (const match of section.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    deals.push(htmlToText(match[1]));
  }
  return cleanDeals(deals);
}

function extractDealsFromText(text) {
  const lines = text.split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const deals = [];
  for (const line of lines.slice(0, 60)) {
    if (line.length < 4 || line.length > 120) continue;
    if (!/happy hour/i.test(line) && !/\$\d|half[- ]?price|\d+%\s*off|\d+\s*for\s*\$|special/i.test(line)) continue;
    deals.push(line);
  }
  return cleanDeals(deals);
}

export function parseGoogleHappyHour(regularSecondaryOpeningHours = []) {
  const block = regularSecondaryOpeningHours.find(
    (entry) => entry.secondaryHoursType === 'HAPPY_HOUR' || entry.type === 'HAPPY_HOUR'
  );
  if (!block?.periods?.length) return null;

  const dayTimes = new Map();
  for (const period of block.periods) {
    if (!period.open || !period.close) continue;
    const day = DAY_NAMES[period.open.day];
    const startTime = padTime(period.open.hour, period.open.minute || 0);
    const endTime = padTime(period.close.hour, period.close.minute || 0);
    if (!startTime || !endTime) continue;
    const key = `${startTime}-${endTime}`;
    if (!dayTimes.has(key)) dayTimes.set(key, { startTime, endTime, days: new Set() });
    dayTimes.get(key).days.add(day);
  }
  if (!dayTimes.size) {
    const desc = (block.weekdayDescriptions || []).join(' ');
    const days = daysFromRangeText(desc) || DAY_NAMES.slice(1, 6);
    const times = parseTimeRange(desc);
    if (!times) return null;
    return { ...times, days, source: 'google', confidence: 'medium', raw: desc };
  }

  let best = null;
  for (const value of dayTimes.values()) {
    if (!best || value.days.size > best.days.size) best = value;
  }
  const descDays = daysFromRangeText((block.weekdayDescriptions || []).join(' '));
  const days = descDays && descDays.length >= best.days.size ? descDays : DAY_NAMES.filter((day) => best.days.has(day));
  return {
    startTime: best.startTime,
    endTime: best.endTime,
    days,
    source: 'google',
    confidence: 'high',
    raw: (block.weekdayDescriptions || []).join('; '),
  };
}

async function fetchPageHtml(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return null;
  return (await response.text()).slice(0, 500_000);
}

function extractHappyHourSection(text) {
  const lower = text.toLowerCase();
  const index = lower.indexOf('happy hour');
  if (index === -1) return null;
  return text.slice(Math.max(0, index - 200), Math.min(text.length, index + 2500));
}

export async function extractWebsiteHappyHour(websiteUri, delayMs = 400) {
  if (!websiteUri || !/^https?:\/\//i.test(websiteUri)) return null;
  let origin;
  try {
    origin = new URL(websiteUri).origin;
  } catch {
    return null;
  }

  for (const suffix of WEBSITE_PATHS) {
    const url = suffix ? `${origin}${suffix}` : websiteUri;
    try {
      const html = await fetchPageHtml(url);
      await sleep(delayMs);
      if (!html) continue;
      const text = htmlToText(html);
      const section = extractHappyHourSection(text) || text.slice(0, 4000);
      if (!/happy hour/i.test(section)) continue;

      const days = daysFromRangeText(section) || daysFromRangeText(text) || DAY_NAMES.slice(1, 6);
      const times = parseTimeRange(section) || parseTimeRange(text);
      if (!times) continue;
      if (!isValidTime(times.startTime) || !isValidTime(times.endTime)) continue;

      const deals = finalizeDeals([
        ...extractDealsFromHtml(html),
        ...extractDealsFromText(section),
      ]);

      return {
        ...times,
        days,
        deals,
        source: 'website',
        confidence: deals.length === 1 && deals[0] === 'Happy hour' ? 'low' : 'medium',
        sourcePage: url,
        raw: section.slice(0, 500),
      };
    } catch {
      // try next path
    }
  }
  return null;
}

export async function resolveHappyHour(place) {
  const google = parseGoogleHappyHour(place.regularSecondaryOpeningHours);
  if (google) {
    return { ...google, deals: finalizeDeals(google.deals || []) };
  }
  return extractWebsiteHappyHour(place.websiteUri);
}
