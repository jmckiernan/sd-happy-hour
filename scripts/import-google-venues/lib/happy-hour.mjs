import { cleanDeals, decodeHtmlEntities, finalizeDeals } from './deals.mjs';
import { DAY_NAMES } from './constants.mjs';
import { daysFromRangeText } from './day-ranges.mjs';
import { sleep } from './io.mjs';
import {
  buildVenueLocationHints,
  crawlForHappyHourPages,
  fetchPageHtml,
  htmlToText,
  inventoryWebsite,
  isCloudflareChallenge,
  sectionMatchesVenue,
  extractLocationsFromHtml,
  urlLooksLikeMenuPage,
} from './website-crawl.mjs';
import {
  hasAiExtraction,
  extractHappyHourWithAiFromInventory,
} from './ai-extract.mjs';
import { isAnthropicBillingError } from './anthropic-errors.mjs';
import { buildLastScrape, outcomeFromInventory, SCRAPE_OUTCOMES, OUTCOME_LABELS } from './scrape-outcome.mjs';
import { normalizeWindows, applyPrimaryFromWindows } from './schedule-windows.mjs';
import { selectMenuFlyerPages } from './media.mjs';
import { looksLikeShoppingMall } from './venue-quality.mjs';
import {
  matchLocatorRecord,
  locatorTextFromRecord,
  detectLocatorApis,
  fetchLocatorRecords,
} from './locator-widgets.mjs';
import { pageMatchesVenueListing, hostnameCorroboratesVenue, listingUrlCorroboratesVenue, listedHostMatchesVenueName } from './website-ownership.mjs';
import { conflictsWithVenue, pickLocationPage } from './location-page.mjs';

const WEBSITE_PATHS = [
  '/specials--happy-hour',
  '/specials/happy-hour',
  '/happy-hour',
  '/happyhour',
  '/happy-hours',
  '/specials',
  '/promotions',
  '/offers',
  '/drinks',
  '/bar',
  '/menu',
  '/menus',
  '',
];

export { htmlToText, fetchPageHtml, isCloudflareChallenge, extractLocationsFromHtml };

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

export function parseClockToken(token) {
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

export { daysFromRangeText };

export function parseTimeRange(text) {
  const match = text.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-–—to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  if (!match) return null;
  const start = parseClockToken(match[1]);
  const end = parseClockToken(match[2]);
  if (start && end) return { startTime: start, endTime: end };
  return null;
}

function extractHappyHourHtml(html) {
  const lower = html.toLowerCase();
  const index = lower.indexOf('happy hour');
  if (index === -1) return null;
  return html.slice(Math.max(0, index - 400), Math.min(html.length, index + 6000));
}

function extractHappyHourSection(text) {
  const lower = text.toLowerCase();
  const index = lower.indexOf('happy hour');
  if (index === -1) return null;
  return text.slice(Math.max(0, index - 200), Math.min(text.length, index + 2500));
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
  for (const match of section.matchAll(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>\s*<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const heading = htmlToText(match[1]);
    const body = htmlToText(match[2]);
    if (/happy hour|special|half|discount|\$/i.test(heading) || /half|discount|\$|\d+%/i.test(body)) {
      deals.push(body.startsWith(heading) ? body : `${heading}: ${body}`);
    }
  }
  return cleanDeals(deals);
}

function extractDealsFromText(text) {
  const lines = text.split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const deals = [];
  for (const line of lines.slice(0, 80)) {
    if (line.length < 4 || line.length > 160) continue;
    if (
      !/happy hour/i.test(line) &&
      !/\$\d|half[- ]?price|\d+%\s*off|\d+\s*for\s*\$|discounted|special/i.test(line)
    ) {
      continue;
    }
    deals.push(line);
  }
  return cleanDeals(deals);
}

/** Parse happy hour from a single page's HTML. */
export function parseHappyHourFromPage(html, url, venueContext = null) {
  if (isCloudflareChallenge(html)) return null;

  const text = htmlToText(html);
  const venueHints = venueContext ? buildVenueLocationHints(venueContext) : [];
  const section = extractHappyHourSection(text);

  if (!section || !/happy hour/i.test(section)) return null;

  const brandWideSpecials = isBrandWideSpecialsPage(url);
  const locationQualified =
    venueHints.length ? extractLocationQualifiedSection(text, venueHints) : null;

  if (
    venueHints.length &&
    !sectionMatchesVenue(section, venueHints) &&
    !locationQualified &&
    !brandWideSpecials
  ) {
    return null;
  }

  const focusText = locationQualified || section;

  const days =
    daysFromRangeText(focusText) ||
    daysFromRangeText(section) ||
    daysFromRangeText(text) ||
    DAY_NAMES.slice(1, 6);

  const times = parseTimeRangeNearHappyHour(focusText) || parseTimeRangeNearHappyHour(section);
  if (!times || !isValidTime(times.startTime) || !isValidTime(times.endTime)) return null;

  const deals = finalizeDeals([
    ...extractDealsFromHtml(html),
    ...extractDealsFromText(focusText),
    ...extractDealsFromText(section),
  ]);

  return {
    ...times,
    days,
    windows: normalizeWindows([{ ...times, days, kind: 'happy_hour' }]),
    deals,
    source: 'website',
    confidence: scoreConfidence(deals, url),
    sourcePage: url,
    found: true,
    outcome: SCRAPE_OUTCOMES.found,
    raw: focusText.slice(0, 500),
  };
}

function extractLocationQualifiedSection(text, venueHints) {
  const lower = text.toLowerCase();
  for (const hint of venueHints) {
    const idx = lower.indexOf(hint);
    if (idx === -1) continue;
    const slice = text.slice(Math.max(0, idx - 250), Math.min(text.length, idx + 2500));
    if (/happy hour/i.test(slice)) return slice;
  }
  return null;
}

function isBrandWideSpecialsPage(url) {
  return /specials[-/ ]*happy|happy[-/ ]*hour|\/specials/i.test(String(url).toLowerCase());
}

function parseTimeRangeNearHappyHour(text) {
  const lower = text.toLowerCase();
  let searchFrom = 0;
  while (searchFrom < lower.length) {
    const index = lower.indexOf('happy hour', searchFrom);
    if (index === -1) break;
    const near = text.slice(index, index + 350);
    const times = parseTimeRange(near);
    if (times) return times;
    searchFrom = index + 1;
  }
  return parseTimeRange(text);
}

function scoreConfidence(deals, url) {
  if (deals.length === 1 && deals[0] === 'Happy hour') return 'low';
  if (/happy[-/ ]*hour|specials[-/ ]*happy/i.test(url)) return 'high';
  return 'medium';
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

/** Legacy path-based scrape (fast, used by import pipeline). */
export async function extractWebsiteHappyHour(websiteUri, delayMs = 400, venueContext = null, fetchImpl = null) {
  if (!websiteUri || !/^https?:\/\//i.test(websiteUri)) return null;
  let origin;
  try {
    origin = new URL(websiteUri).origin;
  } catch {
    return null;
  }

  const fetchHtml = fetchImpl
    ? async (url) => {
        const response = await fetchImpl(url);
        if (!response?.ok) return null;
        return (await response.text()).slice(0, 500_000);
      }
    : fetchPageHtml;

  const candidates = [];

  const pathsToTry = fetchImpl ? WEBSITE_PATHS.slice(0, 5) : WEBSITE_PATHS;

  for (const suffix of pathsToTry) {
    const url = suffix ? `${origin}${suffix}` : websiteUri;
    try {
      const html = await fetchHtml(url);
      await sleep(delayMs);
      if (!html || isCloudflareChallenge(html)) continue;
      const parsed = parseHappyHourFromPage(html, url, venueContext);
      if (parsed) {
        candidates.push(parsed);
        if (parsed.confidence === 'high') break;
      }
    } catch {
      // try next path
    }
  }

  if (!candidates.length) return null;
  return pickBestCandidate(candidates);
}

function buildFetchHtml(fetchImpl) {
  if (!fetchImpl) return fetchPageHtml;
  return async (url) => {
    const response = await fetchImpl(url);
    if (!response?.ok) return null;
    return (await response.text()).slice(0, 500_000);
  };
}

/** Discover pages once, then extract for a specific location. */
export async function extractWebsiteHappyHourWithAi(websiteUri, venueContext = null, options = {}) {
  return extractWebsiteHappyHourDeep(websiteUri, venueContext, { ...options, useAi: true });
}

function emptyResult(outcome, reason, extras = {}) {
  const message = reason || OUTCOME_LABELS[outcome] || outcome;
  return {
    found: false,
    outcome,
    reason: message,
    windows: [],
    deals: [],
    confidence: 'low',
    lastScrape: buildLastScrape({ outcome, reason: message, ...extras }),
    ...extras,
  };
}

const VENUE_NAME_STOP = new Set([
  'the', 'and', 'at', 'bar', 'grill', 'grille', 'restaurant', 'cafe', 'san', 'diego',
  'del', 'mar', 'town', 'center', 'highlands',
]);

export function venueNameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !VENUE_NAME_STOP.has(token));
}

/** Drop other tenants' promo pages when this listing has its own named URLs. */
export function selectInventoryForVenue(inventory, venue) {
  const candidates = inventory?.candidates || [];
  if (!candidates.length) return inventory;
  const tokens = venueNameTokens(venue?.name);
  if (!tokens.length) return inventory;
  const namedHtml = candidates.filter((page) => (
    page.kind === 'html' && tokens.some((token) => String(page.url || '').toLowerCase().includes(token))
  ));
  if (!namedHtml.length) return inventory;

  const html = candidates.filter((page) => page.kind === 'html').filter((page) => {
    const url = String(page.url || '').toLowerCase();
    if (tokens.some((token) => url.includes(token))) return true;
    try {
      const path = new URL(page.url).pathname.toLowerCase();
      if (path === '/' || path === '') return true;
    } catch {
      // keep
    }
    if (urlLooksLikeMenuPage(page.url)) return true;
    if (/\/(specials|happy-hour|happyhour|menus?)(?:\/|$|\?)/i.test(url) && !/\/promotion\//i.test(url)) {
      return true;
    }
    if (/happy|special|promo/i.test(url)) return false;
    return true;
  });
  const media = candidates.filter((page) => page.kind !== 'html').filter((page) => {
    const url = String(page.url || '').toLowerCase();
    if (/\/promotion\//i.test(url) && !tokens.some((token) => url.includes(token))) return false;
    return true;
  });
  return { ...inventory, candidates: [...html, ...media] };
}

function inventoryMentionsVenue(inventory, venue) {
  if (!venue) return true;
  const urls = [venue.website, ...(inventory?.candidates || []).map((page) => page.url)];
  if (urls.some((url) => (
    hostnameCorroboratesVenue(url, venue)
    || listingUrlCorroboratesVenue(url, venue)
    || listedHostMatchesVenueName(url, venue)
  ))) {
    return true;
  }
  const chunks = [];
  for (const page of inventory?.candidates || []) {
    if (page.text) chunks.push(page.text);
    else if (page.html) chunks.push(htmlToText(page.html));
  }
  const text = chunks.join('\n');
  if (text.replace(/\s+/g, '').length < 80) return true;
  return pageMatchesVenueListing(text, venue);
}

export function salvageFromEvidence(result) {
  if (!result || result.found) return result;
  if (result.outcome === SCRAPE_OUTCOMES.other_location || result.outcome === SCRAPE_OUTCOMES.wrong_website) {
    return result;
  }
  const evidence = result.evidence || [];
  const windows = normalizeWindows(evidence.flatMap((row) => {
    if (row.field !== 'times' || !row.quote) return [];
    const range = parseTimeRange(row.quote);
    const days = daysFromRangeText(row.quote) || [];
    if (!range || !days.length) return [];
    return [{ ...range, days, kind: 'happy_hour' }];
  }));
  const deals = cleanDeals(evidence.flatMap((row) => {
    if (row.field !== 'deals' && row.field !== 'specials') return [];
    return String(row.quote || '')
      .split(/\s*(?:\.{2,}|…)\s*/)
      .flatMap((part) => part.split(/(?=HH\s*[-–—])/i))
      .map((part) => part.replace(/^[-–—]\s*/, '').trim())
      .filter(Boolean);
  }));
  if (!windows.length && !deals.length) return result;
  const primary = applyPrimaryFromWindows(windows, result);
  return {
    ...result,
    found: true,
    outcome: SCRAPE_OUTCOMES.found,
    windows,
    deals,
    startTime: primary.startTime || result.startTime,
    endTime: primary.endTime || result.endTime,
    days: primary.days?.length ? primary.days : result.days,
    confidence: result.confidence === 'low' ? 'medium' : (result.confidence || 'medium'),
  };
}

/**
 * Turn this venue's locator entry — if the brand publishes one for *this*
 * address — into a candidate page the extract can quote.
 *
 * It arrives as a synthetic page because everything downstream (the AI call,
 * evidence quotes, `no_candidates`) is written against pages, and because the
 * locator API URL is a perfectly good citation. Scored just above a homepage
 * fallback and below any real specials page: it is reliable, structured text,
 * but a page the venue wrote about its own happy hour is still better.
 */
function withLocatorCandidate(scoped, inventory, venueContext) {
  const records = inventory?.locatorRecords;
  if (!scoped || !venueContext || !Array.isArray(records) || !records.length) return scoped;

  const match = matchLocatorRecord(records, venueContext);
  if (!match) return scoped;

  const text = locatorTextFromRecord(match);
  if (!text) return scoped;

  return {
    ...scoped,
    candidates: [
      ...(scoped.candidates || []),
      {
        url: match.record.sourceUrl || inventory.origin,
        kind: 'html',
        html: '',
        text,
        bytes: null,
        contentType: 'application/json',
        score: 22,
        source: `locator:${match.record.platform || 'json'}`,
        blocked: false,
        ok: true,
      },
    ],
  };
}

export async function extractFromInventory(inventory, venueContext = null, options = {}) {
  const useAi = options.useAi !== false && hasAiExtraction();
  if (venueContext && looksLikeShoppingMall(venueContext)) {
    return emptyResult(
      SCRAPE_OUTCOMES.not_published,
      'Listing is a shopping mall, not a restaurant or bar',
      { candidateUrls: [venueContext.website].filter(Boolean), sourcePage: venueContext.website || null }
    );
  }
  const scoped = withLocatorCandidate(selectInventoryForVenue(inventory, venueContext), inventory, venueContext);
  const candidateUrls = (scoped?.candidates || []).map((page) => page.url);
  const inventoryOutcome = outcomeFromInventory(scoped);
  if (inventoryOutcome) {
    const candidates = scoped?.candidates || [];
    const onlyMedia = candidates.length > 0
      && candidates.every((page) => page.kind === 'pdf' || page.kind === 'image');
    const outcome = scoped.blocked && onlyMedia ? SCRAPE_OUTCOMES.media_unreadable : inventoryOutcome;
    return emptyResult(outcome, undefined, { candidateUrls, sourcePage: candidateUrls[0] || null });
  }

  if (venueContext && !inventoryMentionsVenue(scoped, venueContext)) {
    return emptyResult(
      SCRAPE_OUTCOMES.wrong_website,
      `Listed website does not mention ${venueContext.name} or its San Diego-area address`,
      { candidateUrls, sourcePage: candidateUrls[0] || venueContext.website || null }
    );
  }

  if (useAi) {
    try {
      const aiResult = salvageFromEvidence(await extractHappyHourWithAiFromInventory(scoped, venueContext));
      if (aiResult) {
        return {
          ...aiResult,
          menuImages: selectMenuFlyerPages(scoped.candidates),
          lastScrape: buildLastScrape({
            outcome: aiResult.outcome,
            found: aiResult.found,
            reason: aiResult.reason,
            sourceUrl: aiResult.sourcePage,
            candidateUrls,
            evidence: aiResult.evidence,
            locationApplicability: aiResult.locationApplicability,
            confidence: aiResult.confidence,
          }),
        };
      }
    } catch (error) {
      if (isAnthropicBillingError(error) || error?.name === 'AnthropicBillingError') throw error;
      return emptyResult(SCRAPE_OUTCOMES.extract_failed, error.message, { candidateUrls });
    }
  }

  const htmlPages = (scoped.candidates || []).filter((page) => page.kind === 'html' && page.html);
  const candidates = [];
  for (const page of htmlPages) {
    const parsed = parseHappyHourFromPage(page.html, page.url, venueContext);
    if (parsed) candidates.push({ ...parsed, pageScore: page.score, sourcePage: page.url });
  }

  if (!candidates.length) {
    const mediaUnread = (scoped.candidates || []).some((page) => page.kind === 'pdf' || page.kind === 'image');
    return emptyResult(
      mediaUnread ? SCRAPE_OUTCOMES.media_unreadable : SCRAPE_OUTCOMES.not_published,
      mediaUnread
        ? 'PDF/image menu found but text extraction was not available'
        : 'Candidate pages fetched; no happy hour or specials parsed',
      { candidateUrls, sourcePage: candidateUrls[0] || null }
    );
  }

  const best = pickBestCandidate(candidates);
  const windows = best.windows?.length
    ? best.windows
    : normalizeWindows([{ startTime: best.startTime, endTime: best.endTime, days: best.days }]);
  const primary = applyPrimaryFromWindows(windows, best);
  return {
    ...best,
    ...primary,
    windows,
    found: true,
    outcome: SCRAPE_OUTCOMES.found,
    candidateUrls,
    menuImages: selectMenuFlyerPages(scoped.candidates),
    lastScrape: buildLastScrape({
      outcome: SCRAPE_OUTCOMES.found,
      found: true,
      sourceUrl: best.sourcePage,
      candidateUrls,
      confidence: best.confidence,
    }),
  };
}

/** Discover HH/specials pages, extract with AI (or regex fallback on same pages). */
export async function extractWebsiteHappyHourDeep(websiteUri, venueContext = null, options = {}) {
  if (!websiteUri || !/^https?:\/\//i.test(websiteUri)) {
    return emptyResult(SCRAPE_OUTCOMES.no_website, 'No official website on the listing');
  }

  const priorityUrl =
    venueContext?.sourceUrl && /happy|special|promo|offer|menu/i.test(venueContext.sourceUrl)
      ? venueContext.sourceUrl
      : null;

  // A URL naming this venue's city, ZIP or street number outranks a generic
  // one on a chain site, where the generic page describes some other branch.
  const branchUrl = venueContext
    ? pickLocationPage([venueContext.sourceUrl, websiteUri].filter(Boolean), venueContext)?.url
    : null;

  const inventory = options.inventory || await inventoryWebsite(websiteUri, {
    ...options,
    venueContext,
    maxPages: options.maxPages ?? 6,
    maxFetches: options.maxFetches ?? 8,
    minHappyHourScore: options.minHappyHourScore ?? 8,
    priorityUrl: priorityUrl || branchUrl,
  });

  return extractFromInventory(inventory, venueContext, options);
}

function pickBestCandidate(candidates) {
  const confidenceRank = { high: 3, medium: 2, low: 1 };
  return candidates.sort((a, b) => {
    const confDiff = (confidenceRank[b.confidence] || 0) - (confidenceRank[a.confidence] || 0);
    if (confDiff) return confDiff;
    const realDealsA = a.deals.filter((d) => d !== 'Happy hour').length;
    const realDealsB = b.deals.filter((d) => d !== 'Happy hour').length;
    if (realDealsB !== realDealsA) return realDealsB - realDealsA;
    return (b.pageScore || 0) - (a.pageScore || 0);
  })[0];
}

/**
 * Locator records for a domain, fetched at most once per import run.
 * Keyed by origin because a chain's locator is one payload for every location.
 */
const locatorCache = new Map();

export async function locatorRecordsForSite(websiteUri, venueContext) {
  let origin;
  try {
    origin = new URL(websiteUri).origin;
  } catch {
    return [];
  }
  if (locatorCache.has(origin)) return locatorCache.get(origin);

  const records = [];
  try {
    // The widget script usually lives on the locator page, not the homepage,
    // so check both. Two plain GETs per domain, no browser and no AI.
    for (const url of [origin, `${origin}/locations`, `${origin}/store-locator`]) {
      const html = await fetchPageHtml(url);
      if (!html) continue;
      const apis = detectLocatorApis(html, venueContext || {});
      for (const api of apis) {
        const found = await fetchLocatorRecords(api);
        if (found.length) {
          records.push(...found);
          break;
        }
      }
      if (records.length) break;
    }
  } catch {
    // A locator is a bonus source; never fail discovery over it.
  }

  locatorCache.set(origin, records);
  return records;
}

/**
 * A happy hour published only in a brand's store locator.
 *
 * Discovery otherwise admits a venue only when Google flags `HAPPY_HOUR`
 * secondary hours, which is why we had 1 of 16 San Diego Board & Brews: the
 * other 15 publish their offer in a Storepoint widget and nowhere else, and a
 * venue was never crawled unless it had already qualified.
 *
 * Deliberately the cheap path — a couple of HTTP requests per domain, no model
 * call. It only qualifies brands running a recognized locator. Routing all
 * ~4,700 enriched candidates through the AI deep extract would catch every
 * case, at roughly $40 a run; see the playbook before turning that on.
 */
export async function extractLocatorHappyHour(websiteUri, venueContext) {
  if (!websiteUri || !venueContext) return null;

  const records = await locatorRecordsForSite(websiteUri, venueContext);
  if (!records.length) return null;

  const match = matchLocatorRecord(records, venueContext);
  if (!match) return null;

  return happyHourFromLocatorText(match.record.offerText, match.record.sourceUrl || websiteUri);
}

/** The parsing half of the above, for callers that already hold the record. */
export function happyHourFromLocatorText(offerText, sourceUrl) {
  const text = offerText || '';
  if (!/happy\s*hour/i.test(text)) return null;

  const times = parseTimeRangeNearHappyHour(text);
  if (!times || !isValidTime(times.startTime) || !isValidTime(times.endTime)) return null;

  const days = daysFromRangeText(text) || DAY_NAMES.slice();

  return {
    ...times,
    days,
    windows: normalizeWindows([{ ...times, days, kind: 'happy_hour' }]),
    deals: finalizeDeals(extractDealsFromText(text)),
    source: 'website',
    confidence: 'medium',
    sourcePage: sourceUrl,
    found: true,
    outcome: SCRAPE_OUTCOMES.found,
    raw: text.slice(0, 500),
  };
}

const SIGNAL_PATHS = ['', '/happy-hour', '/specials', '/menu'];
const signalCache = new Map();

/**
 * Does this site claim a happy hour anywhere obvious?
 *
 * A deliberately dumb text search, used as a gate in front of the expensive
 * extractor. Running the model on every enriched candidate costs ~$40 a run;
 * running it only where a site says the words costs cents, because the money
 * was never in the model, it was in asking it about thousands of sites with
 * nothing to find.
 */
export async function siteMentionsHappyHour(websiteUri) {
  let origin;
  try {
    origin = new URL(websiteUri).origin;
  } catch {
    return null;
  }
  if (signalCache.has(origin)) return signalCache.get(origin);

  let hit = null;
  try {
    for (const suffix of SIGNAL_PATHS) {
      const url = suffix ? `${origin}${suffix}` : websiteUri;
      const html = await fetchPageHtml(url);
      if (!html || isCloudflareChallenge(html)) continue;
      const text = htmlToText(html);
      const match = /happy\s*hour/i.exec(text);
      if (!match) continue;
      hit = { url, excerpt: text.slice(Math.max(0, match.index - 90), match.index + 160).replace(/\s+/g, ' ').trim() };
      break;
    }
  } catch {
    // An unreachable site simply has no signal.
  }

  signalCache.set(origin, hit);
  return hit;
}

/**
 * A result can come back `found` with nothing usable behind it — a page title
 * reading "Happy Hour", or a line like "Come by for a Happy Hour". Importing
 * those puts a venue on the site with blank times, so they are not findings.
 */
export function hasUsableSchedule(result) {
  if (!result?.found) return false;
  if (!isValidTime(result.startTime) || !isValidTime(result.endTime)) return false;
  return Array.isArray(result.days) ? result.days.length > 0 : Boolean(result.days);
}

export async function resolveHappyHour(place) {
  const google = parseGoogleHappyHour(place.regularSecondaryOpeningHours);
  if (google) {
    return { ...google, deals: finalizeDeals(google.deals || []) };
  }

  const venueContext = {
    name: place.displayName?.text || place.displayName || place.name || '',
    address: place.formattedAddress || '',
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
  };

  const fromSite = await extractWebsiteHappyHour(place.websiteUri, 400, venueContext);
  if (fromSite) return fromSite;

  const fromLocator = await extractLocatorHappyHour(place.websiteUri, venueContext);
  if (fromLocator) return fromLocator;

  // Last resort: the site says "happy hour" but the cheap readers could not
  // pull a schedule out of it. Only now is a model call worth making.
  if (process.env.IMPORT_AI_FALLBACK === '0') return null;
  const signal = await siteMentionsHappyHour(place.websiteUri);
  if (!signal) return null;

  const deep = await extractWebsiteHappyHourWithAi(place.websiteUri, {
    ...venueContext,
    sourceUrl: signal.url,
  });
  if (!hasUsableSchedule(deep)) return null;

  // On a chain site every branch page says "Happy Hour", so a plausible answer
  // from the wrong restaurant is the likely failure, not a blank one.
  if (conflictsWithVenue(deep.sourcePage, venueContext)) return null;
  return deep;
}

export { hasAiExtraction } from './ai-extract.mjs';
export { inventoryWebsite } from './website-crawl.mjs';

export async function discoverWebsiteLocations(websiteUri, options = {}) {
  const pages = await crawlForHappyHourPages(websiteUri, { ...options, maxPages: 6 });
  const locations = [];
  const seen = new Set();

  for (const page of pages) {
    for (const loc of extractLocationsFromHtml(page.html)) {
      const key = loc.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push({ ...loc, sourcePage: page.url });
    }
  }

  return locations;
}
