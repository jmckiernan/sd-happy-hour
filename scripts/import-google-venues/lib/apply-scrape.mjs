import { pickPrimaryWindow } from './google-happy-hour.mjs';
import {
  isPlausibleHappyHourWindow,
  windowsEqual,
  applyOpenUntilFromQuotes,
  repairDaysFromEvidence,
} from './schedule-windows.mjs';
import { SCRAPE_OUTCOMES, buildLastScrape } from './scrape-outcome.mjs';
import { looksLikeShoppingMall } from './venue-quality.mjs';
import { isJunkDealLine } from './deals.mjs';
import { parseTimeRange, daysFromRangeText } from './happy-hour.mjs';

function dedicatedHappyHourUrl(url) {
  return /happy[-_/ ]?hour|happyhour|golden[-_/ ]?hour|specials|(?:\/|\.)menus?(?:\/|$)|(?:\/)list(?:\/|$)/i.test(String(url || ''));
}

function timesFromGoogle(venue) {
  return venue.hhSources?.times?.source === 'google_places';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function resolveListingStatus(venue) {
  if (venue.publishedByClaim === true || venue.verified === true) return 'published';
  if (!venue.hasHappyHourData) return 'unlisted';
  return 'published';
}

export function usableWindows(scraped) {
  const windows = (scraped.windows || []).filter(isPlausibleHappyHourWindow);
  if (windows.length) return windows;
  if (scraped.startTime && scraped.endTime && scraped.days?.length) {
    const fallback = {
      startTime: scraped.startTime,
      endTime: scraped.endTime,
      days: scraped.days,
      kind: 'happy_hour',
    };
    return isPlausibleHappyHourWindow(fallback) ? [fallback] : [];
  }
  return [];
}

export function hasTimesEvidence(scraped) {
  return (scraped.evidence || []).some((row) => row.field === 'times' && row.quote && row.url);
}

function hasDealEvidence(scraped) {
  return (scraped.evidence || []).some((row) => (row.field === 'deals' || row.field === 'specials') && row.quote);
}

/** For food halls, prefer the shared hours quote over the union of tenant windows. */
export function windowsFromTimesQuotes(evidence = []) {
  for (const row of evidence) {
    if (row.field !== 'times' || !row.quote) continue;
    const range = parseTimeRange(row.quote);
    const days = daysFromRangeText(row.quote);
    if (range && days?.length && isPlausibleHappyHourWindow({ ...range, days })) {
      return [{ ...range, days, kind: 'happy_hour' }];
    }
  }
  return [];
}

function unlistShoppingMall(venue, scraped) {
  const changes = [];
  if (venue.listingStatus !== 'unlisted') {
    venue.listingStatus = 'unlisted';
    changes.push('unlisted shopping mall');
  }
  if (venue.seoHidden !== true) {
    venue.seoHidden = true;
    changes.push('seoHidden');
  }
  venue.lastScrape = scraped?.lastScrape || buildLastScrape({
    outcome: scraped?.outcome || SCRAPE_OUTCOMES.not_published,
    reason: scraped?.reason || 'Listing is a shopping mall, not a restaurant or bar',
    sourceUrl: scraped?.sourcePage || venue.website,
    candidateUrls: scraped?.candidateUrls,
  });
  return {
    changed: changes.length > 0,
    changes,
    reason: changes.length ? 'shopping_mall' : 'already_unlisted',
  };
}

/**
 * Apply a scrape without throwing away better data we already have.
 * Google-backed times stay unless a dedicated page disagrees with quoted evidence.
 * AI confidence alone never overwrites times.
 */
export function applyScrape(venue, scraped) {
  if (looksLikeShoppingMall(venue, scraped)) {
    return unlistShoppingMall(venue, scraped);
  }
  if (!scraped?.found) {
    venue.lastScrape = scraped?.lastScrape || buildLastScrape({
      outcome: scraped?.outcome || SCRAPE_OUTCOMES.extract_failed,
      reason: scraped?.reason,
      sourceUrl: scraped?.sourcePage,
      candidateUrls: scraped?.candidateUrls,
    });
    return { changed: false, reason: scraped?.outcome || 'no_data' };
  }

  if (scraped.confidence === 'low' && !hasTimesEvidence(scraped) && !(scraped.deals || []).length) {
    venue.lastScrape = scraped.lastScrape;
    return { changed: false, reason: 'low_confidence' };
  }

  const changes = [];
  const sources = { ...(venue.hhSources || {}) };
  const extractedDeals = (scraped.deals || []).filter(Boolean);
  const fromGoogle = timesFromGoogle(venue);
  const dedicated = dedicatedHappyHourUrl(scraped.sourcePage);
  const hallWindows = scraped.multiTenant ? windowsFromTimesQuotes(scraped.evidence) : [];
  const windows = repairDaysFromEvidence(
    applyOpenUntilFromQuotes(
      hallWindows.length ? hallWindows : usableWindows(scraped),
      scraped.evidence
    ),
    scraped.evidence
  );
  const canReplaceTimes = windows.length
    && (hasTimesEvidence(scraped) || scraped.source === 'website')
    && (!fromGoogle || (dedicated && scraped.confidence !== 'low' && hasTimesEvidence(scraped)));

  if (canReplaceTimes) {
    const primaryWindow = pickPrimaryWindow(windows) || windows[0];
    const ordered = [primaryWindow, ...windows.filter((window) => window !== primaryWindow)];
    if (primaryWindow.startTime !== venue.startTime || primaryWindow.endTime !== venue.endTime) {
      changes.push(`times ${venue.startTime}–${venue.endTime} → ${primaryWindow.startTime}–${primaryWindow.endTime}`);
      if (fromGoogle) {
        venue.hhConflicts = [
          { field: 'times', source: 'google_places', value: `${venue.startTime}-${venue.endTime}` },
        ];
      }
      venue.startTime = primaryWindow.startTime;
      venue.endTime = primaryWindow.endTime;
    }
    if (primaryWindow.days?.length) venue.days = primaryWindow.days;
    if (!windowsEqual(venue.windows || [], ordered)) {
      venue.windows = ordered;
      if (ordered.length > 1) changes.push(`windows (${ordered.length})`);
    }
    venue.hasHappyHourData = true;
    sources.times = {
      source: 'website_hh_page',
      url: scraped.sourcePage,
      observedAt: today(),
      evidence: (scraped.evidence || []).filter((row) => row.field === 'times').slice(0, 3),
    };
  }

  if (scraped.multiTenant) {
    if ((venue.deals || []).length) {
      venue.deals = [];
      changes.push('cleared tenant-specific deals (food hall)');
    }
    venue.dealsUnknown = true;
    delete sources.deals;
  } else if (extractedDeals.length && (hasDealEvidence(scraped) || hasTimesEvidence(scraped) || scraped.source === 'website')) {
    const before = JSON.stringify(venue.deals || []);
    venue.deals = extractedDeals;
    venue.dealsUnknown = false;
    if (venue.startTime && venue.endTime) venue.hasHappyHourData = true;
    sources.deals = {
      source: 'website_hh_page',
      url: scraped.sourcePage,
      observedAt: today(),
      evidence: (scraped.evidence || []).filter((row) => row.field === 'deals' || row.field === 'specials').slice(0, 3),
    };
    if (before !== JSON.stringify(venue.deals)) changes.push(`deals (${scraped.deals.length} line(s))`);
  } else if (
    canReplaceTimes
    && (venue.deals || []).length
    && (venue.deals || []).every((line) => isJunkDealLine(line))
  ) {
    venue.deals = [];
    venue.dealsUnknown = true;
    delete sources.deals;
    changes.push('cleared constraint-only chips');
  }

  if (scraped.sourcePage && (extractedDeals.length || canReplaceTimes)) venue.sourceUrl = scraped.sourcePage;
  venue.lastVerifiedAt = today();
  if (Object.keys(sources).length) venue.hhSources = sources;
  venue.listingStatus = resolveListingStatus(venue);
  venue.lastScrape = scraped.lastScrape || buildLastScrape({
    outcome: SCRAPE_OUTCOMES.found,
    found: true,
    sourceUrl: scraped.sourcePage,
    candidateUrls: scraped.candidateUrls,
    evidence: scraped.evidence,
    confidence: scraped.confidence,
  });

  return { changed: changes.length > 0, changes, reason: changes.length ? 'updated' : 'already_current' };
}
