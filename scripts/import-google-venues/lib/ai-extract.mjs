import { cleanDeals } from './deals.mjs';
import { DAY_NAMES } from './constants.mjs';
import { htmlToText, isCloudflareChallenge, preferSpecialsSlice } from './website-crawl.mjs';
import { anthropicMediaType, sniffMediaFromBytes } from './media.mjs';
import { normalizeWindows, applyPrimaryFromWindows, applyOpenUntilFromQuotes } from './schedule-windows.mjs';
import { SCRAPE_OUTCOMES } from './scrape-outcome.mjs';
import { AnthropicBillingError, isAnthropicBillingError } from './anthropic-errors.mjs';

const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_PAGE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 80_000;

const SYSTEM_PROMPT = `You extract happy hour and other recurring specials for a restaurant/bar directory.

You receive the text of one or more candidate pages (and sometimes a PDF or menu image) plus metadata about ONE location.

Rules:
1. Read every source. A menu page with a happy-hour section beats a homepage FAQ. A dedicated specials/happy-hour page beats both. When they disagree, prefer the page that lists actual offers and times, not a one-line FAQ. Hours on one page and priced items on another still count as one happy hour — combine them.
2. Extract every recurring offer that applies to the TARGET LOCATION: happy hour, golden hour, late-night happy hour, taco Tuesday, wine Wednesday, industry night, daily drink specials, prix-fixe lunch specials, etc. "Golden Hour", "After Five", and similarly named bar hours ARE happy hour.
3. Distinguish those offers from ordinary lunch/brunch/dinner menus and from general operating hours.
4. If the brand has multiple locations, use only details that apply to the target address/neighborhood. If the page is clearly about a different location, say so.
5. Never invent prices, times, or offers. Every window and deal must be supported by a short quote from the source.
6. A model confidence label is not evidence. If you cannot quote supporting text, set found=false.
7. If an offer is on the same line as the hours, keep both: times go in windows, the offer goes in deals.
8. A brunch block titled "happy hour lunch" (morning/noon, eggs, 12am–2pm) is not the bar happy hour when the same menu also has a Happy Hour heading with afternoon hours and priced specials. Use the afternoon section.

9. Compact JSON only. Collapse a dated specials calendar into recurring named nights (Taco Tuesday, Oyster Friday), not one object per calendar date.
10. If the listing is a food hall, marketplace, rooftop collection, shopping mall, or shopping-center dining deck with multiple restaurants, do not copy one tenant's menu onto the hall. Shared hours go in windows. deals stays empty unless the page states a hall-wide offer. Set multiTenant=true. A shopping mall that is not itself a restaurant or bar: found=false.
11. ALL DAY Monday (or similar) is a real happy hour window: set allDay=true. Do not drop it because it is longer than an afternoon slot. If a flyer says Tues–Fri, Friday is included.
12. Split mixed schedules into separate windows. "All day Monday, Tuesday–Friday 3:00–6:00" is two windows: allDay Monday only, and 15:00–18:00 Tue–Fri. Never copy the weekday span onto the all-day window.
13. When a dedicated happy-hour URL disagrees with a food/cocktail menu one-liner, trust the happy-hour page.
14. menuBoard is the happy-hour offer list for a gallery flyer. Copy every priced food and drink line. Category discounts ($2 off beers, ½ off apps) belong as items too. Do not omit items to stay compact, and do not stop at the 6 directory chips. Omit menuBoard only when there are no offer lines at all.
15. found=true when you have usable windows OR deals. Do not set found=false because hours and prices lived on different URLs.
16. "Open–7pm" / "open until 7" means endTime 19:00, not 23:59. Only use 23:59 when the source says close, midnight, or last call.

Return ONLY valid JSON (no markdown fences):
{
  "found": boolean,
  "reason": string,
  "locationApplicability": "this_location" | "all_locations" | "other_location" | "unspecified",
  "multiTenant": boolean,
  "windows": [
    {
      "days": string[],
      "startTime": "HH:MM",
      "endTime": "HH:MM",
      "kind": "happy_hour" | "late_night" | "weekly_special",
      "label": string,
      "allDay": boolean
    }
  ],
  "deals": string[],
  "weeklySpecials": string[],
  "menuBoard": {
    "hours": string,
    "note": string,
    "sections": [{ "title": string, "items": [{ "name": string, "price": string }] }]
  },
  "confidence": "high" | "medium" | "low",
  "evidence": [{ "url": string, "quote": string, "field": "times" | "deals" | "specials" }],
  "notes": string
}

Field rules:
- startTime/endTime: 24-hour local time, e.g. "15:30". Overnight windows are allowed (22:00–01:00).
- days: full English day names Sunday..Saturday. If the menu says Monday–Saturday or Tues–Fri, include every day in that span. Do not drop Friday because a FAQ said weekdays.
- windows: one entry per distinct schedule (afternoon HH, late-night HH, all-day Monday). Omit a window rather than guess. Max 4 windows. An allDay window's days are only the days the source calls all-day.
- deals: directory chips. Maximum 6. Never pad. Same category or price band → one chip ("$6 house beers, wines & wells", "$8 wings, rings & green beans"). Distinct categories stay separate. If more than 6 categories, keep the 6 most useful and mix drinks and food. If there are only 2 or 3 categories, return only those. Include percent-off, half-off, and combo prices — a dollar sign is not required. Never copy marketing sentences, questions, or location constraints like "(in bar area only)" — those belong on the window, not as chips.
- weeklySpecials: recurring specials that are not the main HH window
- menuBoard: complete HH items grouped by section (Food / Drinks / Specials). Max 4 sections, 20 items each. Prices as printed ("$6") when present. This is for a gallery flyer, not chips.
- evidence: at most 4 quotes, each 8–240 characters copied from the source
- If no happy hour or specials exist for this location, found=false with a specific reason`;

function throwAnthropicHttpError(status, errText) {
  const message = `Anthropic API error (${status}): ${String(errText || '').slice(0, 400)}`;
  if (isAnthropicBillingError(message)) throw new AnthropicBillingError(message);
  throw new Error(message);
}

export function hasAiExtraction() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function getModel() {
  return process.env.VENUE_AI_MODEL?.trim() || DEFAULT_MODEL;
}

function stripJsonFences(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  if (start === -1) return trimmed;
  return trimmed.slice(start);
}

function closeTruncatedJson(text) {
  let s = String(text || '');
  if ((s.match(/"/g) || []).length % 2 === 1) {
    s = s.replace(/,\s*"[^"]*$/, '');
    if ((s.match(/"/g) || []).length % 2 === 1) s += '"';
  }
  s = s.replace(/,\s*$/, '');
  const stack = [];
  let inString = false;
  let escape = false;
  for (const c of s) {
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  if (inString) s += '"';
  while (stack.length) s += stack.pop();
  return s;
}

export function parseModelJson(text) {
  const raw = stripJsonFences(text);
  const attempts = [raw, raw.replace(/,\s*([}\]])/g, '$1'), closeTruncatedJson(raw)];
  let lastError;
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new SyntaxError('AI returned invalid JSON');
}

function isValidTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function normalizeEvidence(raw, fallbackUrl) {
  if (!Array.isArray(raw)) return [];
  const rows = [];
  for (const item of raw) {
    const quote = String(item?.quote || '').replace(/\s+/g, ' ').trim();
    const url = String(item?.url || fallbackUrl || '').trim();
    if (quote.length < 8 || quote.length > 280 || !url) continue;
    const field = ['times', 'deals', 'specials'].includes(item.field) ? item.field : 'deals';
    rows.push({ url, quote, field });
    if (rows.length >= 8) break;
  }
  return rows;
}

export function normalizeMenuBoard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sections = [];
  for (const section of raw.sections || []) {
    const title = String(section?.title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const items = [];
    for (const item of section?.items || []) {
      const name = String(item?.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const price = String(item?.price || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      if (!name) continue;
      items.push({ name, price });
      if (items.length >= 20) break;
    }
    if (!items.length) continue;
    sections.push({ title: title || 'Happy Hour', items });
    if (sections.length >= 4) break;
  }
  const itemCount = sections.reduce((n, section) => n + section.items.length, 0);
  if (itemCount < 2) return null;
  return {
    hours: String(raw.hours || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    note: String(raw.note || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    sections,
  };
}

function isScheduleOnlyChip(line) {
  const text = String(line || '').replace(/\s+/g, ' ').trim();
  if (!text) return true;
  if (/^\([^)]+only\)$/i.test(text)) return true;
  if (/^(?:in\s+)?(?:the\s+)?bar(?:\s+area)?(?:\s+only)?\.?$/i.test(text)) return true;
  if (/\$|\d+\s*%|\boff\b|taco|beer|wine|wing|pizza|nacho|margarita/i.test(text)) return false;
  return /all\s*day|tues(?:day)?\s*[-–—to]+\s*fri|monday through friday|\d{1,2}\s*(?:am|pm)/i.test(text);
}
export function normalizeAiHappyHourResult(raw, sourcePage = null, candidateUrls = []) {
  if (!raw || typeof raw !== 'object') return null;

  const evidence = normalizeEvidence(raw.evidence, sourcePage);
  const locationApplicability = ['this_location', 'all_locations', 'other_location', 'unspecified']
    .includes(raw.locationApplicability) ? raw.locationApplicability : 'unspecified';
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';

  if (locationApplicability === 'other_location') {
    return {
      found: false,
      outcome: SCRAPE_OUTCOMES.other_location,
      reason: reason || 'Page describes a different location',
      locationApplicability,
      evidence,
      sourcePage,
      candidateUrls,
      confidence: 'low',
      windows: [],
      deals: [],
    };
  }

  const windows = applyOpenUntilFromQuotes(
    normalizeWindows(
      Array.isArray(raw.windows) && raw.windows.length
        ? raw.windows
        : (isValidTime(raw.startTime) && isValidTime(raw.endTime)
          ? [{ startTime: raw.startTime, endTime: raw.endTime, days: raw.days, kind: 'happy_hour' }]
          : [])
    ),
    evidence
  );

  const fromModel = [
    ...(Array.isArray(raw.deals) ? raw.deals : []),
    ...(Array.isArray(raw.weeklySpecials) ? raw.weeklySpecials : []),
  ]
    .map((line) => String(line || '').trim())
    .filter((line) => line && !isScheduleOnlyChip(line));
  const fromWindowLabels = windows
    .map((window) => String(window.label || '').replace(/^happy hour\s*[-–—:·]\s*/i, '').trim())
    .filter((label) => label && !/^happy hour$/i.test(label));
  const dealLines = fromModel.length ? fromModel : fromWindowLabels;

  const deals = cleanDeals(dealLines);
  const primary = applyPrimaryFromWindows(windows, {
    startTime: isValidTime(raw.startTime) ? raw.startTime : null,
    endTime: isValidTime(raw.endTime) ? raw.endTime : null,
    days: Array.isArray(raw.days) ? DAY_NAMES.filter((day) => raw.days.includes(day)) : [],
  });

  if (!windows.length && !deals.length) {
    return {
      found: false,
      outcome: SCRAPE_OUTCOMES.not_published,
      reason: reason || (raw.found === true
        ? 'Model reported a find without usable windows or deals'
        : 'No happy hour or specials for this location'),
      locationApplicability,
      evidence,
      sourcePage,
      candidateUrls,
      confidence: 'low',
      windows: [],
      deals: [],
    };
  }

  const confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium';
  const multiTenant = raw.multiTenant === true;

  return {
    found: true,
    outcome: SCRAPE_OUTCOMES.found,
    reason: reason || 'Extracted from venue sources with supporting quotes',
    locationApplicability,
    multiTenant,
    startTime: primary.startTime || windows[0]?.startTime || null,
    endTime: primary.endTime || windows[0]?.endTime || null,
    days: primary.days?.length ? primary.days : (windows[0]?.days || []),
    windows,
    deals: multiTenant ? [] : deals,
    source: 'ai',
    confidence,
    sourcePage: sourcePage || evidence[0]?.url || candidateUrls[0] || null,
    evidence,
    candidateUrls,
    notes: typeof raw.notes === 'string' ? raw.notes.trim() : undefined,
    raw: typeof raw.notes === 'string' ? raw.notes.slice(0, 500) : undefined,
    menuBoard: normalizeMenuBoard(raw.menuBoard),
  };
}

function looksLikeFoodHall(venue) {
  return /deck|food hall|marketplace|town center|pavilion|collection|food court|shopping mall|shopping center/i.test(
    `${venue?.name || ''} ${venue?.vibe || ''}`
  );
}

function clipText(text, limit) {
  return preferSpecialsSlice(text, limit);
}

function buildTextPrompt(venueContext, candidates, social = []) {
  const venue = venueContext || {};
  const parts = [
    'TARGET VENUE:',
    `- Name: ${venue.name || 'Unknown'}`,
    `- Address: ${venue.address || 'Unknown'}`,
    `- Neighborhood: ${venue.neighborhood || 'Unknown'}`,
    `- Website: ${venue.website || 'Unknown'}`,
    '',
    'Read every source below. Quote supporting text in evidence. If nothing applies to this location, found=false.',
    '',
  ];
  if (looksLikeFoodHall(venue)) {
    parts.push(
      'This listing looks like a food hall, marketplace, or dining collection — not one restaurant. Extract shared hours only. Do not put one tenant\'s menu in deals. Set multiTenant=true.',
      ''
    );
  }

  let remaining = MAX_TOTAL_CHARS;
  const htmlPages = candidates.filter((page) => page.kind === 'html' && page.text);
  for (const [index, page] of htmlPages.entries()) {
    const budget = Math.min(MAX_PAGE_CHARS, Math.max(2_000, Math.floor(remaining / (htmlPages.length - index))));
    const body = clipText(page.text, budget);
    remaining -= body.length;
    parts.push(`--- SOURCE ${index + 1} (${page.kind}, score ${page.score || 0}) ---`);
    parts.push(`URL: ${page.url}`);
    parts.push(body);
    parts.push('');
    if (remaining < 1_000) break;
  }

  for (const account of social.filter((row) => row.text)) {
    parts.push(`--- SOCIAL (${account.network}) ---`);
    parts.push(`URL: ${account.url}`);
    parts.push(clipText(account.text, 1_200));
    parts.push('');
  }

  const media = candidates.filter((page) => page.kind === 'pdf' || page.kind === 'image');
  if (media.length) {
    parts.push(`Attached media: ${media.map((page) => `${page.kind} ${page.url}`).join(', ')}`);
  }

  return parts.join('\n');
}

function mediaContentBlocks(candidates) {
  const blocks = [];
  const media = (candidates || []).filter((page) => page.bytes?.length);
  media.sort((a, b) => {
    const rank = (page) => (sniffMediaFromBytes(page.bytes)?.kind === 'pdf' || page.kind === 'pdf' ? 2 : 0)
      + (page.score || 0);
    return rank(b) - rank(a);
  });
  for (const page of media) {
    const sniffed = sniffMediaFromBytes(page.bytes);
    const kind = sniffed?.kind || page.kind;
    if (kind === 'pdf') {
      blocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from(page.bytes).toString('base64'),
        },
      });
    } else if (kind === 'image') {
      const mediaType = sniffed?.mediaType || anthropicMediaType('image', page.contentType, page.url, page.bytes);
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: Buffer.from(page.bytes).toString('base64'),
        },
      });
    }
    if (blocks.length >= 4) break;
  }
  return blocks;
}

export async function callAnthropicForHappyHour(venueContext, sourceUrl, pageText) {
  const result = await extractHappyHourWithAiFromInventory(
    {
      candidates: [{ url: sourceUrl, kind: 'html', text: pageText, html: '', score: 1 }],
      social: [],
    },
    venueContext
  );
  return result?.found ? result : null;
}

export async function extractHappyHourWithAi(html, sourceUrl, venueContext = null, pageText = null) {
  if (isCloudflareChallenge(html)) return null;
  const text = pageText || htmlToText(html);
  if (!text || text.length < 80) return null;
  return callAnthropicForHappyHour(venueContext, sourceUrl, text);
}

export async function extractHappyHourWithAiFromPages(pages, venueContext = null) {
  return extractHappyHourWithAiFromInventory({ candidates: pages || [], social: [] }, venueContext);
}

async function postAnthropic(content, { maxTokens = 4096, system = SYSTEM_PROMPT } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: getModel(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const errText = await response.text();
    throwAnthropicHttpError(response.status, errText);
  }
  const data = await response.json();
  const block = Array.isArray(data.content) ? data.content.find((item) => item?.type === 'text') : null;
  if (!block?.text) throw new Error('Anthropic returned no text content');
  return { text: block.text, stopReason: data.stop_reason };
}

function isMediaTypeMismatch(error) {
  return /media type, but the (?:image|document) appears to be/i.test(String(error?.message || error || ''));
}

/**
 * One Haiku call with every candidate (HTML text + up to four PDF/image blocks).
 */
export async function extractHappyHourWithAiFromInventory(inventory, venueContext = null) {
  if (!hasAiExtraction()) return null;
  const candidates = (inventory?.candidates || []).filter((page) => page.ok !== false);
  if (!candidates.length && !inventory?.social?.some((row) => row.text)) return null;

  const candidateUrls = candidates.map((page) => page.url);
  const userText = buildTextPrompt(venueContext, candidates, inventory?.social || []);
  const mediaBlocks = mediaContentBlocks(candidates);
  let content = [{ type: 'text', text: userText }, ...mediaBlocks];

  let parsed;
  try {
    const first = await postAnthropic(content);
    parsed = parseModelJson(first.text);
  } catch (error) {
    const retryWithoutMedia = mediaBlocks.length && isMediaTypeMismatch(error);
    const retryCompact = /invalid JSON|Expected|Unterminated|Unexpected/i.test(String(error.message || ''));
    if (!retryWithoutMedia && !retryCompact) throw error;
    const retryText = retryWithoutMedia
      ? userText
      : `${userText}\n\nPrevious response was invalid or truncated JSON. Return compact JSON only: found, windows (max 4), deals (max 6 chips), menuBoard (every priced HH item), evidence (max 3).`;
    const retryContent = retryWithoutMedia
      ? [{ type: 'text', text: retryText }]
      : [{ type: 'text', text: retryText }, ...mediaBlocks];
    const second = await postAnthropic(retryContent, { maxTokens: 4096 });
    try {
      parsed = parseModelJson(second.text);
    } catch (retryError) {
      throw new Error(`AI returned invalid JSON: ${retryError.message}`);
    }
  }

  return normalizeAiHappyHourResult(parsed, candidates[0]?.url || null, candidateUrls);
}

const COMPRESS_SYSTEM = `You rewrite messy happy-hour deal strings into short directory chips.

Rules:
- Each chip is the offer itself: price + item, or discount + item. Example: "$7 martinis", "$6 house wines", "50% off food with a full pour".
- Maximum 40 characters. No marketing, slogans, questions, or "enjoy/cheers/good vibes".
- Keep real constraints that change the offer (Tuesday, all day, with a full pour).
- Same category or price band can stay one chip. Distinct categories (beer vs wings vs nachos) stay separate.
- At most 6 chips. Never drop a food or drink category just to make the list shorter. If there are more than 6, keep a mix of drinks and food.
- If the source only has 2 or 3 categories, return only those 2 or 3. Do not invent extras.
- Keep named nights and already-short chips even if they have no dollar amount (Mule Mondays, Taco Tuesday). Do not drop them.
- Never invent prices. If the source only gives a range, keep the range: "$3–$10 bites & drinks".
- If a line has no actual offer, omit it.

Return ONLY JSON: { "venues": [ { "id": number, "deals": string[] } ] }`;

function normalizeCompressedChips(rawDeals) {
  if (!Array.isArray(rawDeals)) return [];
  const chips = [];
  const seen = new Set();
  for (const raw of rawDeals) {
    const line = String(raw || '').replace(/\s+/g, ' ').trim().replace(/[.,;:!]+$/g, '');
    if (line.length < 3 || line.length > 48 || /\?/.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    chips.push(line);
    if (chips.length >= 6) break;
  }
  return chips;
}

/**
 * Second Haiku pass: turn stored marketing sentences into homepage/venue chips.
 * Does not scrape; it only rewrites deal strings we already extracted.
 */
export async function compressDealsWithAi(batch) {
  if (!hasAiExtraction() || !batch?.length) return [];
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const payload = batch.map((row) => ({
    id: row.id,
    name: row.name,
    deals: row.deals,
  }));
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: getModel(),
      max_tokens: 2500,
      system: COMPRESS_SYSTEM,
      messages: [{
        role: 'user',
        content: `Rewrite these venue deal lists:\n${JSON.stringify(payload, null, 2)}`,
      }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const errText = await response.text();
    throwAnthropicHttpError(response.status, errText);
  }
  const data = await response.json();
  const block = Array.isArray(data.content) ? data.content.find((item) => item?.type === 'text') : null;
  if (!block?.text) throw new Error('Anthropic returned no text content');
  let parsed;
  try {
    parsed = parseModelJson(block.text);
  } catch (error) {
    throw new Error(`AI returned invalid JSON: ${error.message}`);
  }
  const rows = Array.isArray(parsed?.venues) ? parsed.venues : [];
  return rows.map((row) => ({
    id: Number(row.id),
    deals: normalizeCompressedChips(row.deals),
  })).filter((row) => Number.isFinite(row.id) && row.deals.length);
}
