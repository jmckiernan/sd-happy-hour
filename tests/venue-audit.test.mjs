import assert from 'node:assert/strict';
import {
  parseClockToken,
  parseTimeRange,
  daysFromRangeText,
  parseHappyHourFromPage,
  selectInventoryForVenue,
  extractFromInventory,
  salvageFromEvidence,
} from '../scripts/import-google-venues/lib/happy-hour.mjs';
import {
  normalizeAiHappyHourResult,
  parseModelJson,
  normalizeMenuBoard,
  scoreMenuRichness,
  isSiteChrome,
} from '../scripts/import-google-venues/lib/ai-extract.mjs';
import {
  classifyPrice,
  classifyCategory,
  classifyCategoryWithSource,
  menuItemRows,
} from '../scripts/import-google-venues/lib/menu-item-classify.mjs';
import {
  flagVenue,
  compareVenueToScrape,
  getRegistrableDomain,
  isFallbackDeals,
  looksLikeShoppingMall,
} from '../scripts/import-google-venues/lib/venue-quality.mjs';
import { scoreHappyHourPage, preferSpecialsSlice } from '../scripts/import-google-venues/lib/website-crawl.mjs';
import {
  discoverHappyHourLinksFromHtml,
  discoverInternalLinks,
  buildCandidateUrls,
  isHomepageUrl,
  isCloudflareChallenge,
  isMenuItemDetailUrl,
} from '../scripts/import-google-venues/lib/website-crawl.mjs';
import {
  parseSitemapLocs,
  scoreSitemapUrl,
  rankSitemapUrls,
} from '../scripts/import-google-venues/lib/sitemap-discover.mjs';
import {
  windowsFromPeriods,
  pickPrimaryWindow,
  happyHourFromPlace,
  matchVenueToPlace,
  indexPlacesByName,
} from '../scripts/import-google-venues/lib/google-happy-hour.mjs';
import { isPubliclyListed } from '../src/lib/listingVisibility.ts';
import {
  isHappyHourActive,
  getHappyHourOccurrenceForDate,
  isUnboundedAllDayWindow,
  boundAllDayWindow,
} from '../src/lib/sanDiegoTime.ts';
import { happyHourDayNames } from '../src/lib/happyHourDays.ts';
import { venueSearchText, venueMenuText } from '../src/lib/venueSearchText.ts';
import { isPlausibleHappyHourWindow, normalizeWindows, endTimeFromOpenUntilQuote, applyOpenUntilFromQuotes, repairOpenStartWindows } from '../scripts/import-google-venues/lib/schedule-windows.mjs';
import { classifyUrl, scoreMediaUrl, discoverSocialLinks, discoverSpecialsImages, discoverSpecialsMedia, sniffMediaFromBytes, anthropicMediaType, selectMenuFlyerPages } from '../scripts/import-google-venues/lib/media.mjs';
import { pageMatchesVenueListing, isUsableVenueWebsite, hostnameCorroboratesVenue, listingUrlCorroboratesVenue, listedHostMatchesVenueName } from '../scripts/import-google-venues/lib/website-ownership.mjs';
import { venueMatchesQuery, venueSearchScore } from '../src/lib/venueSearch.ts';
import { rasterizePdfPages, pdfLooksLikeHappyHourMenu } from '../scripts/import-google-venues/lib/pdf-raster.mjs';
import { MAX_BOARD_PAGES, buildBoardHtml, packMenuSections } from '../scripts/import-google-venues/lib/menu-board-image.mjs';
import { menuTextFromJsonResponses } from '../scripts/import-google-venues/lib/json-menu-extract.mjs';
import { classifyCounty } from '../scripts/import-google-venues/lib/county.mjs';
import { conflictsWithVenue, pickLocationPage, cityFromAddress } from '../scripts/import-google-venues/lib/location-page.mjs';
import { dedupeRecords } from '../scripts/import-google-venues/lib/dedupe.mjs';
import { hasUsableSchedule } from '../scripts/import-google-venues/lib/happy-hour.mjs';
import {
  detectLocatorApis,
  collectLocationRecordsFromJson,
  locationsFromPayload,
  matchLocatorRecord,
} from '../scripts/import-google-venues/lib/locator-widgets.mjs';
import {
  formatClock,
  formatDays,
  formatWindow,
  menuBoardFromDealLines,
} from '../scripts/import-google-venues/lib/menu-board-format.mjs';
import { repairDaysFromEvidence } from '../scripts/import-google-venues/lib/schedule-windows.mjs';
import PDFDocument from 'pdfkit';
import {
  cardSpecials,
  cardTimeLabel,
  shortDealLabel,
  venueDealLines,
  CARD_DEAL_FALLBACK,
  WINDOW_ONLY_BODY,
  WINDOW_ONLY_HEADING,
} from '../src/lib/listingCopy.ts';
import {
  UNREADABLE_CAUSES,
  emptyCause,
  isWindowOnly,
  windowSource,
} from '../scripts/import-google-venues/lib/window-only.mjs';
import { acceptableOffers } from '../scripts/import-google-venues/recover-empty-listings.mjs';
import { buildVenueSlugMap, slugFromMap } from '../src/lib/venueSlug.ts';
import happyHours from '../public/data/happy-hours.json' with { type: 'json' };
import { applyScrape } from '../scripts/import-google-venues/lib/apply-scrape.mjs';
import { cleanDeals, isJunkDealLine, isRealDealLine, MAX_DEAL_CHIPS } from '../scripts/import-google-venues/lib/deals.mjs';
import { isAnthropicBillingError } from '../scripts/import-google-venues/lib/anthropic-errors.mjs';
import { inferDealTypes, normalizeVenue } from '../scripts/import-google-venues/lib/normalize.mjs';

function testAnthropicBillingErrorIsDetected() {
  assert.equal(isAnthropicBillingError('Anthropic API error (400): credit balance is too low'), true);
  assert.equal(isAnthropicBillingError(new Error('Please go to Plans & Billing to upgrade or purchase credits.')), true);
  assert.equal(isAnthropicBillingError('fetch failed'), false);
}

function testParseClockToken() {
  assert.equal(parseClockToken('3:30pm'), '15:30');
  assert.equal(parseClockToken('5:30pm'), '17:30');
  assert.equal(parseClockToken('4pm'), '16:00');
}

function testDaysFromRangeText() {
  const days = daysFromRangeText('Enjoy discounted appetizers Tuesday-Sunday 3:30pm-5:30pm');
  assert.deepEqual(days, ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  assert.deepEqual(
    daysFromRangeText('Monday through Friday from 4 PM to 6 PM'),
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
  );
}

function testParseTimeRangeNearHappyHour() {
  const html = `
    <h3>Lunch</h3>
    <p>Served daily 12:00pm-4:00pm</p>
    <h3>Happy Hour</h3>
    <p>Enjoy discounted appetizers Tuesday-Sunday 3:30pm-5:30pm, dine-in only.</p>
  `;
  const result = parseHappyHourFromPage(html, 'https://example.com/specials--happy-hour');
  assert.equal(result.startTime, '15:30');
  assert.equal(result.endTime, '17:30');
  assert.ok(result.deals.some((d) => /discounted/i.test(d)));
}

function testPreferSpecialsSliceKeepsHappyHourSection() {
  const allDay = 'All Day Menu\n'.padEnd(20_000, 'x');
  const hh = 'Happy Hour\nIs served from Monday – Saturday 2pm-5pm\n$1 wings\nsushi $6';
  const text = `${allDay}\n${hh}\n${'Dessert'.padEnd(5_000, 'y')}`;
  const clipped = preferSpecialsSlice(text, 4_000);
  assert.ok(/Monday – Saturday 2pm-5pm/.test(clipped), 'must keep the happy hour hours');
  assert.ok(/\$1 wings/.test(clipped));
  const twoSections = `${'x'.repeat(8_000)}\nHappy Hour Is served from Monday – Saturday 2pm-5pm\n$1 wings\n${'y'.repeat(8_000)}\nhappy hour lunch is served from 12Am to 2PM\nEGGS THINGS\n$18 biscuits`;
  const picked = preferSpecialsSlice(twoSections, 3_000);
  assert.ok(/Monday – Saturday 2pm-5pm/.test(picked));
  assert.ok(!/12Am to 2PM/.test(picked));
}

function testScoreHappyHourPage() {
  const menuScore = scoreHappyHourPage(
    'https://example.com/menu',
    '<html><body><p>Happy hour 12-4 lunch</p></body></html>',
    'Happy hour 12-4 lunch'
  );
  const specialsScore = scoreHappyHourPage(
    'https://example.com/specials--happy-hour',
    '<html><body><h3>Happy Hour</h3><p>3:30pm-5:30pm half price rolls</p></body></html>',
    'Happy Hour 3:30pm-5:30pm half price rolls'
  );
  assert.ok(specialsScore > menuScore);

  const tacoTuesday = scoreHappyHourPage(
    'https://example.com/specials',
    '<html><body><h2>Daily Specials</h2><p>Taco Tuesday $2 tacos and $5 margaritas</p></body></html>',
    'Daily Specials Taco Tuesday $2 tacos and $5 margaritas'
  );
  assert.ok(tacoTuesday > 0, 'specials without the words happy hour must still rank');
}

function testFlagVenue() {
  const venue = {
    id: 1,
    name: 'Test Bar',
    website: 'https://example.com',
    sourceUrl: 'https://example.com/menu',
    startTime: '12:00',
    endTime: '16:00',
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    deals: ['Happy hour'],
    verified: false,
    lastVerifiedAt: null,
  };
  const flags = flagVenue(venue, [venue]);
  assert.ok(flags.some((f) => f.code === 'fallback_deals'));
  assert.ok(flags.some((f) => f.code === 'suspicious_midday'));
}

function testCompareVenueToScrape() {
  const venue = {
    startTime: '12:00',
    endTime: '16:00',
    days: ['Monday'],
    deals: ['Happy hour'],
  };
  const scraped = {
    found: true,
    startTime: '15:30',
    endTime: '17:30',
    days: ['Tuesday', 'Wednesday'],
    deals: ['Half price rolls', 'Discounted appetizers'],
  };
  const diffs = compareVenueToScrape(venue, scraped);
  assert.ok(diffs.some((d) => d.code === 'time_mismatch'));
  assert.ok(diffs.some((d) => d.code === 'missing_deals'));
}

function testGetRegistrableDomain() {
  assert.equal(getRegistrableDomain('https://www.sushiloungesd.com/menu'), 'sushiloungesd.com');
}

function testIsFallbackDeals() {
  assert.equal(isFallbackDeals(['Happy hour']), true);
  assert.equal(isFallbackDeals(['$5 beers']), false);
}

function testDiscoverHappyHourLinksFromHtml() {
  const html = `
    <nav>
      <a href="/">Home</a>
      <a href="/specials--happy-hour">Specials / Happy Hour</a>
      <a href="/menu">Menu</a>
    </nav>
  `;
  const links = discoverHappyHourLinksFromHtml(html, 'https://sushiloungesd.com');
  assert.ok(links.some((l) => l.path === '/specials--happy-hour'));
  assert.ok(links.find((l) => l.path === '/specials--happy-hour').score >= 50);
  assert.ok(links.some((l) => l.path === '/menu'), 'nav Menu links must be crawled');
}

function testBuildCandidateUrlsSkipsHomepageForAi() {
  const urls = buildCandidateUrls('https://sushiloungesd.com', [], { includeHomepage: false });
  assert.ok(!urls.some((u) => isHomepageUrl(u, 'https://sushiloungesd.com')));
  assert.ok(urls[0].includes('specials--happy-hour') || urls[0].includes('happy-hour'));
  assert.ok(urls.some((u) => /\/menus?\/?$/.test(u)));
}

function testDiscoverHappyHourLinksFollowsSitePaths() {
  const html = `
    <nav>
      <a href="/happy-hour-menu/">Happy Hour Menu</a>
      <a href="/bar/after-five">Happy Hour</a>
      <a href="/about">About</a>
    </nav>
  `;
  const links = discoverHappyHourLinksFromHtml(html, 'https://misadventure.co');
  assert.ok(links.some((l) => l.path === '/happy-hour-menu/'));
  assert.ok(links.some((l) => l.path === '/bar/after-five'), 'anchor text Happy Hour must follow non-guessable paths');
  assert.ok(!links.some((l) => l.path === '/about'));
}

function testGoldenHourAndListLinksAreDiscovered() {
  const html = `
    <nav>
      <a href="/list">Golden Hour</a>
      <a href="/menu#menu=happy-hour">Happy Hour Menu</a>
      <a href="/about">About</a>
    </nav>
  `;
  const links = discoverHappyHourLinksFromHtml(html, 'https://kingfishersd.com');
  assert.ok(links.some((l) => l.path === '/list'), 'Golden Hour /list must be crawled');
  assert.ok(links.some((l) => /menu#menu=happy-hour/i.test(l.path)), 'Popmenu hash tabs must be kept');
  assert.ok(!links.some((l) => l.path === '/about'));
  // Those paths are crawled because the site links them, not because we probe
  // every domain for one venue's vocabulary.
  const guessed = buildCandidateUrls('https://kingfishersd.com', []);
  assert.ok(!guessed.some((url) => /\/list\/?$/.test(url)));
  assert.ok(!guessed.some((url) => /\/golden-hour\/?$/.test(url)));

  const withLinks = buildCandidateUrls('https://kingfishersd.com', links);
  assert.ok(withLinks.some((url) => /\/list\/?$/.test(url)));
}

function testGuessedPathsYieldToDiscoveredOnes() {
  const discovered = [{ path: '/food-and-drink/happy-hour', score: 45 }];
  const urls = buildCandidateUrls('https://example.com', discovered, { includeHomepage: false });
  assert.equal(urls[0], 'https://example.com/food-and-drink/happy-hour');
  // Nothing invented: a site that told us where its happy hour lives should
  // not also be probed for /happy-hour, /specials, /menu…
  assert.deepEqual(urls, ['https://example.com/food-and-drink/happy-hour']);

  // With nothing discovered, conventional paths are still worth a try.
  const blind = buildCandidateUrls('https://example.com', [], { includeHomepage: false });
  assert.ok(blind.some((url) => /\/happy-hour$/.test(url)));
  assert.ok(blind.some((url) => /\/menus?$/.test(url)));
  assert.ok(!blind.some((url) => /\/drinks|\/bar$|\/offers|\/promotions/.test(url)));
}

function testHomepageOutranksGuessedPaths() {
  const urls = buildCandidateUrls('https://example.com', []);
  assert.ok(
    isHomepageUrl(urls[0], 'https://example.com'),
    'the homepage exists; guessed paths mostly 404 and eat the fetch budget'
  );
}

function testMenuItemDetailUrlsAreNotCrawled() {
  assert.equal(
    isMenuItemDetailUrl('https://example.com/items/hh-casa-margarita?menu=happy-hour'),
    true
  );
  assert.equal(isMenuItemDetailUrl('https://example.com/menu#menu=happy-hour'), false);
  const html = `
    <nav>
      <a href="/menu#menu=happy-hour">Happy Hour</a>
      <a href="/items/hh-casa-margarita?menu=happy-hour">HH- Casa Margarita $13.50</a>
    </nav>
  `;
  const links = discoverHappyHourLinksFromHtml(html, 'https://example.com');
  assert.ok(links.some((l) => /menu#menu=happy-hour/i.test(l.path)));
  assert.ok(!links.some((l) => /\/items\//.test(l.path)));
}

function testCloudflareChallengeIgnoresTurnstileOnLivePages() {
  const live = `<!doctype html><html><head>
    <link rel="preconnect" href="https://challenges.cloudflare.com">
    <script src="/cdn-cgi/challenge-platform/scripts/precursor/main.js"></script>
    <title>$7 Happy Hour</title></head><body>
    <h1>$7 Happy Hour</h1>
    <p>Daily 4–6 PM beer, cocktails, pizza and bites. Come in early for discounted wine.</p>
    ${'<p>Patio seating and good vibes after work.</p>'.repeat(8)}
    </body></html>`;
  assert.equal(isCloudflareChallenge(live), false);

  const waitingRoom = `<html><head><title>Just a moment...</title></head>
    <body>Just a moment...<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></body></html>`;
  assert.equal(isCloudflareChallenge(waitingRoom), true);

  const cfChrome = '<html><body><div id="cf-browser-verification">Checking your browser</div></body></html>';
  assert.equal(isCloudflareChallenge(cfChrome), true);
}

function testBuildCandidateUrlsPrioritizesKnownSource() {
  const urls = buildCandidateUrls('https://example.com', [], {
    includeHomepage: false,
    priorityUrl: 'https://example.com/specials--happy-hour',
  });
  assert.equal(urls[0], 'https://example.com/specials--happy-hour');
}

function testScoreSitemapUrl() {
  assert.ok(scoreSitemapUrl('https://example.com/happy-hours/') >= 50);
  assert.ok(scoreSitemapUrl('https://example.com/happy-hour-menu/') >= 50);
  assert.ok(scoreSitemapUrl('https://example.com/specials/') >= 30);
  assert.ok(scoreSitemapUrl('https://example.com/menu/') >= 20);
  assert.equal(scoreSitemapUrl('https://example.com/contact/'), 0);
}

function testParseSitemapLocs() {
  const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://lapuertasd.com/happy-hours/</loc></url>
    <url><loc>https://lapuertasd.com/menus/</loc></url>
  </urlset>`;
  const locs = parseSitemapLocs(xml);
  assert.ok(locs.includes('https://lapuertasd.com/happy-hours/'));
}

function testRankSitemapUrls() {
  const ranked = rankSitemapUrls(
    ['https://example.com/menus/', 'https://example.com/specials/', 'https://example.com/happy-hour/'],
    'https://example.com'
  );
  assert.ok(ranked[0].url.includes('happy-hour'));
}

function testBuildCandidateUrlsSitemapOnly() {
  const urls = buildCandidateUrls(
    'https://example.com',
    [{ path: '/specials/', score: 35 }],
    { sitemapOnly: true, includeHomepage: false }
  );
  // A strong sitemap lists the whole site, so anything absent from it is not
  // a page we should be probing for.
  assert.deepEqual(urls, ['https://example.com/specials/']);
}

function testNormalizeAiHappyHourResult() {
  const result = normalizeAiHappyHourResult(
    {
      found: true,
      startTime: '15:30',
      endTime: '17:30',
      days: ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
      deals: ['Discounted appetizers, rolls, and drinks (dine-in only)'],
      weeklySpecials: ['Chronic Mondays: ½ price Chronic Rolls all day'],
      confidence: 'high',
      notes: 'Not valid on certain holidays.',
    },
    'https://example.com/specials--happy-hour'
  );
  assert.equal(result.startTime, '15:30');
  assert.equal(result.source, 'ai');
  assert.equal(result.confidence, 'high');
  assert.ok(result.deals.some((d) => /discounted/i.test(d)));
}

/** Google numbers days 0=Sunday. A late-night window closes on the next day
 * and must stay attached to the day it opened. */
function testWindowsFromPeriods() {
  const windows = windowsFromPeriods([
    { open: { day: 1, hour: 16, minute: 0 }, close: { day: 1, hour: 19, minute: 0 } },
    { open: { day: 2, hour: 16, minute: 0 }, close: { day: 2, hour: 19, minute: 0 } },
    { open: { day: 1, hour: 22, minute: 0 }, close: { day: 2, hour: 0, minute: 0 } },
  ]);

  assert.equal(windows.length, 2);
  const afternoon = windows.find((w) => w.startTime === '16:00');
  assert.deepEqual(afternoon.days, ['Monday', 'Tuesday']);
  const lateNight = windows.find((w) => w.startTime === '22:00');
  assert.deepEqual(lateNight.days, ['Monday']);
  assert.equal(lateNight.endTime, '00:00');
}

/** The listing leads with the window running on the most days; an afternoon
 * slot breaks a tie, so a bar isn't advertised by its late-night hours. */
function testPickPrimaryWindow() {
  const primary = pickPrimaryWindow([
    { startTime: '22:00', endTime: '00:00', days: ['Friday', 'Saturday'] },
    { startTime: '15:00', endTime: '18:00', days: ['Friday', 'Saturday'] },
  ]);
  assert.equal(primary.startTime, '15:00');

  const afternoonOverLate = pickPrimaryWindow([
    { startTime: '15:00', endTime: '18:00', days: ['Monday'] },
    { startTime: '22:00', endTime: '00:00', days: ['Monday', 'Tuesday', 'Wednesday'] },
  ]);
  assert.equal(afternoonOverLate.startTime, '15:00');

  const skipAllDay = pickPrimaryWindow([
    { startTime: '11:00', endTime: '23:00', days: ['Monday'], allDay: true },
    { startTime: '15:00', endTime: '17:00', days: ['Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
  ]);
  assert.equal(skipAllDay.startTime, '15:00');
}

function testHappyHourFromPlace() {
  const place = {
    displayName: 'Test Bar',
    googleMapsUri: 'https://maps.google.com/?cid=1',
    regularSecondaryOpeningHours: [
      { secondaryHoursType: 'DELIVERY', periods: [] },
      {
        secondaryHoursType: 'HAPPY_HOUR',
        periods: [{ open: { day: 3, hour: 15, minute: 30 }, close: { day: 3, hour: 17, minute: 30 } }],
      },
    ],
  };
  const hh = happyHourFromPlace(place);
  assert.equal(hh.startTime, '15:30');
  assert.equal(hh.endTime, '17:30');
  assert.deepEqual(hh.days, ['Wednesday']);

  assert.equal(happyHourFromPlace({ displayName: 'No HH' }), null);
}

/** Chains must not inherit a sibling location's hours: a name-only match
 * against several locations is rejected unless the address disambiguates. */
function testMatchVenueToPlace() {
  const index = indexPlacesByName([
    { displayName: "BJ's", formattedAddress: '100 Main St, San Diego, CA' },
    { displayName: "BJ's", formattedAddress: '900 Broadway, San Diego, CA' },
    { displayName: 'Solo Spot', formattedAddress: '5 Pier Ave, San Diego, CA' },
  ]);

  assert.equal(matchVenueToPlace({ name: 'Solo Spot', address: 'anywhere' }, index).reason, 'name');
  assert.equal(
    matchVenueToPlace({ name: "BJ's", address: '900 Broadway' }, index).place.formattedAddress,
    '900 Broadway, San Diego, CA'
  );
  assert.equal(matchVenueToPlace({ name: "BJ's", address: 'no number' }, index).place, null);
  assert.equal(matchVenueToPlace({ name: 'Unknown', address: '1 A St' }, index).reason, 'no_name_match');
}

/** A verified claim publishes a venue the data pipeline left unlisted, without
 * waiting for a deploy. */
function testRankSitemapUrlsIncludesPdfMenus() {
  const ranked = rankSitemapUrls(
    [
      'https://example.com/menus/',
      'https://example.com/happy-hour-menu.pdf',
      'https://example.com/logo.png',
    ],
    'https://example.com'
  );
  assert.ok(ranked.some((row) => row.url.endsWith('happy-hour-menu.pdf')));
  assert.ok(!ranked.some((row) => row.url.endsWith('logo.png')));
}

function testClassifyMediaUrl() {
  assert.equal(classifyUrl('https://example.com/happy-hour.pdf'), 'pdf');
  assert.equal(classifyUrl('https://example.com/specials.jpg'), 'image');
  assert.ok(scoreMediaUrl('https://example.com/happy-hour-menu.pdf') >= 40);
  assert.ok(scoreMediaUrl('https://boujiemana.com/wp-content/uploads/2026/06/26-JUN-HH.pdf') >= 40);
  assert.equal(scoreMediaUrl('https://i0.wp.com/example.com/Cocktaildrinksandfood.webp'), 0);
  assert.equal(scoreMediaUrl('https://example.com/Sky-Deck-Happy-Hour-Cocktails-300x300.jpg'), 0);
}

function testSniffMediaIgnoresUrlExtension() {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const sniffed = sniffMediaFromBytes(jpeg);
  assert.equal(sniffed.mediaType, 'image/jpeg');
  assert.equal(
    anthropicMediaType('image', 'image/png', 'https://cdn.example.com/menu.png', jpeg),
    'image/jpeg'
  );
}

function testParseModelJsonRepairsTruncation() {
  const truncated = `{
  "found": true,
  "locationApplicability": "this_location",
  "windows": [{"days": ["Monday"], "startTime": "15:00", "endTime": "18:00"}],
  "deals": ["$5 pints", "$3.95 tacos"
`;
  const parsed = parseModelJson(truncated);
  assert.equal(parsed.found, true);
  assert.ok(parsed.deals.includes('$5 pints'));
}

function testDiscoverSpecialsMediaFindsPdf() {
  const html = `
    <a href="https://boujiemana.com/wp-content/uploads/2026/06/26-JUN-HH.pdf">Happy Hour Menu</a>
    <img alt="hero cocktails" src="https://i0.wp.com/boujiemana.com/Cocktaildrinksandfood.webp">
  `;
  const media = discoverSpecialsMedia(html, 'https://www.boujiemana.com/discover-kearny-mesa-happy-hour/');
  assert.ok(media.some((row) => /26-JUN-HH\.pdf/i.test(row.url)));
  assert.ok(!media.some((row) => /Cocktaildrinksandfood/i.test(row.url)));
}

function testSameSitePdfFromWwwOrigin() {
  const links = discoverInternalLinks(
    '<a href="https://boujiemana.com/wp-content/uploads/2026/06/26-JUN-HH.pdf">HH menu</a>',
    'https://www.boujiemana.com/'
  );
  assert.ok(links.some((path) => /26-JUN-HH\.pdf/i.test(path)));
}

function testSelectInventoryDropsOtherTenantPromos() {
  const inventory = {
    candidates: [
      { kind: 'html', url: 'https://delmarhighlandstowncenter.com/a-day-at-del-mar-highlands/happy-hour-at-sky-deck/' },
      { kind: 'html', url: 'https://www.delmarhighlandstowncenter.com/promotion/cinepolis-happy-hour/' },
      { kind: 'html', url: 'https://www.delmarhighlandstowncenter.com/menu' },
    ],
  };
  const scoped = selectInventoryForVenue(inventory, { name: 'Sky Deck at Del Mar Highlands Town Center' });
  const urls = scoped.candidates.map((row) => row.url).join(' ');
  assert.match(urls, /sky-deck/);
  assert.doesNotMatch(urls, /cinepolis/);
  assert.match(urls, /\/menu/);
}

function testApplyScrapeClearsFoodHallTenantDeals() {
  const venue = {
    name: 'Sky Deck at Del Mar Highlands Town Center',
    startTime: '14:00',
    endTime: '18:00',
    days: ['Monday'],
    deals: ['$2 off craft beer', '$3 off select wine'],
    dealsUnknown: false,
    hasHappyHourData: true,
    listingStatus: 'published',
    hhSources: { deals: { source: 'website_hh_page', url: 'https://example.com/sky-deck' } },
  };
  const result = applyScrape(venue, {
    found: true,
    multiTenant: true,
    confidence: 'high',
    source: 'ai',
    sourcePage: 'https://example.com/happy-hour-at-sky-deck/',
    startTime: '14:00',
    endTime: '18:00',
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    windows: [
      {
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        startTime: '14:00',
        endTime: '18:00',
        kind: 'happy_hour',
      },
      {
        days: ['Saturday'],
        startTime: '14:00',
        endTime: '16:00',
        kind: 'happy_hour',
        label: 'Weekend Happy Hour (Urbana)',
      },
    ],
    deals: [],
    evidence: [{ url: 'https://example.com/happy-hour-at-sky-deck/', quote: 'Monday through Friday from 4 PM to 6 PM at Ambrogio15, Craft House, Glass Box', field: 'times' }],
  });
  assert.equal(result.changed, true);
  assert.deepEqual(venue.deals, []);
  assert.equal(venue.dealsUnknown, true);
  assert.equal(venue.startTime, '16:00');
  assert.equal(venue.endTime, '18:00');
}

function testDiscoverSocialLinks() {
  const links = discoverSocialLinks(
    '<a href="https://instagram.com/tipsycrow">IG</a><a href="https://facebook.com/tipsycrow">FB</a>',
    'https://www.tipsycrow.com/'
  );
  assert.ok(links.some((row) => row.network === 'instagram'));
  assert.ok(links.some((row) => row.network === 'facebook'));
}

function testNormalizeAiNotFoundAndWindows() {
  const missing = normalizeAiHappyHourResult(
    { found: false, reason: 'No specials listed', locationApplicability: 'this_location', windows: [], deals: [], evidence: [] },
    'https://example.com/menu'
  );
  assert.equal(missing.found, false);
  assert.equal(missing.outcome, 'not_published');

  const otherLocation = normalizeAiHappyHourResult(
    {
      found: true,
      locationApplicability: 'other_location',
      startTime: '15:00',
      endTime: '18:00',
      days: ['Monday'],
      deals: ['$5 beer'],
    },
    'https://example.com/specials'
  );
  assert.equal(otherLocation.found, false);
  assert.equal(otherLocation.outcome, 'other_location');

  const multi = normalizeAiHappyHourResult(
    {
      found: true,
      locationApplicability: 'this_location',
      windows: [
        { days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '16:00', endTime: '18:00', kind: 'happy_hour' },
        { days: ['Friday', 'Saturday'], startTime: '22:00', endTime: '01:00', kind: 'late_night' },
      ],
      deals: ['$6 well drinks'],
      weeklySpecials: ['Wine Wednesday $6 glasses'],
      confidence: 'high',
      evidence: [
        { url: 'https://example.com/specials', quote: 'Happy Hour 4pm–6pm, $6 well drinks', field: 'times' },
      ],
    },
    'https://example.com/specials'
  );
  assert.equal(multi.found, true);
  assert.equal(multi.windows.length, 2);
  assert.ok(multi.deals.some((line) => /well drinks/i.test(line)));

  const salvage = normalizeAiHappyHourResult(
    {
      found: false,
      reason: 'Drinks listed but hours are on another page',
      locationApplicability: 'this_location',
      windows: [
        { days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday'], startTime: '15:00', endTime: '17:30', kind: 'happy_hour' },
      ],
      deals: ['HH Casa Margarita $13.50', 'HH Calidad Lager $5.50'],
      confidence: 'medium',
    },
    'https://example.com/menu#menu=happy-hour'
  );
  assert.equal(salvage.found, true);
  assert.ok(salvage.deals.length >= 2);
  assert.equal(salvage.windows.length, 1);
}

function testSalvageUsesEvidenceWhenModelLeavesDealsEmpty() {
  const salvaged = salvageFromEvidence({
    found: false,
    outcome: 'not_published',
    reason: 'Happy hour drinks menu with priced items found',
    evidence: [
      { url: 'https://example.com/menu#menu=happy-hour', quote: 'HH- Casa Margarita $13.50 ... HH Calidad Lager $5.50', field: 'deals' },
    ],
  });
  assert.equal(salvaged.found, true);
  assert.ok(salvaged.deals.some((line) => /margarita/i.test(line)));
  assert.ok(salvaged.deals.some((line) => /calidad/i.test(line)));
}

function testOpenUntilQuoteIsNotMidnight() {
  assert.equal(endTimeFromOpenUntilQuote('Golden Hour SUNDAY - THURSDAY OPEN-7PM'), '19:00');
  const windows = applyOpenUntilFromQuotes(
    [{ days: ['Sunday'], startTime: '17:00', endTime: '23:59', kind: 'happy_hour' }],
    [{ quote: 'Golden Hour { - BAR ONLY - } SUNDAY - THURSDAY OPEN-7PM', field: 'times' }]
  );
  assert.equal(windows[0].endTime, '19:00');
}

function testImplausibleWindowsRejected() {
  assert.equal(isPlausibleHappyHourWindow({ days: ['Monday'], startTime: '11:00', endTime: '22:00' }), false);
  assert.equal(isPlausibleHappyHourWindow({ days: ['Monday'], startTime: '11:00', endTime: '23:00', allDay: true }), true);
  assert.equal(normalizeWindows([{ days: ['Monday'], allDay: true, label: 'All day Monday' }]).length, 1);
  assert.equal(isPlausibleHappyHourWindow({ days: ['Monday'], startTime: '02:00', endTime: '08:00' }), false);
  assert.equal(isPlausibleHappyHourWindow({ days: ['Monday'], startTime: '19:00', endTime: '19:00' }), false);
  assert.equal(isPlausibleHappyHourWindow({ days: ['Friday'], startTime: '22:00', endTime: '01:00' }), true);
  assert.equal(normalizeWindows([{ days: ['Monday'], startTime: '15:00', endTime: '18:00' }]).length, 1);
}

function testAllDayWindowDoesNotStealTimedWeekdays() {
  const windows = normalizeWindows([
    {
      days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      allDay: true,
      label: 'Happy Hour',
    },
    {
      days: ['Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      startTime: '15:00',
      endTime: '18:00',
      kind: 'happy_hour',
    },
  ]);
  assert.deepEqual(windows.find((window) => window.allDay)?.days, ['Monday']);
  assert.deepEqual(
    windows.find((window) => !window.allDay)?.days,
    ['Tuesday', 'Wednesday', 'Thursday', 'Friday']
  );
}

function testSameHoursWindowsCollapseAcrossDaySplits() {
  const windows = normalizeWindows([
    { days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday'], startTime: '15:00', endTime: '17:30', kind: 'happy_hour' },
    { days: ['Friday'], startTime: '15:00', endTime: '17:30', kind: 'happy_hour' },
    { days: ['Saturday'], startTime: '15:00', endTime: '17:30', kind: 'happy_hour' },
    { days: ['Sunday'], startTime: '15:00', endTime: '17:30', kind: 'happy_hour' },
  ]);
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].days, [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
  ]);
}

function testCocktailSpecialPhotosAreNotMenuFlyers() {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const pages = selectMenuFlyerPages([
    {
      kind: 'image',
      ok: true,
      url: 'https://cdn.example.com/three-hour-tour-misadventure-cocktail-special.jpeg',
      bytes: jpeg,
      score: 30,
    },
  ]);
  assert.equal(pages.length, 0);
}

function testYardHouseDecorativeHhHeroesAreNotMenuFlyers() {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const pages = selectMenuFlyerPages([
    {
      kind: 'image',
      ok: true,
      url: 'https://media.yardhouse.com/images/yh-hh-footer-location-address-bg-d-1024w.jpg',
      bytes: jpeg,
      score: 40,
    },
    {
      kind: 'image',
      ok: true,
      url: 'https://media.yardhouse.com/images/yh-hh-late-night-bg-d-1024w.jpg',
      bytes: jpeg,
      score: 40,
    },
  ]);
  assert.equal(pages.length, 0);
}

function testConstraintOnlyDealsAreNotChips() {
  assert.equal(isJunkDealLine('(in bar area only)'), true);
  assert.equal(cleanDeals(['(in bar area only)', '$6 house margaritas']).join(','), '$6 house margaritas');
}

function testMenuBoardFromDealLinesRendersSpecials() {
  const board = menuBoardFromDealLines([
    '$2 off beers, wine, cocktails & appetizers',
    '50% off wings & wine Wednesday',
  ]);
  assert.equal(board.sections[0].items.length, 2);
  assert.equal(board.fromDealChips, true);
  const html = buildBoardHtml(board, {
    name: 'The Sandbox',
    windows: [{ days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '12:00', endTime: '17:00' }],
  });
  assert.ok(html.includes('The Sandbox'));
  assert.ok(html.includes('$2 off beers, wine, cocktails &amp; appetizers'));
  assert.ok(html.includes('Mon–Fri 12–5 PM'));
}

function testShoppingMallIsUnlisted() {
  assert.equal(looksLikeShoppingMall({
    name: 'Westfield UTC',
    website: 'https://www.westfield.com/en/united-states/utc',
  }), true);
  assert.equal(looksLikeShoppingMall({
    name: 'Fashion Valley',
    website: 'https://www.simon.com/mall/fashion-valley',
  }), true);
  assert.equal(looksLikeShoppingMall({
    name: 'Yard House',
    website: 'https://www.yardhouse.com/locations/ca/san-diego/san-diego-mission-valley-mall/8363',
  }), false);
  const venue = {
    name: 'Westfield UTC',
    website: 'https://www.westfield.com/en/united-states/utc',
    listingStatus: 'published',
    seoHidden: false,
    hasHappyHourData: true,
  };
  const result = applyScrape(venue, {
    found: false,
    outcome: 'not_published',
    reason: 'Westfield UTC is a shopping mall, not a restaurant or bar.',
  });
  assert.equal(venue.listingStatus, 'unlisted');
  assert.equal(venue.seoHidden, true);
  assert.ok(result.changed);
}

function testBuildBoardHtmlUsesEveryItemAndTwelveHourTimes() {
  const board = normalizeMenuBoard({
    note: '10% off entire regular menu',
    sections: [
      { title: 'Food', items: [{ name: 'Esquites', price: '$6' }, { name: 'Chips & Queso', price: '$5' }, { name: 'Deviled Eggs', price: '$15' }] },
      { title: 'Drinks', items: [{ name: 'Vodka Highball', price: '$6' }, { name: 'All Draft Cocktails', price: '$10' }] },
    ],
  });
  const html = buildBoardHtml(board, {
    name: 'Misadventure & Co',
    windows: [
      { days: ['Monday'], allDay: true },
      { days: ['Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '15:00', endTime: '18:00' },
    ],
  });
  for (const item of ['Esquites', 'Chips &amp; Queso', 'Deviled Eggs', 'Vodka Highball', 'All Draft Cocktails']) {
    assert.ok(html.includes(item), `board is missing ${item}`);
  }
  assert.ok(html.includes('Mon all day'));
  assert.ok(html.includes('Tue–Fri 3–6 PM'));
  // A generated board must never show a 24-hour clock.
  assert.ok(!/\b(?:15|18):00\b/.test(html));
}

function testBoardHoursNeverPrintAFabricatedStart() {
  const html = buildBoardHtml(
    { sections: [{ title: 'Bites', items: [{ name: 'Crispy Chicken Wings', price: '$18' }, { name: 'Draft Beer', price: '$7' }] }] },
    {
      name: 'Kingfisher',
      windows: [{
        days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'],
        startTime: '17:00',
        endTime: '19:00',
        startsAtOpen: true,
      }],
    }
  );
  assert.ok(html.includes('Sun–Thu Open until 7 PM'));
  assert.ok(!html.includes('5 PM–7 PM'));
}

function testOpenUntilWindowSurvivesWithoutAPublishedStart() {
  const evidence = [{
    url: 'http://kingfishersd.com/list',
    quote: 'Golden Hour { - BAR ONLY - } SUNDAY - THURSDAY OPEN-7PM',
    field: 'times',
  }];
  // A model with no start time to copy reaches for midnight, which reads as
  // operating hours and used to get the whole window discarded.
  const result = normalizeAiHappyHourResult({
    found: true,
    windows: [{
      days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'],
      startTime: '00:00',
      endTime: '23:59',
      kind: 'happy_hour',
      label: 'Golden Hour (Bar Only)',
    }],
    deals: ['$14 house cocktails'],
    evidence,
    confidence: 'high',
  }, 'http://kingfishersd.com/list');

  assert.equal(result.found, true);
  assert.equal(result.windows.length, 1);
  const [window] = result.windows;
  assert.equal(window.endTime, '19:00');
  assert.equal(window.startsAtOpen, true);
  assert.ok(isPlausibleHappyHourWindow(window), 'repaired window must be plausible');
  assert.deepEqual(window.days, ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']);
}

function testRepairOpenStartKeepsAPlausiblePublishedStart() {
  const evidence = [{ url: 'https://example.com', quote: 'Happy hour open-6pm daily', field: 'times' }];
  const [window] = repairOpenStartWindows(
    [{ days: ['Monday'], startTime: '15:00', endTime: '18:00' }],
    evidence
  );
  assert.equal(window.startTime, '15:00');
  assert.equal(window.startsAtOpen, true);
}

function testMenuRichnessPrefersTheFullerMenuPage() {
  // Popmenu's per-section permalink carries only the food half of the menu.
  const foodOnly = 'HH FOOD\nHH BBQ Spareribs $9\nHH Jerk Wings (4) $9\n';
  const foodAndDrinks = `${foodOnly}HH DRINKS\nCasa Margarita $13.50\nCalidad Lager $5.50\nAperol Spritz $14\n`;
  assert.ok(scoreMenuRichness(foodAndDrinks) > scoreMenuRichness(foodOnly));
  assert.ok(scoreMenuRichness('½ off wings and $2 off drafts') > 0);
}

function testMenuBoardFormatHelpers() {
  assert.equal(formatClock('17:30'), '5:30 PM');
  assert.equal(formatClock('15:00'), '3 PM');
  assert.equal(formatClock('00:30'), '12:30 AM');
  assert.equal(formatClock('nope'), '');
  assert.equal(formatDays(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']), 'Mon–Fri');
  assert.equal(formatDays(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']), 'Sun–Thu');
  assert.equal(formatDays(['Monday', 'Wednesday', 'Friday']), 'Mon, Wed, Fri');
  assert.equal(formatDays(['Friday', 'Saturday', 'Sunday']), 'Fri–Sun');
  assert.equal(
    formatDays(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']),
    'Daily'
  );
  assert.equal(formatWindow({ days: ['Thursday'], startTime: '19:30', endTime: '22:00' }), 'Thu 7:30–10 PM');
  assert.equal(formatWindow({ days: ['Monday'], startTime: '11:00', endTime: '13:00' }), 'Mon 11 AM–1 PM');
}

function testApplyScrapeRequiresEvidence() {
  const venue = {
    startTime: '16:00',
    endTime: '18:00',
    days: ['Monday'],
    deals: [],
    dealsUnknown: true,
    hhSources: { times: { source: 'google_places', url: null, observedAt: '2026-08-01' } },
    listingStatus: 'published',
    hasHappyHourData: true,
  };
  const withoutEvidence = applyScrape({ ...venue }, {
    found: true,
    confidence: 'high',
    source: 'ai',
    sourcePage: 'https://example.com/',
    startTime: '11:00',
    endTime: '22:00',
    days: ['Monday'],
    windows: [{ days: ['Monday'], startTime: '11:00', endTime: '22:00' }],
    deals: ['$5 beer'],
    evidence: [],
  });
  assert.equal(withoutEvidence.changed, false);

  const withEvidence = applyScrape({ ...venue, deals: [] }, {
    found: true,
    confidence: 'high',
    source: 'ai',
    sourcePage: 'https://example.com/specials',
    startTime: '15:00',
    endTime: '18:00',
    days: ['Monday', 'Tuesday'],
    windows: [{ days: ['Monday', 'Tuesday'], startTime: '15:00', endTime: '18:00', kind: 'happy_hour' }],
    deals: ['$5 beer'],
    evidence: [
      { url: 'https://example.com/specials', quote: 'Happy Hour 3pm to 6pm', field: 'times' },
      { url: 'https://example.com/specials', quote: '$5 beer', field: 'deals' },
    ],
  });
  assert.equal(withEvidence.changed, true);
  assert.ok(withEvidence.changes.some((change) => /times/.test(change)));
}

function testAiDealsDoNotNeedDollarSigns() {
  const sameRow = 'Happy Hour! 1/2 off all Draft Beers 04:20 PM - 06:00 PM';
  assert.equal(isJunkDealLine(cleanDeals([sameRow])[0] || sameRow), false);
  assert.ok(cleanDeals([sameRow]).some((line) => /1\/2 off all Draft Beers/i.test(line)));
  assert.equal(isRealDealLine('1/2 off all Draft Beers'), true);
  assert.equal(isRealDealLine('Half off all drafts'), true);

  const extracted = normalizeAiHappyHourResult(
    {
      found: true,
      locationApplicability: 'this_location',
      windows: [{
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        startTime: '16:20',
        endTime: '18:00',
        kind: 'happy_hour',
        label: 'Happy Hour - Half off all Draft Beers',
      }],
      deals: [],
      confidence: 'high',
      evidence: [
        { url: 'https://theharpoceanbeach.com/specials', quote: sameRow, field: 'times' },
      ],
    },
    'https://theharpoceanbeach.com/specials'
  );
  assert.ok(extracted.deals.some((line) => /half off all draft beers/i.test(line)));

  const venue = {
    startTime: '16:20',
    endTime: '18:00',
    days: ['Monday'],
    deals: [],
    dealsUnknown: true,
    listingStatus: 'published',
    hasHappyHourData: true,
  };
  const applied = applyScrape(venue, {
    ...extracted,
    source: 'ai',
  });
  assert.equal(applied.changed, true);
  assert.ok(applied.changes.some((change) => /deals/.test(change)));
  assert.ok(venue.deals.some((line) => /half off/i.test(line)));
}

function testOvernightHappyHourIsActiveAfterMidnight() {
  const schedule = {
    id: 9,
    days: ['Friday'],
    startTime: '22:00',
    endTime: '02:00',
  };
  const occurrence = getHappyHourOccurrenceForDate(schedule, '2026-08-21');
  assert.ok(occurrence);
  assert.equal(occurrence.endTime, '02:00');
  // Saturday 12:30am Pacific, still Friday's overnight window.
  assert.equal(isHappyHourActive(schedule, new Date('2026-08-22T07:30:00Z')), true);
  assert.equal(isHappyHourActive(schedule, new Date('2026-08-22T09:00:00Z')), false);
}

function testMultiWindowScheduleUsesLateNightToo() {
  const schedule = {
    id: 10,
    days: ['Monday'],
    startTime: '15:00',
    endTime: '18:00',
    windows: [
      { days: ['Monday'], startTime: '15:00', endTime: '18:00' },
      { days: ['Monday'], startTime: '22:00', endTime: '00:00' },
    ],
  };
  assert.equal(isHappyHourActive(schedule, new Date('2026-08-24T22:30:00Z')), true);
  assert.equal(isHappyHourActive(schedule, new Date('2026-08-25T06:30:00Z')), true);
}

function testAllDayWindowIsLiveThatCalendarDay() {
  const schedule = {
    id: 11,
    days: ['Tuesday'],
    startTime: '15:00',
    endTime: '17:00',
    windows: [
      { days: ['Monday'], startTime: '11:00', endTime: '23:00', allDay: true },
      { days: ['Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '15:00', endTime: '17:00' },
    ],
  };
  assert.equal(isHappyHourActive(schedule, new Date('2026-08-24T18:00:00Z')), true);
  assert.equal(isHappyHourActive(schedule, new Date('2026-08-25T22:30:00Z')), true);
}

/**
 * The owner found a brewery announcing happy hour at 3:13am. Its "all day
 * Monday" window was stored as the calendar day, so the open-now check was
 * right about the data and the data was wrong about the world.
 */
function testAnAllDayWindowIsNotLiveInTheSmallHours() {
  const schedule = {
    id: 347,
    days: ['Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    startTime: '15:00',
    endTime: '17:00',
    windows: [
      { days: ['Monday'], startTime: '11:00', endTime: '22:00', allDay: true },
      { days: ['Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '15:00', endTime: '17:00' },
    ],
  };
  // Monday 03:13 Pacific — the time the owner checked.
  assert.equal(isHappyHourActive(schedule, new Date('2026-08-31T10:13:00Z')), false);
  // Monday 16:00 Pacific, inside the service day it does run.
  assert.equal(isHappyHourActive(schedule, new Date('2026-08-31T23:00:00Z')), true);
  // Monday 22:00 Pacific, the moment it closes.
  assert.equal(isHappyHourActive(schedule, new Date('2026-09-01T05:00:00Z')), false);
}

/**
 * 03:13 Pacific is already the next UTC day, so a UTC-versus-Pacific slip
 * shows up here as the wrong weekday being matched.
 */
function testTheOpenNowCheckReadsTheSanDiegoWeekdayNotTheUtcOne() {
  const mondayOnly = {
    id: 1,
    days: ['Monday'],
    startTime: '11:00',
    endTime: '22:00',
    windows: [{ days: ['Monday'], startTime: '11:00', endTime: '22:00', allDay: true }],
  };
  // Tuesday 03:13 Pacific is Tuesday 10:13 UTC. Monday only, so not live —
  // and a UTC reading of the date would also say Tuesday, so pair it with the
  // case that actually distinguishes them: Monday 17:00 Pacific is Tuesday
  // 00:00 UTC, where a UTC reading would wrongly look for Tuesday.
  assert.equal(isHappyHourActive(mondayOnly, new Date('2026-09-01T10:13:00Z')), false);
  assert.equal(isHappyHourActive(mondayOnly, new Date('2026-09-01T00:00:00Z')), true);
}

function testAnUnboundedAllDayWindowIsRecognizedAndGivenServiceHours() {
  const unbounded = { days: ['Monday'], startTime: '00:00', endTime: '23:59', allDay: true };
  assert.equal(isUnboundedAllDayWindow(unbounded), true);
  // Already bounded, and a plain window that merely spans the day, are left be.
  assert.equal(isUnboundedAllDayWindow({ ...unbounded, startTime: '11:00', endTime: '22:00' }), false);
  assert.equal(isUnboundedAllDayWindow({ ...unbounded, allDay: false }), false);

  assert.deepEqual(boundAllDayWindow(unbounded, { openTime: '12:00', closeTime: '02:00' }), {
    days: ['Monday'], startTime: '12:00', endTime: '02:00', allDay: true,
  });
  // No published hours, so the conservative default service day.
  assert.deepEqual(boundAllDayWindow(unbounded, {}), {
    days: ['Monday'], startTime: '11:00', endTime: '22:00', allDay: true,
  });
}

/** No listing may go back to claiming happy hour round the clock. */
function testNoCatalogListingStoresAnUnboundedAllDayWindow() {
  const offenders = happyHours
    .filter((venue) => (venue.windows || []).some((window) => isUnboundedAllDayWindow(window)))
    .map((venue) => `${venue.name} (${venue.id})`);
  assert.deepEqual(offenders, []);
}

/**
 * The prose said "all day Monday" while the Monday chip sat unhighlighted,
 * because one renderer read the canonical windows and the other read the
 * primary-window mirror of them.
 */
function testHighlightedDaysCoverEveryWindowNotJustThePrimaryOne() {
  const venue = {
    days: ['Tuesday', 'Wednesday'],
    windows: [
      { days: ['Monday'], startTime: '11:00', endTime: '22:00', allDay: true },
      { days: ['Tuesday', 'Wednesday'], startTime: '15:00', endTime: '17:00' },
    ],
  };
  assert.deepEqual(happyHourDayNames(venue), ['Monday', 'Tuesday', 'Wednesday']);
  // Week order, not the order the windows happen to be stored in.
  assert.deepEqual(
    happyHourDayNames({ days: ['Saturday', 'Monday'], windows: [{ days: ['Sunday'] }] }),
    ['Sunday', 'Monday', 'Saturday']
  );
  assert.deepEqual(happyHourDayNames({ days: ['Friday'] }), ['Friday']);
  assert.deepEqual(happyHourDayNames({}), []);
}

/** Every day a listing advertises has to be a day it can be highlighted on. */
function testCatalogHighlightedDaysNeverOmitAScheduledDay() {
  const offenders = happyHours
    .filter((venue) => {
      const shown = happyHourDayNames(venue);
      return (venue.windows || []).some((window) =>
        (window.days || []).some((day) => !shown.includes(day))
      );
    })
    .map((venue) => `${venue.name} (${venue.id})`);
  assert.deepEqual(offenders, []);
}

/**
 * The point of storing the menu as text rather than as a photo of a menu: it
 * can be searched. "Pork belly bites" appears nowhere else in the record.
 */
function testMenuTextIsSearchable() {
  const venue = {
    name: 'San Diego Brewing Company',
    neighborhood: 'San Carlos',
    deals: ['$6 select house beers'],
    hhMenu: {
      note: 'All day Monday',
      sections: [{ title: 'Appetizers', items: [{ name: 'Pork belly bites', price: '$12' }] }],
    },
  };
  assert.deepEqual(venueMenuText(venue), ['All day Monday', 'Appetizers', 'Pork belly bites', '$12']);
  const haystack = venueSearchText(venue).join(' ').toLowerCase();
  assert.ok(haystack.includes('pork belly bites'));
  assert.ok(haystack.includes('appetizers'));
  // Still finds what it always found.
  assert.ok(haystack.includes('san carlos'));
  // A venue with no menu is unchanged rather than throwing.
  assert.deepEqual(venueMenuText({ name: 'No Menu' }), []);
}

/**
 * A menu section with a heading and no items under it is what the venue page
 * showed for San Diego Brewing Company, and what an extractor placeholder
 * leaves behind.
 */
function testEveryStoredMenuSectionHasItemsUnderIt() {
  const offenders = [];
  for (const venue of happyHours) {
    for (const section of venue.hhMenu?.sections || []) {
      if (!section.items?.length) offenders.push(`${venue.name} (${venue.id}): ${section.title}`);
    }
  }
  assert.deepEqual(offenders, []);
}

/** No deal chip may be an extractor annotation rather than an offer.
 *
 * Deliberately narrow. "House N/A wine" is a real offer — N/A is
 * non-alcoholic, not a missing value — so only bracketed annotations and
 * explicit statements of absence count. */
function testNoDealChipIsAnExtractorPlaceholder() {
  const placeholder = /\[[^\]]*\]|\bno items\b|\bnot listed\b|\bnone listed\b|\btbd\b/i;
  const offenders = [];
  for (const venue of happyHours) {
    for (const deal of venue.deals || []) {
      if (placeholder.test(deal)) offenders.push(`${venue.name} (${venue.id}): ${deal}`);
    }
  }
  assert.deepEqual(offenders, []);
}

/**
 * A photo of brewery tanks was captioned "Happy hour menu" because the caption
 * was a constant. Menu provenance now lives on hhMenu.sourceImages, so nothing
 * in the plain photo gallery may claim to be the menu.
 */
function testNoGalleryPhotoClaimsToBeTheMenuOfAVenueWithNoStoredMenu() {
  const offenders = happyHours
    .filter((venue) => !venue.hhMenu?.sections?.length)
    .filter((venue) => (venue.galleryImages || []).some((image) => /menu/i.test(image.caption || '')))
    .map((venue) => `${venue.name} (${venue.id})`);
  // Listings still awaiting a transcription are reported so the count cannot
  // grow silently; see docs/deal-and-menu-audit.md.
  assert.ok(offenders.length <= 20, `menu-captioned photos without a stored menu: ${offenders.length}`);
}

/**
 * Menu content and the board that displays it stay together.
 *
 * The board is the zoomable copy of the same text the page renders as HTML,
 * and it is what someone reading on a phone actually opens. It is also the
 * easiest thing in the pipeline to lose by accident: it lives in
 * `galleryImages`, which two other steps rewrite wholesale, so a venue can end
 * up with a full transcribed menu and no image of it without anything failing.
 */
function testEveryStoredMenuHasARenderedBoard() {
  const offenders = happyHours
    .filter((venue) => venue.hhMenu?.sections?.length)
    .filter((venue) => !(venue.galleryImages || []).some((image) => image.generated))
    .map((venue) => `${venue.name} (${venue.id})`);
  assert.deepEqual(offenders, [], `stored menu with no rendered board: ${offenders.join(', ')}`);
}

/**
 * A board is proof we drew it, so it must not be claimed for a scrape. The
 * flag is the only thing distinguishing our render from a venue's own flyer —
 * both are written as `<id>-<slug>-hh-menu*` — and a wrong one both hides a
 * missing board from the check above and makes `menus:render` skip the venue
 * forever.
 */
function testNoScrapedImageClaimsToBeOurBoard() {
  const offenders = [];
  for (const venue of happyHours) {
    for (const image of venue.galleryImages || []) {
      if (!image.generated) continue;
      // Our renderer writes the file itself, so the source is either absent or
      // the page the menu was read from — never a venue's media CDN.
      if (/popmenucloud|cloudfront|wixstatic|squarespace|shopify/i.test(image.sourceUrl || '')) {
        offenders.push(`${venue.name} (${venue.id}) ${image.caption}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `scraped images flagged as our board: ${offenders.join(', ')}`);
}

/**
 * Pagination never loses an item, whatever fits on a page.
 *
 * This is the property the four-section cap violated: it decided what to show
 * and threw the rest away. Asserted against adversarial fit functions —
 * including one where nothing ever fits and a single section of 300 items —
 * because those are the cases where a packing loop quietly drops a remainder.
 */
async function testMenuPaginationNeverDropsContent() {
  const menus = [
    [{ title: 'Beer', items: [{ name: 'Draft' }, { name: 'Bottles' }] }],
    Array.from({ length: 9 }, (_, s) => ({
      title: `Section ${s}`,
      items: Array.from({ length: 7 }, (_, i) => ({ name: `s${s} item${i}` })),
    })),
    [{ title: 'Everything', items: Array.from({ length: 300 }, (_, i) => ({ name: `item${i}` })) }],
    [
      { title: 'Snacks', items: [{ name: 'Olives' }] },
      { title: 'Tequila', items: Array.from({ length: 40 }, (_, i) => ({ name: `pour${i}` })) },
    ],
  ];
  const fitters = [
    async () => true,
    async () => false,
    ...[1, 3, 10].map((cap) => async (sections) =>
      sections.reduce((n, s) => n + s.items.length, 0) <= cap),
  ];

  for (const menu of menus) {
    const expected = menu.flatMap((s) => s.items.map((i) => `${s.title}|${i.name}`)).sort();
    for (const fits of fitters) {
      const pages = await packMenuSections(menu, fits);
      const got = pages.flat().flatMap((s) => s.items.map((i) => `${s.title}|${i.name}`)).sort();
      assert.deepEqual(got, expected, 'pagination dropped menu content');
      assert.ok(pages.length <= MAX_BOARD_PAGES, `pagination exceeded ${MAX_BOARD_PAGES} pages`);
      assert.ok(pages.every((page) => page.some((s) => s.items.length)), 'pagination produced an empty page');
    }
  }
}

/**
 * A venue's boards must together be a whole menu, not a first page.
 *
 * "A board exists" was too weak: a menu that paginates to three pages and
 * saves one is indistinguishable from a short menu unless the pages are
 * counted. The captions carry the count, so they have to agree with how many
 * images are actually stored.
 */
function testBoardPagesFormACompleteSequence() {
  const offenders = [];
  for (const venue of happyHours) {
    const boards = (venue.galleryImages || []).filter((image) => image.generated);
    if (boards.length <= 1) continue;
    const seen = boards
      .map((image) => /page (\d+) of (\d+)/i.exec(image.caption || ''))
      .map((match) => (match ? { page: Number(match[1]), total: Number(match[2]) } : null));
    if (seen.some((entry) => entry === null)) {
      offenders.push(`${venue.name} (${venue.id}): multi-page board without a page marker`);
      continue;
    }
    const total = seen[0].total;
    if (total !== boards.length || seen.some((entry) => entry.total !== total)) {
      offenders.push(`${venue.name} (${venue.id}): ${boards.length} board(s) claiming ${total} pages`);
      continue;
    }
    const pages = seen.map((entry) => entry.page).sort((a, b) => a - b);
    if (pages.some((page, index) => page !== index + 1)) {
      offenders.push(`${venue.name} (${venue.id}): pages ${pages.join(',')}`);
    }
  }
  assert.deepEqual(offenders, [], `incomplete board sequences: ${offenders.join('; ')}`);
}

/** Normalizing a menu for board layout must not discard its provenance. */
function testMenuNormalizationKeepsProvenance() {
  const normalized = normalizeMenuBoard({
    note: 'Happy hour',
    sections: [{ title: 'Beer', items: [{ name: 'Draft', price: '$6' }, { name: 'Bottles', price: '$5' }] }],
    sourceUrl: 'https://example.com/happy-hour',
    observedAt: '2026-08-31',
    sourceImages: [{ url: '/images/venues/1-x-hh-menu.jpg', caption: 'Flyer' }],
  });
  assert.equal(normalized.sourceUrl, 'https://example.com/happy-hour');
  assert.equal(normalized.observedAt, '2026-08-31');
  assert.equal(normalized.sourceImages.length, 1);
}

function testDealChipsCapAtSix() {
  assert.equal(MAX_DEAL_CHIPS, 6);
  const chips = cleanDeals([
    '$6 beers', '$8 wings', '$6 tacos', '$10 nachos', '$12 pork belly', '$5 wells', '$4 margs',
  ]);
  assert.equal(chips.length, 6);
  const venueLines = venueDealLines({ deals: chips.concat(['$1 extra']) });
  assert.equal(venueLines.length, 6);
}

function testPageMatchesVenueListing() {
  const venue = {
    name: 'Caffe Tazza',
    address: '374 E H St, Chula Vista, CA 91910, USA',
    neighborhood: 'Chula Vista',
    phone: '(619) 420-6460',
  };
  assert.equal(pageMatchesVenueListing('Visit Caffe Tazza at 374 E H St, Chula Vista. Wine bar happy hour.', venue), true);
  assert.equal(pageMatchesVenueListing('MUSANG178 casino jackpot bonus spin win big online slots today', venue), false);
  assert.equal(isUsableVenueWebsite('https://maps.google.com/?cid=1'), false);
  assert.equal(isUsableVenueWebsite('https://caffe-tazza.square.site/'), true);
  assert.equal(hostnameCorroboratesVenue('https://caffe-tazza.square.site/', venue), true);
  assert.equal(hostnameCorroboratesVenue('https://caffetazza.com/', venue), false);
  assert.equal(listingUrlCorroboratesVenue('https://caffetazza.com/', venue), false);

  const chain = {
    name: 'Texas de Brazil - Carlsbad',
    address: '2525 El Camino Real, Carlsbad, CA 92008, USA',
    neighborhood: 'Carlsbad',
  };
  assert.equal(
    listingUrlCorroboratesVenue('https://texasdebrazil.com/locations/carlsbad/?utm_source=gmb', chain),
    true
  );
  assert.equal(
    listingUrlCorroboratesVenue('https://texasdebrazil.com/specials/happy-hour/', chain),
    false
  );
}

function testVenueSearchTokensMatchGaslamplighter() {
  const venue = {
    name: 'Gaslamplighter Karaoke Cocktail Bar',
    neighborhood: 'Gaslamp',
    address: '536 Market St, San Diego, CA 92101, USA',
  };
  const gaslampNeighbor = {
    name: 'Rustic Root',
    neighborhood: 'Gaslamp',
    address: '535 5th Ave',
  };
  assert.equal(venueMatchesQuery(venue, 'gas lamp'), true);
  assert.equal(venueMatchesQuery(venue, 'karaoke'), true);
  assert.equal(venueMatchesQuery(venue, 'tazza'), false);
  assert.ok(venueSearchScore(venue, 'gas lamp') > venueSearchScore(gaslampNeighbor, 'gas lamp'));
}

async function testWrongWebsiteAndEmptyBlockedNotMediaUnreadable() {
  const emptyBlocked = await extractFromInventory(
    { blocked: true, candidates: [] },
    { name: 'Caffe Tazza' },
    { useAi: false },
  );
  assert.equal(emptyBlocked.outcome, 'blocked');

  const spam = await extractFromInventory({
    blocked: false,
    candidates: [{
      kind: 'html',
      url: 'https://caffetazza.com/',
      html: '<p>MUSANG178 casino jackpot bonus spin win big online slots</p>'.repeat(10),
      text: 'MUSANG178 casino jackpot bonus spin win big online slots '.repeat(10),
    }],
  }, {
    name: 'Caffe Tazza',
    address: '374 E H St, Chula Vista, CA 91910',
  }, { useAi: false });
  assert.equal(spam.outcome, 'wrong_website');

  const chainNational = await extractFromInventory({
    blocked: false,
    candidates: [{
      kind: 'html',
      url: 'https://texasdebrazil.com/specials/happy-hour/',
      html: '<h1>Happy Hour</h1><p>Monday through Friday from 4:30pm to 6:00pm. Starting at only $4.</p>'.repeat(4),
      text: 'Happy Hour Monday through Friday from 4:30pm to 6:00pm Starting at only $4 '.repeat(4),
    }],
  }, {
    name: 'Texas de Brazil - Carlsbad',
    address: '2525 El Camino Real, Carlsbad, CA 92008, USA',
    neighborhood: 'Carlsbad',
    website: 'https://texasdebrazil.com/locations/carlsbad/?utm_source=gmb',
  }, { useAi: false });
  assert.notEqual(chainNational.outcome, 'wrong_website');

  const brandedShell = await extractFromInventory({
    blocked: false,
    candidates: [{
      kind: 'html',
      url: 'http://kingfishersd.com/',
      html: '<p>Reserve now Order online Follow us</p>'.repeat(12),
      text: 'Reserve now Order online Follow us '.repeat(12),
    }],
  }, {
    name: 'Kingfisher',
    address: '2469 Broadway, San Diego, CA 92102, USA',
    neighborhood: 'East Village',
    website: 'http://kingfishersd.com/',
  }, { useAi: false });
  assert.notEqual(brandedShell.outcome, 'wrong_website');
  assert.equal(listedHostMatchesVenueName('http://kingfishersd.com/list', {
    name: 'Kingfisher',
    website: 'http://kingfishersd.com/',
  }), true);
}

function testSelectMenuFlyerPagesKeepsPopmenu() {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const pages = selectMenuFlyerPages([
    { kind: 'image', ok: true, url: 'https://popmenucloud.com/cdn-cgi/image/menu.png', bytes: jpeg, score: 20 },
    { kind: 'image', ok: true, url: 'https://i0.wp.com/example.com/Cocktaildrinksandfood.webp', bytes: jpeg, score: 8 },
  ]);
  assert.equal(pages.length, 1);
  assert.match(pages[0].url, /popmenucloud/);
}

function testPopmenuHeightParamIsNotAFlyer() {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const pages = selectMenuFlyerPages([
    {
      kind: 'image',
      ok: true,
      url: 'https://popmenucloud.com/cdn-cgi/image/width%3D1200%2Cheight%3D1200%2Cfit%3Dscale-down/ucjlhtos/1a7706ce.jpg',
      bytes: jpeg,
      score: 20,
    },
  ]);
  assert.equal(pages.length, 0);
}

function testSelectMenuFlyerPagesKeepsHhPdfNotDinnerMenu() {
  const pdf = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj');
  const pages = selectMenuFlyerPages([
    { kind: 'pdf', ok: true, url: 'https://boujiemana.com/wp-content/uploads/2026/06/26-JUN-HH.pdf', bytes: pdf, score: 48 },
    { kind: 'pdf', ok: true, url: 'https://example.com/food-menu.pdf', bytes: pdf, score: 26 },
  ]);
  assert.equal(pages.length, 1);
  assert.match(pages[0].url, /26-JUN-HH\.pdf/);
}

async function tinyPdfBytes() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [400, 600], margin: 40 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(28).text('Happy Hour Menu', { align: 'center' });
    doc.fontSize(16).text('Tue–Thu 2–5pm');
    doc.end();
  });
}

async function testRasterizePdfPagesToJpeg() {
  const images = await rasterizePdfPages(await tinyPdfBytes(), { maxPages: 1, scale: 1.5 });
  assert.equal(images.length, 1);
  assert.equal(images[0].mediaType, 'image/jpeg');
  assert.equal(images[0].bytes[0], 0xff);
  assert.equal(images[0].bytes[1], 0xd8);
  assert.ok(images[0].bytes.length > 800);
}

/** A verified claim publishes a venue the data pipeline left unlisted, without
 * waiting for a deploy. */
function testDiscoverSpecialsImagesFromTabFlyers() {
  const html = `
    <div id="tab-monday">
      <img alt="Mule Mondays" src="/wp-content/uploads/2023/11/Mule-Monday.jpg">
      <img alt="Drink Exch Mon" src="/wp-content/uploads/2024/07/Drink-Exch-Mon.jpg">
    </div>
    <img alt="logo" src="/logo.png">
  `;
  const images = discoverSpecialsImages(html, 'https://thetipsycrow.com/specials/');
  assert.equal(images.length, 2);
  assert.ok(images.some((row) => /Mule-Monday/.test(row.url)));
}

function testCardSpecialsPrefersToday() {
  const venue = {
    startTime: '15:00',
    endTime: '20:00',
    deals: ['fallback deal'],
    weeklySpecials: [
      {
        id: 'mule',
        label: 'Mule Mondays',
        days: ['Monday'],
        kind: 'named_night',
        summary: 'Mule Mondays',
        details: ['Mules'],
      },
      {
        id: 'exch',
        label: 'Drink Exchange',
        days: ['Monday'],
        kind: 'exchange',
        summary: 'Drink Exchange 3–8pm',
        details: ['Dynamic'],
        startTime: '15:00',
        endTime: '20:00',
      },
      {
        id: 'taco',
        label: 'Taco Tuesday',
        days: ['Tuesday'],
        kind: 'food',
        summary: 'Taco Tuesday drink specials',
        details: ['$6 drafts'],
      },
    ],
  };
  assert.deepEqual(cardSpecials(venue, 'Monday'), ['Mule Mondays', 'Drink Exchange 3–8pm']);
  assert.equal(cardTimeLabel(venue, 'Monday'), '3:00 PM – 8:00 PM');
  assert.ok(cardSpecials(venue).includes('Mule Mondays'));
}

function testCardSpecialsAreShortAndFallbackToHappyHour() {
  const khans = {
    deals: [
      '$5: Watching NFL with a couple of buds and looking for something to sip on? Try our draft of the day for five bucks.',
      '$6: Missing the vineyards? Order a couple six dollar house wines.',
      '$7: Had a tough day at work? Relax with our seven dollar martinis.',
      '$8: Want to try something new? Indulge with Khan’s Cave specialty cocktails!',
    ],
  };
  assert.deepEqual(cardSpecials(khans), ['$5 draft of the day', '$6 house wines', '$7 martinis']);
  assert.deepEqual(venueDealLines(khans), ['$5 draft of the day', '$6 house wines', '$7 martinis', '$8 specialty cocktails']);
  assert.deepEqual(cardSpecials({ deals: [] }), ['Happy hour']);
  // The venue page has a real empty state for this now, so the deal grid gets
  // nothing rather than the card's label. See the window-only tests below.
  assert.deepEqual(venueDealLines({ deals: [] }), []);
  const islands = 'Enjoy tasty bites & drinks from $3 - $10. Good vibes, great bites, and the coldest drinks in town—cheers!';
  assert.equal(shortDealLabel(islands), islands);
}

function testIsPubliclyListed() {
  assert.equal(isPubliclyListed({ id: 1, listingStatus: 'published' }), true);
  assert.equal(isPubliclyListed({ id: 2 }), true);
  assert.equal(isPubliclyListed({ id: 3, listingStatus: 'unlisted' }), false);
  assert.equal(isPubliclyListed({ id: 3, listingStatus: 'unlisted' }, new Set([3])), true);
  assert.equal(isPubliclyListed({ id: 3, listingStatus: 'unlisted' }, new Set([4])), false);
  assert.equal(isPubliclyListed({ id: 3, listingStatus: 'unlisted' }, null), false);
}

function testChainVenuesGetLocationSlugs() {
  const venues = [
    { id: 1, name: 'Karl Strauss Brewing Company', neighborhood: 'Sorrento Valley', address: '9675 Scranton Rd, San Diego' },
    { id: 2, name: 'Karl Strauss Brewing Company', neighborhood: 'Rancho Bernardo', address: '10448 Reserve Dr, San Diego' },
    { id: 3, name: 'Karl Strauss Brewing Company', neighborhood: 'Little Italy', address: '1157 Columbia St Ste 1167, San Diego' },
    { id: 4, name: 'Karl Strauss Brewing Company', neighborhood: 'Carlsbad', address: '5801 Armada Dr, Carlsbad' },
    { id: 5, name: 'Karl Strauss Brewing Company', neighborhood: 'Temecula', address: '40868 Winchester Rd, Temecula' },
    { id: 6, name: 'The Cork and Craft', neighborhood: 'Rancho Bernardo', address: '123 Main St' },
  ];
  const slugs = buildVenueSlugMap(venues);
  const karl = venues.slice(0, 5).map((venue) => slugFromMap(venue, slugs));
  assert.equal(new Set(karl).size, 5);
  assert.deepEqual(karl.sort(), [
    'karl-strauss-brewing-company-carlsbad',
    'karl-strauss-brewing-company-little-italy',
    'karl-strauss-brewing-company-rancho-bernardo',
    'karl-strauss-brewing-company-sorrento-valley',
    'karl-strauss-brewing-company-temecula',
  ]);
  assert.equal(slugFromMap(venues[5], slugs), 'the-cork-and-craft');
}

function testSameNeighborhoodChainGetsStreetSuffix() {
  const venues = [
    { id: 1, name: 'Dupes', neighborhood: 'North Park', address: '100 Main St, San Diego' },
    { id: 2, name: 'Dupes', neighborhood: 'North Park', address: '200 Oak Ave, San Diego' },
  ];
  const slugs = buildVenueSlugMap(venues);
  assert.equal(slugFromMap(venues[0], slugs), 'dupes-north-park-100-main-st');
  assert.equal(slugFromMap(venues[1], slugs), 'dupes-north-park-200-oak-ave');
}

function testCatalogVenueSlugsAreUnique() {
  const slugs = [...buildVenueSlugMap(happyHours).values()];
  assert.equal(new Set(slugs).size, slugs.length);
}

function testJsonMenuExtractionRecoversUnrenderedSections() {
  // Shape of a menu platform's API response: sections carry items, and only the
  // section the visitor selected is ever rendered into the DOM.
  const payload = {
    data: {
      menuSection: {
        name: 'HH Drinks',
        html: '<div>markup we must not mine for names</div>',
        subsections: [
          {
            name: null,
            enabledItems: [
              { __typename: 'MenuItem', name: 'HH- Casa Margarita', price: 13.5, description: null },
              { __typename: 'MenuItem', name: 'HH Calidad Lager', price: 5.5 },
              { __typename: 'MenuItem', name: 'Sold Out Thing', price: 0 },
            ],
          },
          {
            name: 'HH Food',
            enabledItems: [
              { name: 'HH Elote Avocado Bites', price: 7 },
              { name: 'HH Latin Sliders (2)', price: 9 },
            ],
          },
        ],
      },
    },
  };

  const text = menuTextFromJsonResponses([{ url: 'https://x/graphql', body: JSON.stringify(payload) }]);
  assert.match(text, /HH Drinks/);
  assert.match(text, /HH- Casa Margarita \$13\.50/);
  assert.match(text, /HH Calidad Lager \$5\.50/);
  assert.match(text, /HH Food/);
  assert.match(text, /HH Latin Sliders \(2\) \$9/);
  // A zero price means unavailable, not free.
  assert.doesNotMatch(text, /Sold Out Thing/);
}

function testJsonMenuExtractionIgnoresNonMenuJson() {
  const analytics = { events: [{ name: 'page_view', amount: 0 }], config: { theme: { name: 'dark' } } };
  assert.equal(menuTextFromJsonResponses([{ url: 'https://x/a', body: JSON.stringify(analytics) }]), '');
  assert.equal(menuTextFromJsonResponses([{ url: 'https://x/a', body: 'not json' }]), '');
}

function testJsonMenuExtractionMergesRepeatedResponses() {
  const first = { section: { name: 'Happy Hour', items: [{ name: 'Wings', price: 9 }] } };
  const second = {
    section: { name: 'Happy Hour', items: [{ name: 'Wings', price: 9 }, { name: 'Grilled Japanese Eggplant', displayPrice: '12' }] },
  };
  const text = menuTextFromJsonResponses([
    { url: 'https://x/1', body: JSON.stringify(first) },
    { url: 'https://x/2', body: JSON.stringify(second) },
  ]);
  assert.equal((text.match(/Wings/g) || []).length, 1);
  assert.match(text, /Grilled Japanese Eggplant \$12/);
}

async function testOnlyHappyHourPdfsAreSentToVision() {
  // A venue that publishes a happy-hour PDF publishes a separate one, so the
  // filename alone is enough to accept it.
  assert.equal(await pdfLooksLikeHappyHourMenu(Buffer.alloc(0), 'https://x.com/hh-menu.pdf'), true);
  assert.equal(await pdfLooksLikeHappyHourMenu(Buffer.alloc(0), 'https://x.com/happy-hour-menu.pdf'), true);
  assert.equal(await pdfLooksLikeHappyHourMenu(Buffer.alloc(0), 'https://x.com/dinner-menu.pdf'), false);

  const doc = new PDFDocument({ size: [612, 792] });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => doc.on('end', resolve));
  doc.fontSize(18).text('Cocktail List');
  doc.fontSize(12).text('Fords Gin, Raspberry, Rose, Lemon, Soda $17');
  doc.end();
  await done;
  const drinksBook = Buffer.concat(chunks);

  // A regular menu with a text layer and no happy hour is not evidence, and
  // reading it would invite a $17 cocktail to be reported as a deal.
  assert.equal(
    await pdfLooksLikeHappyHourMenu(drinksBook, 'https://x.com/PP-Second-Edition-2025-Menu.pdf'),
    false
  );
}

function testQuotedDayRangeFillsInADayTheModelDropped() {
  const evidence = [{
    url: 'https://kingfishersd.com/list',
    quote: 'Golden Hour { - BAR ONLY - } SUNDAY - THURSDAY OPEN-7PM',
    field: 'times',
  }];
  const [window] = repairDaysFromEvidence(
    [{ days: ['Sunday', 'Monday', 'Wednesday', 'Thursday'], startTime: '17:00', endTime: '19:00' }],
    evidence
  );
  assert.deepEqual(window.days, ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']);
}

function testQuotedDayRangeDoesNotWidenAnIntermittentSchedule() {
  const evidence = [{ quote: 'Taco Tuesday and Wine Wednesday, 3-6pm', field: 'times' }];
  const days = ['Tuesday', 'Wednesday'];
  const [unchanged] = repairDaysFromEvidence([{ days, startTime: '15:00', endTime: '18:00' }], evidence);
  assert.deepEqual(unchanged.days, days);

  // Days that skip the middle of the quoted range are a real schedule, not a
  // transcription slip, as long as they don't reach both ends.
  const monFri = [{ quote: 'Happy hour Monday - Friday 4-6pm', field: 'times' }];
  const [midweek] = repairDaysFromEvidence(
    [{ days: ['Tuesday', 'Wednesday'], startTime: '16:00', endTime: '18:00' }],
    monFri
  );
  assert.deepEqual(midweek.days, ['Tuesday', 'Wednesday']);
}

function testCloseIsPrintedInsteadOfTheStoredMidnightMinute() {
  assert.equal(
    formatWindow({ days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'], startTime: '22:00', endTime: '23:59' }),
    'Sun–Thu 10 PM–Close'
  );
  assert.equal(
    formatWindow({ days: ['Friday'], startTime: '15:00', endTime: '18:00' }),
    'Fri 3–6 PM'
  );
}

function testHappyHourPrefixesAreStrippedFromBoardCopy() {
  const board = normalizeMenuBoard({
    sections: [
      {
        title: 'HH Drinks',
        items: [
          { name: 'HH- Casa Margarita', price: '$13.50' },
          { name: 'Happy Hour Wings', price: '$9.00' },
          { name: 'HH', price: '$5' },
        ],
      },
    ],
  });
  assert.equal(board.sections[0].title, 'Drinks');
  assert.equal(board.sections[0].items[1].price, '$9');
  assert.deepEqual(board.sections[0].items.map((item) => item.name), ['Casa Margarita', 'Wings', 'HH']);
}

const tests = [
  testOnlyHappyHourPdfsAreSentToVision,
  testQuotedDayRangeFillsInADayTheModelDropped,
  testQuotedDayRangeDoesNotWidenAnIntermittentSchedule,
  testCloseIsPrintedInsteadOfTheStoredMidnightMinute,
  testHappyHourPrefixesAreStrippedFromBoardCopy,
  testJsonMenuExtractionRecoversUnrenderedSections,
  testJsonMenuExtractionIgnoresNonMenuJson,
  testJsonMenuExtractionMergesRepeatedResponses,
  testAnthropicBillingErrorIsDetected,
  testParseClockToken,
  testDaysFromRangeText,
  testParseTimeRangeNearHappyHour,
  testPreferSpecialsSliceKeepsHappyHourSection,
  testScoreHappyHourPage,
  testFlagVenue,
  testCompareVenueToScrape,
  testGetRegistrableDomain,
  testIsFallbackDeals,
  testDiscoverHappyHourLinksFromHtml,
  testBuildCandidateUrlsSkipsHomepageForAi,
  testDiscoverHappyHourLinksFollowsSitePaths,
  testGoldenHourAndListLinksAreDiscovered,
  testGuessedPathsYieldToDiscoveredOnes,
  testHomepageOutranksGuessedPaths,
  testMenuItemDetailUrlsAreNotCrawled,
  testCloudflareChallengeIgnoresTurnstileOnLivePages,
  testBuildCandidateUrlsPrioritizesKnownSource,
  testScoreSitemapUrl,
  testParseSitemapLocs,
  testRankSitemapUrls,
  testBuildCandidateUrlsSitemapOnly,
  testNormalizeAiHappyHourResult,
  testWindowsFromPeriods,
  testPickPrimaryWindow,
  testHappyHourFromPlace,
  testMatchVenueToPlace,
  testIsPubliclyListed,
  testRankSitemapUrlsIncludesPdfMenus,
  testClassifyMediaUrl,
  testSniffMediaIgnoresUrlExtension,
  testParseModelJsonRepairsTruncation,
  testDiscoverSpecialsMediaFindsPdf,
  testSameSitePdfFromWwwOrigin,
  testSelectInventoryDropsOtherTenantPromos,
  testApplyScrapeClearsFoodHallTenantDeals,
  testDiscoverSocialLinks,
  testNormalizeAiNotFoundAndWindows,
  testSalvageUsesEvidenceWhenModelLeavesDealsEmpty,
  testOpenUntilQuoteIsNotMidnight,
  testImplausibleWindowsRejected,
  testAllDayWindowDoesNotStealTimedWeekdays,
  testSameHoursWindowsCollapseAcrossDaySplits,
  testCocktailSpecialPhotosAreNotMenuFlyers,
  testYardHouseDecorativeHhHeroesAreNotMenuFlyers,
  testConstraintOnlyDealsAreNotChips,
  testMenuBoardFromDealLinesRendersSpecials,
  testShoppingMallIsUnlisted,
  testOpenUntilWindowSurvivesWithoutAPublishedStart,
  testRepairOpenStartKeepsAPlausiblePublishedStart,
  testMenuRichnessPrefersTheFullerMenuPage,
  testBuildBoardHtmlUsesEveryItemAndTwelveHourTimes,
  testBoardHoursNeverPrintAFabricatedStart,
  testMenuBoardFormatHelpers,
  testApplyScrapeRequiresEvidence,
  testAiDealsDoNotNeedDollarSigns,
  testOvernightHappyHourIsActiveAfterMidnight,
  testMultiWindowScheduleUsesLateNightToo,
  testAllDayWindowIsLiveThatCalendarDay,
  testEveryStoredMenuHasARenderedBoard,
  testMenuPaginationNeverDropsContent,
  testBoardPagesFormACompleteSequence,
  testNoScrapedImageClaimsToBeOurBoard,
  testMenuNormalizationKeepsProvenance,
  testDealChipsCapAtSix,
  testPageMatchesVenueListing,
  testVenueSearchTokensMatchGaslamplighter,
  testWrongWebsiteAndEmptyBlockedNotMediaUnreadable,
  testSelectMenuFlyerPagesKeepsPopmenu,
  testPopmenuHeightParamIsNotAFlyer,
  testSelectMenuFlyerPagesKeepsHhPdfNotDinnerMenu,
  testRasterizePdfPagesToJpeg,
  testDiscoverSpecialsImagesFromTabFlyers,
  testCardSpecialsPrefersToday,
  testCardSpecialsAreShortAndFallbackToHappyHour,
  testChainVenuesGetLocationSlugs,
  testSameNeighborhoodChainGetsStreetSuffix,
  testCatalogVenueSlugsAreUnique,
];

function testMenuPricesBecomeComparableNumbers() {
  assert.deepEqual(classifyPrice('$8'), {
    priceKind: 'fixed', priceAmount: 8, priceAmountMax: null, discountAmount: null, discountPercent: null,
  });
  // "$6.00" and "$6" must not sort or group differently.
  assert.equal(classifyPrice('$6.00').priceAmount, 6);

  // Two sizes of one pour, not two items.
  const range = classifyPrice('6/9');
  assert.equal(range.priceKind, 'range');
  assert.equal(range.priceAmount, 6);
  assert.equal(range.priceAmountMax, 9);

  assert.equal(classifyPrice('½ off').priceKind, 'half_off');
  assert.equal(classifyPrice('½ off').discountPercent, 50);
  assert.equal(classifyPrice('half off').discountPercent, 50);
  assert.equal(classifyPrice('25% off').priceKind, 'percent_off');
  assert.equal(classifyPrice('25% off').discountPercent, 25);
  assert.equal(classifyPrice('$2 off draft').priceKind, 'amount_off');
  assert.equal(classifyPrice('$2 off draft').discountAmount, 2);

  // Prose with no number is recorded rather than guessed at.
  assert.equal(classifyPrice('market price').priceKind, 'other');
  assert.equal(classifyPrice('').priceAmount, null);
}

function testMenuItemsAreCategorizedForCrossVenueQueries() {
  assert.equal(classifyCategory('Draft Beer'), 'beer');
  assert.equal(classifyCategory('House Margarita'), 'cocktail');
  assert.equal(classifyCategory('Pinot Noir'), 'wine');
  assert.equal(classifyCategory('Grilled Japanese Eggplant'), 'food');
  assert.equal(classifyCategory('Oysters on the half shell'), 'oysters');
  assert.equal(classifyCategory('Mocktail'), 'na_beverage');

  // Macro brands are only classifiable by name — there is no other signal
  // under a generic "Drinks" heading.
  assert.equal(classifyCategory('Coors Light', 'Drinks'), 'beer');
  assert.equal(classifyCategory('Stella Artois (11.2oz)', 'Drinks'), 'beer');

  // A frozen margarita is a cocktail, not a "rosé"-adjacent wine.
  assert.equal(classifyCategory('Frozen Rosé Margarita'), 'cocktail');
  // N/A beer is non-alcoholic before it is beer.
  assert.equal(classifyCategory('N/A Beer'), 'na_beverage');

  // The venue's own heading rescues house-invented names.
  assert.equal(classifyCategory('Phrings', 'Food'), 'food');
  assert.equal(classifyCategory('Corralejo', 'Tequila'), 'spirit');
  // A price-only heading carries no signal, so the name has to decide.
  assert.equal(classifyCategory('Onion Rings', '$3 Items'), 'food');
  assert.equal(classifyCategory('Del Sol', 'Drinks'), 'other');
}

function testMenuRowsFlattenSectionsInReadingOrder() {
  const rows = menuItemRows({
    sections: [
      { title: 'Bites', items: [{ name: 'Wings', price: '$8' }, { name: '', price: '$5' }] },
      { title: 'Draft', items: [{ name: 'Pilsner', price: '6/9' }] },
    ],
  });
  assert.equal(rows.length, 2, 'unnamed items are dropped');
  assert.deepEqual(rows.map((row) => row.name), ['Wings', 'Pilsner']);
  assert.deepEqual(rows.map((row) => row.sortOrder), [0, 1]);
  assert.equal(rows[0].category, 'food');
  assert.equal(rows[1].priceAmountMax, 9);
}

function testHouseNamedDrinksInheritTheirSectionsCategory() {
  // "Del Sol" matches no keyword and "Drinks" is a useless heading, but the
  // items printed next to it are cocktails.
  const cocktails = menuItemRows({
    sections: [{
      title: 'Drinks',
      items: [
        { name: 'Watermelon Rita', price: '$10' },
        { name: 'Classic Mojito', price: '$9' },
        { name: 'Del Sol', price: '$7' },
      ],
    }],
  });
  assert.deepEqual(cocktails.map((row) => row.category), ['cocktail', 'cocktail', 'cocktail']);

  // Same section heading, beer neighbours, so the unknown name is a beer.
  const beers = menuItemRows({
    sections: [{
      title: 'Drinks',
      items: [
        { name: 'Coors Light', price: '$4' },
        { name: 'Pacifico', price: '$5' },
        { name: "Phil's Favorite of the Month", price: '$5' },
      ],
    }],
  });
  assert.equal(beers[2].category, 'beer');

  // A genuinely mixed list must not be confidently mislabelled.
  const mixed = menuItemRows({
    sections: [{
      title: 'Drinks',
      items: [
        { name: 'Draft Beer', price: '$5' },
        { name: 'House Margarita', price: '$8' },
        { name: 'Transfusion', price: '$7' },
      ],
    }],
  });
  assert.equal(mixed[2].category, 'other');

  // One neighbour is not a majority to inherit from.
  const lonely = menuItemRows({
    sections: [{ title: '$9 Items', items: [{ name: 'Hot Sake', price: '$9' }, { name: 'Del Sol', price: '$9' }] }],
  });
  assert.equal(lonely[1].category, 'other');

  // Inference never overrides an item that classified on its own name.
  const explicit = menuItemRows({
    sections: [{
      title: 'Drinks',
      items: [
        { name: 'House Margarita', price: '$8' },
        { name: 'Classic Mojito', price: '$9' },
        { name: 'Draft Beer', price: '$5' },
      ],
    }],
  });
  assert.equal(explicit[2].category, 'beer');
}

function testModelCategoryFillsGapsButNeverOverridesTheItemName() {
  // The case keyword rules cannot reach: the model read the whole menu.
  assert.equal(classifyCategory('Del Sol', 'Drinks', 'cocktail'), 'cocktail');
  assert.equal(classifyCategory('Cottons', 'Tuesday', 'food'), 'food');

  // A verifiable name match wins, and the disagreement is reported.
  const conflict = classifyCategoryWithSource('Draft Beer', 'Drinks', 'cocktail');
  assert.equal(conflict.category, 'beer');
  assert.equal(conflict.source, 'name');
  assert.ok(conflict.modelDisagrees);

  // A bare "other" from the model adds nothing the rules don't have, so the
  // section heading still gets its turn.
  assert.equal(classifyCategory('Phrings', 'Food', 'other'), 'food');
  // Nor does a category we don't recognize.
  assert.equal(classifyCategory('Del Sol', 'Drinks', 'beverage'), 'other');

  const sourced = classifyCategoryWithSource('Del Sol', 'Drinks', 'cocktail');
  assert.equal(sourced.source, 'model');
  assert.ok(!sourced.modelDisagrees);

  // Provenance survives into the rows a sync writes.
  const rows = menuItemRows({
    sections: [{ title: 'Drinks', items: [{ name: 'Del Sol', price: '$7', category: 'cocktail' }] }],
  });
  assert.equal(rows[0].category, 'cocktail');
  assert.equal(rows[0].categorySource, 'model');
}

function testBrokenStorefrontTextNeverReachesABoard() {
  assert.ok(isSiteChrome('You have no products in your Frontpage collection.'));
  assert.ok(isSiteChrome('Menu | KINDRED Armory [empty page content]'));
  assert.ok(isSiteChrome('Page not found'));
  assert.ok(isSiteChrome('Add to cart'));
  assert.ok(!isSiteChrome('Grilled Japanese Eggplant'));
  assert.ok(!isSiteChrome('Deviled Eggs'));

  // A board made only of chrome is no board at all.
  assert.equal(
    normalizeMenuBoard({
      sections: [{
        title: 'Specials',
        items: [
          { name: 'You have no products in your Frontpage collection.', price: '' },
          { name: 'Menu | Somewhere [empty page content]', price: '' },
        ],
      }],
    }),
    null
  );

  const board = normalizeMenuBoard({
    sections: [{
      title: 'Specials',
      items: [
        { name: 'Add to cart', price: '' },
        { name: 'Deviled Eggs', price: '$7' },
        { name: 'Wings', price: '$9' },
      ],
    }],
  });
  assert.deepEqual(board.sections[0].items.map((item) => item.name), ['Deviled Eggs', 'Wings']);
}

// A Storepoint payload trimmed to the fields that matter: the offer lives in a
// free-text `description` with no price key, which is exactly what the priced
// menu miner walks past.
const LOCATOR_PAYLOAD = {
  results: {
    locations: [
      {
        id: 1,
        name: 'SCRIPPS RANCH',
        streetaddress: '9880 Hibert Street STE E-3 Scripps Ranch CA 92131',
        description: 'HAPPY HOUR | $2 off all pints\nEVERYDAY 3-6PM',
        loc_lat: 32.910701,
        loc_long: -117.108498,
      },
      {
        id: 2,
        name: 'MISSION VALLEY',
        streetaddress: '1640 Camino Del Rio N San Diego CA 92108',
        description: 'HAPPY HOUR | $2 off all beers\nEVERYDAY 3-6PM',
        loc_lat: 32.7665,
        loc_long: -117.1568,
      },
      {
        id: 3,
        name: 'SAN CLEMENTE',
        streetaddress: '979 Avenida Pico Unit C San Clemente CA 92673',
        description: '',
        loc_lat: 33.456033,
        loc_long: -117.604553,
      },
    ],
  },
};

function testLocatorWidgetApiIsFoundFromItsScriptTag() {
  const html = '<div id="storepoint-container" data-map-name="x"></div>'
    + '<script src="https://storepoint.co/api/v1/js/166117680d6ae4.js"></script>';
  const apis = detectLocatorApis(html, {});
  assert.equal(apis.length, 1);
  assert.equal(apis[0].platform, 'storepoint');
  assert.equal(apis[0].url, 'https://api.storepoint.co/v1/166117680d6ae4/locations');

  const stockist = detectLocatorApis('<div data-stockist-widget-tag="u10642">Loading…</div>', {
    lat: 32.7157,
    lng: -117.1611,
  });
  assert.equal(stockist[0].platform, 'stockist');
  assert.match(stockist[0].url, /stockist\.co\/api\/v1\/u10642\/locations\/search\?latitude=32\.7157/);
}

function testLocatorOfferSurvivesWithoutAPriceField() {
  const rows = locationsFromPayload(LOCATOR_PAYLOAD);
  assert.equal(rows.length, 3);
  const records = collectLocationRecordsFromJson(rows);
  // The location publishing nothing must not become a record.
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.name).sort(), ['MISSION VALLEY', 'SCRIPPS RANCH']);

  // The same payload through the priced-menu miner yields nothing, which is why
  // this second miner has to exist.
  assert.equal(menuTextFromJsonResponses([
    { url: 'https://api.storepoint.co/v1/x/locations', body: JSON.stringify(LOCATOR_PAYLOAD) },
  ]), '');
}

function testLocatorOffersAreMatchedPerLocationNotBrandWide() {
  const records = collectLocationRecordsFromJson(locationsFromPayload(LOCATOR_PAYLOAD));

  const scripps = matchLocatorRecord(records, {
    lat: 32.910701,
    lng: -117.108498,
    address: '9880 Hibert Street STE E-3, San Diego, CA 92131, USA',
  });
  assert.equal(scripps.method, 'coordinates');
  assert.match(scripps.record.offerText, /\$2 off all pints/);

  // Same brand, different store, genuinely different wording.
  const missionValley = matchLocatorRecord(records, {
    lat: 32.7665,
    lng: -117.1568,
    address: '1640 Camino Del Rio N, San Diego, CA 92108, USA',
  });
  assert.match(missionValley.record.offerText, /\$2 off all beers/);

  // A location that publishes no offer must stay empty rather than inherit a
  // sibling's deal — this is the venue we actually have stored.
  assert.equal(
    matchLocatorRecord(records, {
      lat: 33.456033,
      lng: -117.604553,
      address: '979 Avenida Pico Unit C, San Clemente, CA 92673, USA',
    }),
    null
  );

  // A venue nowhere near the brand never matches.
  assert.equal(
    matchLocatorRecord(records, { lat: 40.7128, lng: -74.006, address: '1 Wall St New York NY 10005' }),
    null
  );

  // Same brand a few blocks away is a *different* store, not this one. ~880m
  // from the Mission Valley record, well inside the same neighborhood.
  assert.equal(
    matchLocatorRecord(records, { lat: 32.7744, lng: -117.1568, address: 'unknown' }),
    null
  );
}

function testLocatorLinksRankBelowSpecialsAndMenus() {
  const html = `
    <a href="/specials">Specials</a>
    <a href="/menu">Menu</a>
    <a href="/locations">Locations</a>
  `;
  const links = discoverHappyHourLinksFromHtml(html, 'https://example.com');
  const score = (path) => links.find((link) => link.path.includes(path))?.score ?? 0;
  assert.ok(score('/locations') > 0, 'locator link should be followed at all');
  assert.ok(score('/locations') < score('/menu'), 'locator must not outrank a menu');
  assert.ok(score('/locations') < score('/specials'), 'locator must not outrank specials');
}

function testAChainPageMustBelongToThisBranch() {
  // The real failure: a La Costa cinema was given the Vista theater's hours.
  // On a chain site every branch page says "Happy Hour", so the likely error
  // is a plausible answer about the wrong restaurant, not a blank one.
  const laCosta = { name: 'Cinépolis La Costa', address: '6941 El Camino Real, Carlsbad, CA 92009' };
  assert.equal(conflictsWithVenue('https://www.cinepolisusa.com/vista/theater-details', laCosta), true);

  // Cardiff is not in the neighborhood vocabulary, so the city has to be read
  // off the address or a Coronado page looks harmless for a Cardiff venue.
  const cardiff = { name: 'Chart House', address: '2588 S Coast Hwy 101, Cardiff, CA 92007' };
  assert.equal(cityFromAddress(cardiff.address), 'cardiff');
  assert.equal(conflictsWithVenue('https://www.chart-house.com/location/chart-house-coronado-ca/', cardiff), true);
  assert.equal(conflictsWithVenue('https://www.chart-house.com/location/chart-house-cardiff-ca/', cardiff), false);

  // A page naming nowhere is not evidence of the wrong branch; most pages name
  // nowhere, and treating that as a conflict would reject the entire web.
  const indie = { name: 'The Grass Skirt', address: '910 Grand Ave, San Diego, CA 92109', neighborhood: 'Pacific Beach' };
  assert.equal(conflictsWithVenue('http://thegrassskirt.com/happy-hour', indie), false);

  // Neighborhoods count too, not just cities.
  const littleItaly = { name: 'Ironside', address: '1654 India St, San Diego, CA 92101', neighborhood: 'Little Italy' };
  assert.equal(conflictsWithVenue('https://example.com/locations/gaslamp', littleItaly), true);

  // Street number and ZIP pick this branch out of a chain's many pages.
  const applebees = { name: "Applebee's", address: '610 Palomar St, Chula Vista, CA 91911' };
  const picked = pickLocationPage(
    [
      'https://restaurants.applebees.com/en-us/ca/el-cajon/123-main-st-99',
      'https://www.applebees.com/happy-hour',
      'https://restaurants.applebees.com/en-us/ca/chula-vista/610-palomar-st-77062',
    ],
    applebees
  );
  assert.equal(picked.url, 'https://restaurants.applebees.com/en-us/ca/chula-vista/610-palomar-st-77062');
}

function testDedupeSeesVenuesTheCacheStoresAsPlainStrings() {
  const existing = [
    { name: 'Board & Brew', lat: 32.910701, lng: -117.108498, placeId: 'ChIJabc' },
  ];

  // Google sends `{ text }`, the enrich cache flattens it to a string. Reading
  // only `.text` made every name undefined, so nothing ever matched and
  // staging offered to re-add all 534 venues already in the catalog.
  const fromCache = { displayName: 'Board & Brew', location: { latitude: 32.910701, longitude: -117.108498 } };
  const fromGoogle = { displayName: { text: 'Board & Brew' }, location: { latitude: 32.910701, longitude: -117.108498 } };
  assert.equal(dedupeRecords([fromCache], existing).kept.length, 0);
  assert.equal(dedupeRecords([fromGoogle], existing).kept.length, 0);

  // The catalog keeps the id at the top level; `_import` is empty on all of
  // them, so matching on `_import` alone caught nothing.
  const byId = { googlePlaceId: 'ChIJabc', displayName: 'Renamed Since Import', location: { latitude: 1, longitude: 1 } };
  assert.equal(dedupeRecords([byId], existing).kept.length, 0);

  // A genuinely new venue still gets through, and a same-name venue far away
  // is a different location, not a duplicate.
  const newVenue = { displayName: 'Somewhere Else', location: { latitude: 32.7, longitude: -117.2 } };
  assert.equal(dedupeRecords([newVenue], existing).kept.length, 1);
  const otherBranch = { displayName: 'Board & Brew', location: { latitude: 32.98, longitude: -117.07 } };
  assert.equal(dedupeRecords([otherBranch], existing).kept.length, 1);

  // A nameless record must not collapse into every nameless venue.
  assert.equal(dedupeRecords([{ location: { latitude: 32.9, longitude: -117.1 } }], [{ name: '', lat: 32.9, lng: -117.1 }]).kept.length, 1);
}

function testFoundWithoutAScheduleIsNotAFinding() {
  // Real results from the recovery run: the model reported found, but one had
  // only a page title and another only "Come by for a Happy Hour".
  assert.equal(hasUsableSchedule({ found: true, startTime: undefined, endTime: undefined, days: ['Monday'] }), false);
  assert.equal(hasUsableSchedule({ found: true, startTime: '15:00', endTime: '18:00', days: [] }), false);
  assert.equal(hasUsableSchedule({ found: false, startTime: '15:00', endTime: '18:00', days: ['Monday'] }), false);
  assert.equal(hasUsableSchedule({ found: true, startTime: '25:00', endTime: '18:00', days: ['Monday'] }), false);
  assert.equal(hasUsableSchedule({ found: true, startTime: '15:00', endTime: '18:00', days: ['Monday'] }), true);
}

function testCountyComesFromGoogleNotTheBoundsRectangle() {
  const orange = {
    formattedAddress: '979 Avenida Pico Unit C, San Clemente, CA 92673, USA',
    addressComponents: [{ types: ['administrative_area_level_2'], longText: 'Orange County' }],
  };
  const sanDiego = {
    formattedAddress: '9880 Hibert St, San Diego, CA 92131, USA',
    addressComponents: [{ types: ['administrative_area_level_2'], longText: 'San Diego County' }],
  };
  assert.equal(classifyCounty(orange).inCounty, false);
  assert.equal(classifyCounty(orange).basis, 'google');
  assert.equal(classifyCounty(sanDiego).inCounty, true);

  // Temecula (Riverside, 33.494N) sits *north* of Fallbrook (San Diego,
  // 33.376N), so no latitude cutoff separates them — only the county does.
  const temecula = {
    formattedAddress: '28699 Old Town Front St, Temecula, CA 92590, USA',
    addressComponents: [{ types: ['administrative_area_level_2'], longText: 'Riverside County' }],
  };
  assert.equal(classifyCounty(temecula).inCounty, false);

  // Missing county data is not disqualifying on its own.
  assert.equal(classifyCounty(null, '2707 Congress St, San Diego, CA 92110, USA').inCounty, true);
  assert.equal(classifyCounty(null, '204 Avenida Del Mar, San Clemente, CA 92672, USA').inCounty, false);
  assert.equal(classifyCounty(null, '204 Avenida Del Mar, San Clemente, CA 92672, USA').basis, 'address');

  // "Corona" must not swallow Coronado.
  assert.equal(classifyCounty(null, '170 Orange Ave, Coronado, CA 92118, USA').inCounty, true);
}

function testCatalogHasNoPublishedOutOfCountyVenues() {
  const published = happyHours.filter((venue) => venue.listingStatus === 'published');
  const strays = published.filter((venue) => classifyCounty(null, venue.address).inCounty === false);
  assert.deepEqual(strays.map((venue) => venue.name), []);
}

/**
 * Stub listings exist so an owner can find and claim a venue we have no happy
 * hour for. The whole point is that they are reachable and claimable while
 * staying off browse surfaces, so both halves are worth pinning down.
 */
function testAStubIsClaimableButNeverBrowsable() {
  const stubs = happyHours.filter((venue) => venue.hasHappyHourData === false && !venue.startTime);
  assert.ok(stubs.length > 0, 'expected the catalog to carry claimable stubs');

  const browsable = stubs.filter((venue) => venue.listingStatus !== 'unlisted');
  assert.deepEqual(browsable.map((venue) => venue.name), []);

  // Anything the claim search shows has to be identifiable in a dropdown row.
  const unidentifiable = stubs.filter((venue) => !venue.name || !venue.address || !venue.neighborhood);
  assert.deepEqual(unidentifiable.map((venue) => venue.id), []);
}

/**
 * A window on a stub would render as a real happy hour on its venue page, so
 * "we don't know" has to stay absent rather than become a placeholder.
 */
function testAStubCarriesNoInventedHappyHour() {
  const stubs = happyHours.filter((venue) => venue.hasHappyHourData === false && !venue.startTime);
  const invented = stubs.filter(
    (venue) => venue.endTime || venue.days?.length || venue.deals?.length || venue.windows?.length
  );
  assert.deepEqual(invented.map((venue) => venue.name), []);
}

tests.push(
  testAStubIsClaimableButNeverBrowsable,
  testAStubCarriesNoInventedHappyHour,
  testAChainPageMustBelongToThisBranch,
  testDedupeSeesVenuesTheCacheStoresAsPlainStrings,
  testFoundWithoutAScheduleIsNotAFinding,
  testCountyComesFromGoogleNotTheBoundsRectangle,
  testCatalogHasNoPublishedOutOfCountyVenues,
  testLocatorWidgetApiIsFoundFromItsScriptTag,
  testLocatorOfferSurvivesWithoutAPriceField,
  testLocatorOffersAreMatchedPerLocationNotBrandWide,
  testLocatorLinksRankBelowSpecialsAndMenus,
);

/**
 * The deal text is the only thing that says what a happy hour discounts.
 * Google's place `types` used to feed the same derivation, and because its
 * taxonomy carries a literal `food` type on 91% of eating establishments, every
 * venue came out labelled `food` whatever its offers said.
 */
function testDealTypesComeFromTheVenuesOwnDealText() {
  assert.deepEqual(
    inferDealTypes(['$1.50 oysters', '$6 beers', '$8 wines', '$9 cocktails']),
    ['beer', 'cocktails', 'wine', 'oysters']
  );
  assert.deepEqual(inferDealTypes(['$5 select draft beers', '$6 Lager']), ['beer']);
  assert.deepEqual(inferDealTypes(['$5 wells', 'Half-price apps']), ['cocktails', 'food']);
  assert.deepEqual(inferDealTypes(['½ price games', '$10 for 10 wings']), ['food', 'entertainment']);
  // A price quoted against the beer rather than the word "beer".
  assert.deepEqual(inferDealTypes(['Bud Light, Victoria, Pacifico']), ['beer']);
  // Sangria is wine and a mimosa is sold as a cocktail, whatever is in it.
  assert.deepEqual(inferDealTypes(['$7 sangria']), ['wine']);
  assert.deepEqual(inferDealTypes(['$5 mimosas']), ['cocktails']);
}

/**
 * The old derivation defaulted to `food`, which is how 525 venues came to carry
 * `['food']` and nothing else. Naming no deal type is the honest answer, and it
 * is what `dealsUnknown` already says about the same venues.
 */
function testAVenueWithNoReadableOffersNamesNoDealType() {
  assert.deepEqual(inferDealTypes([]), []);
  assert.deepEqual(inferDealTypes(['Happy hour every day']), []);
}

/**
 * Google's cached alcohol booleans say what a venue pours; the deal text says
 * what it discounts. So they fill a silence and never contradict a statement —
 * a brewery that also serves wine stays un-filterable under wine.
 */
function testAlcoholBooleansFillASilenceButNeverOverrideDealText() {
  const servesEverything = { servesBeer: true, servesWine: true, servesCocktails: true };
  assert.deepEqual(inferDealTypes(['$5 tacos'], servesEverything), ['beer', 'cocktails', 'wine', 'food']);
  assert.deepEqual(inferDealTypes(['$5 draft beers'], servesEverything), ['beer']);
  assert.deepEqual(inferDealTypes([], { servesBeer: true, servesWine: false }), ['beer']);
  assert.deepEqual(inferDealTypes([]), []);
}

/**
 * The stored values went stale once, when deal text was cleaned and refreshed
 * after import, and filtering for beer then hid 210 venues advertising beer on
 * the same page. Anything the deal text names has to be on the listing.
 */
function testCatalogDealTypesStillAgreeWithTheirDealText() {
  const scheduled = happyHours.filter((venue) => venue.startTime && venue.deals?.length);
  const contradicted = scheduled.filter((venue) => {
    const derived = inferDealTypes(venue.deals);
    return derived.some((type) => !(venue.dealTypes || []).includes(type));
  });
  assert.deepEqual(contradicted.map((venue) => venue.name), []);
}

/**
 * An import that finds a window but no offers used to be labelled `food`
 * anyway, because the validator demanded a non-empty dealTypes. It no longer
 * does, so the listing goes out saying what it actually knows: the same answer
 * `dealsUnknown` gives about the deal text it was derived from.
 */
function testAnImportWithNoReadableOffersInventsNoDealType() {
  const record = {
    displayName: { text: 'Silent About Its Offers' },
    formattedAddress: '100 Test St, San Diego, CA 92101',
    location: { latitude: 32.7157, longitude: -117.1611 },
    websiteUri: 'https://example.com',
    types: ['restaurant', 'food', 'point_of_interest'],
    happyHour: {
      days: ['Monday'],
      startTime: '15:00',
      endTime: '18:00',
      deals: [],
      confidence: 'high',
      sourcePage: 'https://example.com/happy-hour',
    },
  };
  const venue = normalizeVenue(record, 9001);
  assert.equal(venue.dealsUnknown, true);
  assert.deepEqual(venue.deals, []);
  assert.deepEqual(venue.dealTypes, []);
}

/**
 * `dealTypes` drives the deal filter, so a value nobody derived from anything
 * is a false positive for every reader who uses it. The catalog may only leave
 * it empty, and may only leave it empty where the offers are unknown.
 */
function testCatalogDealTypesAreEmptyOnlyWhereTheOffersAreUnknown() {
  const scheduled = happyHours.filter((venue) => venue.startTime && venue.endTime);
  const emptyWithKnownDeals = scheduled.filter(
    (venue) => !(venue.dealTypes || []).length && venue.dealsUnknown !== true
  );
  assert.deepEqual(emptyWithKnownDeals.map((venue) => venue.name), []);

  const knownOffersWithoutTypes = scheduled.filter(
    (venue) => venue.deals?.length && !(venue.dealTypes || []).length
  );
  assert.deepEqual(knownOffersWithoutTypes.map((venue) => venue.name), []);
}

/**
 * The `food` default put `['food']` on 162 venues that publish no offers at
 * all. Nothing about those pages says food is discounted, so nothing on the
 * listing should claim it: the only drink types left on them come from
 * Google's cached alcohol booleans, which are at least an observation.
 */
function testVenuesWithNoDealTextClaimNoFoodDiscount() {
  const invented = happyHours.filter(
    (venue) => venue.dealsUnknown === true && (venue.dealTypes || []).some((type) => !['beer', 'cocktails', 'wine'].includes(type))
  );
  assert.deepEqual(invented.map((venue) => venue.name), []);
}

/**
 * `features` was `casual` on 99.5% of the catalog and inferred from Google's
 * place types rather than read off anything, so it said nothing about any
 * venue (docs/features-field-experiment.md). It is gone, and an import must
 * not quietly start writing it again.
 */
function testNoListingCarriesTheRemovedFeaturesField() {
  const carriers = happyHours.filter((venue) => 'features' in venue);
  assert.deepEqual(carriers.map((venue) => venue.name), []);
}

/**
 * The amenities that replaced it are Google's, not ours, and they have three
 * states rather than two: true, false, and nobody asked. Absent has to stay
 * absent — writing `false` for an unanswered venue is the defect that made
 * `features` unusable, inverted.
 */
const ATMOSPHERE_BOOLEANS = [
  'outdoorSeating',
  'allowsDogs',
  'reservable',
  'liveMusic',
  'restroom',
  'goodForGroups',
  'goodForWatchingSports',
  'servesVegetarianFood',
];

function testAmenitiesAreBooleanOrAbsentButNeverGuessed() {
  const mistyped = happyHours.filter((venue) =>
    ATMOSPHERE_BOOLEANS.some(
      (field) => field in venue && typeof venue[field] !== 'boolean'
    )
  );
  assert.deepEqual(mistyped.map((venue) => venue.name), []);

  // Atmosphere has now been bought for the 2,787 place ids the catalog carries,
  // so this used to assert nobody was answered and now asserts the opposite.
  // What it cannot become is a completeness check: Google answered `allowsDogs`
  // for roughly a third of the catalog and `outdoorSeating` for two thirds, and
  // the venues it stayed silent about must keep the key absent rather than
  // gain a `false` (docs/places-api-cost-analysis.md §5).
  const answered = happyHours.filter((venue) =>
    ATMOSPHERE_BOOLEANS.some((field) => field in venue)
  );
  assert.ok(
    answered.length > 1000,
    `expected the capture run's amenities in the catalog, found ${answered.length}`
  );

  // The silence is the part worth pinning: if a later merge ever starts
  // defaulting, this is what notices.
  const silent = happyHours.filter((venue) => !('allowsDogs' in venue));
  assert.ok(
    silent.length > 0,
    'expected venues Google never answered to keep the key absent, not false'
  );
}

/**
 * Google's grouped booleans carry the same three states one level down, and an
 * empty object is the shape that quietly breaks the rule: it reads as "we asked
 * and the answer is nothing" where the truth is that no sub-key was answered.
 */
function testGroupedAmenitiesAreNeverPublishedEmpty() {
  const groups = ['parkingOptions', 'paymentOptions', 'accessibilityOptions'];
  const empty = happyHours.filter((venue) =>
    groups.some((field) => field in venue && Object.keys(venue[field]).length === 0)
  );
  assert.deepEqual(empty.map((venue) => venue.name), []);

  const nonBoolean = happyHours.filter((venue) =>
    groups.some(
      (field) =>
        field in venue &&
        Object.values(venue[field]).some((value) => typeof value !== 'boolean')
    )
  );
  assert.deepEqual(nonBoolean.map((venue) => venue.name), []);
}

/**
 * The two fields the capture run proved Google has nothing to say about. They
 * were in the mask, they cost the same as everything else, and they came back
 * empty for all 2,787 venues — so nothing should be modelling them.
 */
function testFieldsGoogleNeverAnswersAreNotPublished() {
  const modelled = happyHours.filter(
    (venue) => 'openingDate' in venue || 'subDestinations' in venue
  );
  assert.deepEqual(modelled.map((venue) => venue.name), []);
}

/**
 * The importer reads the two amenities off the Atmosphere fields and writes
 * nothing at all when they are missing, which is what every record looks like
 * until a run with IMPORT_CAPTURE_ALL=1 pays for them.
 */
function testAmenitiesAreWrittenOnlyWhenGoogleAnswered() {
  const record = {
    displayName: { text: 'Atmosphere Unknown' },
    formattedAddress: '100 Test St, San Diego, CA 92101',
    location: { latitude: 32.7157, longitude: -117.1611 },
    websiteUri: 'https://example.com',
    types: ['bar'],
    happyHour: {
      days: ['Monday'],
      startTime: '15:00',
      endTime: '18:00',
      deals: ['$5 beers'],
      confidence: 'high',
      sourcePage: 'https://example.com/happy-hour',
    },
  };
  const silent = normalizeVenue(record, 9002);
  assert.equal('outdoorSeating' in silent, false);
  assert.equal('allowsDogs' in silent, false);

  const captured = normalizeVenue({ ...record, outdoorSeating: true, allowsDogs: false }, 9003);
  assert.equal(captured.outdoorSeating, true);
  assert.equal(captured.allowsDogs, false);
}

tests.push(
  testNoListingCarriesTheRemovedFeaturesField,
  testAmenitiesAreBooleanOrAbsentButNeverGuessed,
  testGroupedAmenitiesAreNeverPublishedEmpty,
  testFieldsGoogleNeverAnswersAreNotPublished,
  testAmenitiesAreWrittenOnlyWhenGoogleAnswered,
  testDealTypesComeFromTheVenuesOwnDealText,
  testAVenueWithNoReadableOffersNamesNoDealType,
  testAlcoholBooleansFillASilenceButNeverOverrideDealText,
  testCatalogDealTypesStillAgreeWithTheirDealText,
  testAnImportWithNoReadableOffersInventsNoDealType,
  testCatalogDealTypesAreEmptyOnlyWhereTheOffersAreUnknown,
  testVenuesWithNoDealTextClaimNoFoodDiscount,
);

tests.push(
  testAnAllDayWindowIsNotLiveInTheSmallHours,
  testTheOpenNowCheckReadsTheSanDiegoWeekdayNotTheUtcOne,
  testAnUnboundedAllDayWindowIsRecognizedAndGivenServiceHours,
  testNoCatalogListingStoresAnUnboundedAllDayWindow,
  testHighlightedDaysCoverEveryWindowNotJustThePrimaryOne,
  testCatalogHighlightedDaysNeverOmitAScheduledDay,
  testMenuTextIsSearchable,
  testEveryStoredMenuSectionHasItemsUnderIt,
  testNoDealChipIsAnExtractorPlaceholder,
  testNoGalleryPhotoClaimsToBeTheMenuOfAVenueWithNoStoredMenu,
);

// ---- Listings that are a window and nothing else

function testAWindowOnlyVenuePageOffersNoChipsToShow() {
  // The card still labels the listing "Happy hour"; the venue page's deal grid
  // gets nothing, because a chip in a grid headed "Deals" reads as an offer.
  assert.deepEqual(venueDealLines({ deals: [] }), []);
  assert.deepEqual(venueDealLines({}), []);
  assert.deepEqual(cardSpecials({ deals: [] }), [CARD_DEAL_FALLBACK]);
}

function testTheHonestEmptyStateNamesNoOfferAndNoPrice() {
  const copy = `${WINDOW_ONLY_HEADING} ${WINDOW_ONLY_BODY}`;
  assert.ok(WINDOW_ONLY_HEADING.length > 0 && WINDOW_ONLY_BODY.length > 0);
  // Whatever the wording becomes, it must never itself name a price or an
  // offer — it is the state we render precisely because we have neither.
  assert.equal(/\$|\d+\s*%|half[- ]off|\bfree\b/i.test(copy), false);
}

function testARecoveredOfferHasToQuoteAPrice() {
  const venue = { name: 'Deano\u2019s Pub' };
  assert.deepEqual(acceptableOffers(['$5 drafts and $6 wells'], venue), ['$5 drafts and $6 wells']);
  assert.deepEqual(acceptableOffers(['Half off appetizers'], venue), ['Half off appetizers']);
  // Everything a page offers that is not an offer.
  assert.deepEqual(acceptableOffers(['Happy hour'], venue), []);
  assert.deepEqual(acceptableOffers(['Mon - Fri'], venue), []);
  assert.deepEqual(acceptableOffers(['5286 Baltimore Drive, La Mesa, California'], venue), []);
  assert.deepEqual(acceptableOffers(['Free wifi'], venue), []);
  assert.deepEqual(acceptableOffers(['Free parking in the lot'], venue), []);
  assert.deepEqual(acceptableOffers(['Craft cocktails and a full bar'], venue), []);
}

function testTheReasonAListingIsEmptyIsReadOffItsOwnProvenance() {
  const bare = { id: 1, listingStatus: 'published', deals: [] };
  assert.equal(isWindowOnly(bare), true);
  assert.equal(emptyCause(bare), 'never_scraped');
  assert.equal(windowSource(bare), 'none');

  const googleWindow = {
    ...bare,
    hhSources: { times: { source: 'google_places' } },
    lastScrape: { outcome: 'not_published' },
  };
  assert.equal(emptyCause(googleWindow), 'not_published');
  assert.equal(windowSource(googleWindow), 'google_places');

  // A scrape that found and quoted a window but brought no offers with it is
  // its own bucket: the site was read, so a re-read is not the fix.
  assert.equal(emptyCause({ ...bare, lastScrape: { outcome: 'found' } }), 'found_no_offers');

  // A food hall's happy hour page belongs to its tenants, so nothing read off
  // it may be attributed to the building.
  const foodHall = { ...bare, name: 'Windmill Food Hall', lastScrape: { outcome: 'found' } };
  assert.equal(emptyCause(foodHall), 'not_a_venue');
  assert.equal(UNREADABLE_CAUSES.has(emptyCause(foodHall)), true);

  // A listing with a menu is not empty, whatever its deals array says.
  assert.equal(isWindowOnly({ ...bare, hhMenu: { sections: [{ title: 'Beer', items: [{ name: 'Pint' }] }] } }), false);
  assert.equal(isWindowOnly({ ...bare, galleryImages: [{ url: '/a.png' }] }), false);
  assert.equal(isWindowOnly({ ...bare, listingStatus: 'unlisted' }), false);
}

function testEveryWindowOnlyListingSaysItsOffersAreUnknown() {
  // The page's empty state and the `dealsUnknown` flag are two statements of
  // the same fact, and a listing that shows the state while claiming its deals
  // are known would put the flag and the page into disagreement.
  const disagreeing = happyHours
    .filter(isWindowOnly)
    .filter((venue) => venue.dealsUnknown !== true)
    .map((venue) => `${venue.name} (${venue.id})`);
  assert.deepEqual(disagreeing, []);
}

tests.push(
  testAWindowOnlyVenuePageOffersNoChipsToShow,
  testTheHonestEmptyStateNamesNoOfferAndNoPrice,
  testARecoveredOfferHasToQuoteAPrice,
  testTheReasonAListingIsEmptyIsReadOffItsOwnProvenance,
  testEveryWindowOnlyListingSaysItsOffersAreUnknown,
);

tests.push(
  testMenuPricesBecomeComparableNumbers,
  testMenuItemsAreCategorizedForCrossVenueQueries,
  testMenuRowsFlattenSectionsInReadingOrder,
  testHouseNamedDrinksInheritTheirSectionsCategory,
  testModelCategoryFillsGapsButNeverOverridesTheItemName,
  testBrokenStorefrontTextNeverReachesABoard,
);

let failed = 0;
for (const test of tests) {
  try {
    await test();
    console.log(`✓ ${test.name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${test.name}: ${error.message}`);
  }
}

if (failed) process.exit(1);
console.log(`All ${tests.length} venue audit tests passed.`);
