/**
 * Which listings still owe us a transcribed happy-hour menu.
 *
 * Shared by the coverage audit and the backfill so both agree on what
 * "missing a menu" means, and so the rule is testable.
 */

/** Ordered worst-to-best for reporting. */
export const MENU_COVERAGE_BUCKETS = [
  'good_menu',
  'thin_menu',
  'flyer_only',
  'no_menu',
  'times_only',
  'unlisted',
];

/** Below this a "menu" is really just the deal chips restated. */
export const MIN_REAL_MENU_ITEMS = 4;

function menuItemCount(venue) {
  return (venue?.hhMenu?.sections || []).reduce(
    (total, section) => total + (section.items || []).length,
    0
  );
}

function hasScrapedFlyer(venue) {
  return (venue?.galleryImages || []).some((image) => image.url && !image.generated);
}

/**
 * A venue with no published offers has nothing to transcribe — a board would
 * just repeat the hours we already show. Those are `times_only` and are not
 * work; everything else with offers should end up with a menu.
 */
function hasPublishedOffers(venue) {
  if (Array.isArray(venue?.deals) && venue.deals.length) return true;
  if (Array.isArray(venue?.weeklySpecials) && venue.weeklySpecials.length) return true;
  return false;
}

export function classifyMenuCoverage(venue) {
  if (!venue) return 'unlisted';
  if (venue.listingStatus && venue.listingStatus !== 'published') return 'unlisted';

  const items = menuItemCount(venue);
  if (items >= MIN_REAL_MENU_ITEMS && !venue.hhMenu?.fromDealChips) return 'good_menu';
  if (items > 0) return 'thin_menu';
  if (hasScrapedFlyer(venue)) return 'flyer_only';
  if (hasPublishedOffers(venue)) return 'no_menu';
  return 'times_only';
}
