import { FALLBACK_DEALS, isRealDealLine } from './deals.mjs';

const SUSPICIOUS_MIDDAY_STARTS = new Set(['11:00', '12:00', '07:00', '06:00']);
const GENERIC_SOURCE_PATHS = /^\/(?:menu|menus|drinks|bar)?\/?$/i;

export function getRegistrableDomain(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    return parts.slice(-2).join('.');
  } catch {
    return null;
  }
}

export function isFallbackDeals(deals = []) {
  return deals.length === 1 && deals[0] === FALLBACK_DEALS[0];
}

export function hasRealDeals(deals = []) {
  return (deals || []).some(isRealDealLine);
}

/** Mall operators and mall-named listings — not a restaurant at a mall. */
const MALL_OPERATOR_HOST_RE = /(?:^|\.)(?:westfield|simon|macerich|ggp|brookfieldproperties)\.com$/i;

export function looksLikeShoppingMall(venue = {}, scraped = null) {
  const name = String(venue?.name || '');
  const website = String(venue?.website || '');
  let host = '';
  try {
    host = new URL(website).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    host = '';
  }
  if (host && MALL_OPERATOR_HOST_RE.test(host)) return true;
  const hay = `${name} ${scraped?.reason || ''} ${scraped?.notes || ''}`;
  if (/\b(?:shopping mall|shopping center|outlet mall|premium outlets)\b/i.test(hay)) {
    return !/\b(?:bar|grill|restaurant|tavern|cantina|pub|brewery|kitchen)\b/i.test(name);
  }
  return false;
}

function durationMinutes(startTime, endTime) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let start = sh * 60 + sm;
  let end = eh * 60 + em;
  if (end <= start) end += 24 * 60;
  return end - start;
}

export function groupVenuesByDomain(venues) {
  const groups = new Map();
  for (const venue of venues) {
    const domain = getRegistrableDomain(venue.website);
    if (!domain) continue;
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(venue);
  }
  return groups;
}

/**
 * Static quality flags for a venue (no network).
 * Returns { severity, code, message }[] sorted by severity.
 */
export function flagVenue(venue, allVenues = []) {
  const flags = [];

  if (isFallbackDeals(venue.deals)) {
    flags.push({
      severity: 'high',
      code: 'fallback_deals',
      message: 'Only generic "Happy hour" placeholder — no actual specials listed.',
    });
  }

  if (!hasRealDeals(venue.deals) && !isFallbackDeals(venue.deals)) {
    flags.push({
      severity: 'medium',
      code: 'weak_deals',
      message: 'Deal lines lack prices or concrete offers.',
    });
  }

  if (venue.verified !== true && !venue.lastVerifiedAt) {
    flags.push({
      severity: 'low',
      code: 'never_verified',
      message: 'Never admin-verified.',
    });
  }

  const duration = durationMinutes(venue.startTime, venue.endTime);
  if (duration > 8 * 60) {
    flags.push({
      severity: 'high',
      code: 'long_window',
      message: `Happy hour window is ${Math.round(duration / 60)} hours — likely operating hours, not HH.`,
    });
  }
  if (duration < 30) {
    flags.push({
      severity: 'medium',
      code: 'short_window',
      message: 'Happy hour window is under 30 minutes.',
    });
  }

  if (SUSPICIOUS_MIDDAY_STARTS.has(venue.startTime) && isFallbackDeals(venue.deals)) {
    flags.push({
      severity: 'high',
      code: 'suspicious_midday',
      message: `${venue.startTime} start with no real deals — may be lunch hours scraped by mistake.`,
    });
  }

  if (venue.days?.length === 7 && isFallbackDeals(venue.deals)) {
    flags.push({
      severity: 'medium',
      code: 'all_days_placeholder',
      message: 'All 7 days with placeholder deals — may be over-inferred.',
    });
  }

  try {
    const sourcePath = new URL(venue.sourceUrl).pathname;
    if (GENERIC_SOURCE_PATHS.test(sourcePath) || /\/menu/i.test(sourcePath)) {
      flags.push({
        severity: 'medium',
        code: 'generic_source',
        message: `Data sourced from generic page (${sourcePath}), not a dedicated happy hour page.`,
      });
    }
  } catch {
    // ignore bad sourceUrl
  }

  const domain = getRegistrableDomain(venue.website);
  if (domain) {
    const siblings = allVenues.filter(
      (v) => v.id !== venue.id && getRegistrableDomain(v.website) === domain
    );
    if (siblings.length) {
      const identical = siblings.filter(
        (v) =>
          v.startTime === venue.startTime &&
          v.endTime === venue.endTime &&
          JSON.stringify(v.days) === JSON.stringify(venue.days) &&
          JSON.stringify(v.deals) === JSON.stringify(venue.deals)
      );
      if (identical.length) {
        flags.push({
          severity: 'high',
          code: 'shared_chain_data',
          message: `Identical HH data as ${identical.length} other location(s) on ${domain} — may not be location-specific.`,
        });
      }
    }
  }

  const severityOrder = { high: 0, medium: 1, low: 2 };
  return flags.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}

/** Compare stored venue data against a fresh scrape result. */
export function compareVenueToScrape(venue, scraped) {
  if (!scraped?.found) {
    return [{
      severity: 'high',
      code: scraped?.outcome || 'scrape_failed',
      message: scraped?.reason || 'Could not find happy hour data on website.',
    }];
  }

  const diffs = [];

  if (scraped.startTime !== venue.startTime || scraped.endTime !== venue.endTime) {
    diffs.push({
      severity: 'high',
      code: 'time_mismatch',
      message: `Times differ: stored ${venue.startTime}–${venue.endTime}, website ${scraped.startTime}–${scraped.endTime}.`,
      stored: { startTime: venue.startTime, endTime: venue.endTime },
      scraped: { startTime: scraped.startTime, endTime: scraped.endTime },
    });
  }

  const storedDays = new Set(venue.days || []);
  const scrapedDays = new Set(scraped.days || []);
  const daysMatch =
    storedDays.size === scrapedDays.size &&
    [...storedDays].every((d) => scrapedDays.has(d));
  if (!daysMatch) {
    diffs.push({
      severity: 'medium',
      code: 'days_mismatch',
      message: `Days differ: stored [${venue.days?.join(', ')}], website [${scraped.days?.join(', ')}].`,
    });
  }

  if (isFallbackDeals(venue.deals) && hasRealDeals(scraped.deals)) {
    diffs.push({
      severity: 'high',
      code: 'missing_deals',
      message: `Website has ${scraped.deals.filter(isRealDealLine).length} real deal line(s); listing has placeholder only.`,
      scrapedDeals: scraped.deals,
    });
  }

  return diffs;
}

/** Detect domains where the website lists more locations than we have venues. */
export function detectMultiLocationGaps(venues, websiteLocationsByDomain = new Map()) {
  const gaps = [];
  const groups = groupVenuesByDomain(venues);

  for (const [domain, domainVenues] of groups) {
    const siteLocations = websiteLocationsByDomain.get(domain);
    if (!siteLocations?.length) continue;
    if (siteLocations.length <= domainVenues.length) continue;

    const knownAddresses = domainVenues.map((v) => normalizeAddress(v.address));
    const missing = siteLocations.filter(
      (loc) => !knownAddresses.some((addr) => addressesMatch(addr, normalizeAddress(loc.address)))
    );

    if (missing.length) {
      gaps.push({
        domain,
        listedOnSite: siteLocations.length,
        inDatabase: domainVenues.length,
        existingVenues: domainVenues.map((v) => ({ id: v.id, name: v.name, address: v.address })),
        missingLocations: missing,
      });
    }
  }

  return gaps;
}

function normalizeAddress(address = '') {
  return address
    .toLowerCase()
    .replace(/\b(?:suite|ste|unit|#)\s*\w+/gi, '')
    .replace(/,?\s*(?:usa|ca|california)\s*\d{5}(?:-\d{4})?/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function addressesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  return longer.includes(shorter.slice(0, Math.min(shorter.length, 12)));
}

export function summarizeAuditResults(results) {
  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byCode = new Map();

  for (const result of results) {
    for (const flag of result.flags || []) {
      bySeverity[flag.severity] = (bySeverity[flag.severity] || 0) + 1;
      byCode.set(flag.code, (byCode.get(flag.code) || 0) + 1);
    }
  }

  return {
    venuesAudited: results.length,
    venuesWithIssues: results.filter((r) => r.flags?.length).length,
    bySeverity,
    topCodes: [...byCode.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([code, count]) => ({ code, count })),
  };
}
