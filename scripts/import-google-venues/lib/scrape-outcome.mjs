/**
 * Scrape outcomes are first-class. "Could not scrape" is not a single state.
 *
 * These codes are written onto venue.lastScrape so a later city-wide run can
 * decide whether to retry, escalate to a browser, send a PDF to vision, or
 * leave the listing unlisted because the venue simply does not publish offers.
 */

export const SCRAPE_OUTCOMES = {
  found: 'found',
  google_complete: 'google_complete',
  not_published: 'not_published',
  no_website: 'no_website',
  no_candidates: 'no_candidates',
  blocked: 'blocked',
  media_unreadable: 'media_unreadable',
  wrong_website: 'wrong_website',
  extract_failed: 'extract_failed',
  ambiguous: 'ambiguous',
  other_location: 'other_location',
};

export const OUTCOME_LABELS = {
  found: 'Offers found with supporting evidence',
  google_complete: 'Google already has happy-hour times and we already have deal lines',
  not_published: 'Candidate pages were read; no current happy hour or specials for this location',
  no_website: 'No official website on the listing',
  no_candidates: 'Website fetched, but no specials/happy-hour/menu candidate URL ranked',
  blocked: 'Page discovered but blocked (challenge, 403, 429)',
  media_unreadable: 'Best candidate is a PDF or image we could not read',
  wrong_website: 'The listed website does not mention this venue or its San Diego address',
  extract_failed: 'Content acquired but extraction failed',
  ambiguous: 'Sources disagreed or the page was too stale/unclear to apply',
  other_location: 'Page describes another location of the same brand',
};

export function buildLastScrape({
  outcome,
  found = false,
  reason = '',
  sourceUrl = null,
  candidateUrls = [],
  evidence = [],
  locationApplicability = null,
  confidence = null,
} = {}) {
  return {
    outcome,
    found: Boolean(found),
    reason: String(reason || OUTCOME_LABELS[outcome] || outcome),
    sourceUrl,
    candidateUrls: [...new Set((candidateUrls || []).filter(Boolean))],
    evidence: Array.isArray(evidence) ? evidence.filter((row) => row?.quote && row?.url) : [],
    locationApplicability,
    confidence,
    observedAt: new Date().toISOString().slice(0, 10),
  };
}

export function outcomeFromInventory(inventory) {
  if (!inventory) return SCRAPE_OUTCOMES.extract_failed;
  if (inventory.blocked && !inventory.candidates?.length) return SCRAPE_OUTCOMES.blocked;
  if (!inventory.candidates?.length) return SCRAPE_OUTCOMES.no_candidates;
  return null;
}
