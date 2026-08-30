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
  discoverFromSitemap,
} from '../scripts/import-google-venues/lib/sitemap-discover.mjs';
import {
  windowsFromPeriods,
  pickPrimaryWindow,
  happyHourFromPlace,
  matchVenueToPlace,
  indexPlacesByName,
} from '../scripts/import-google-venues/lib/google-happy-hour.mjs';
import { isPubliclyListed } from '../src/lib/listingVisibility.ts';
import { isHappyHourActive, getHappyHourOccurrenceForDate } from '../src/lib/sanDiegoTime.ts';
import { isPlausibleHappyHourWindow, normalizeWindows, endTimeFromOpenUntilQuote, applyOpenUntilFromQuotes, repairOpenStartWindows } from '../scripts/import-google-venues/lib/schedule-windows.mjs';
import { classifyUrl, scoreMediaUrl, discoverSocialLinks, discoverSpecialsImages, discoverSpecialsMedia, sniffMediaFromBytes, anthropicMediaType, selectMenuFlyerPages } from '../scripts/import-google-venues/lib/media.mjs';
import { pageMatchesVenueListing, isUsableVenueWebsite, hostnameCorroboratesVenue, listingUrlCorroboratesVenue, listedHostMatchesVenueName } from '../scripts/import-google-venues/lib/website-ownership.mjs';
import { venueMatchesQuery, venueSearchScore } from '../src/lib/venueSearch.ts';
import { rasterizePdfPages, pdfLooksLikeHappyHourMenu } from '../scripts/import-google-venues/lib/pdf-raster.mjs';
import { buildBoardHtml } from '../scripts/import-google-venues/lib/menu-board-image.mjs';
import { menuTextFromJsonResponses } from '../scripts/import-google-venues/lib/json-menu-extract.mjs';
import { classifyCounty } from '../scripts/import-google-venues/lib/county.mjs';
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
import { cardSpecials, cardTimeLabel, shortDealLabel, venueDealLines } from '../src/lib/listingCopy.ts';
import { buildVenueSlugMap, slugFromMap } from '../src/lib/venueSlug.ts';
import happyHours from '../public/data/happy-hours.json' with { type: 'json' };
import { applyScrape } from '../scripts/import-google-venues/lib/apply-scrape.mjs';
import { cleanDeals, isJunkDealLine, isRealDealLine, MAX_DEAL_CHIPS } from '../scripts/import-google-venues/lib/deals.mjs';
import { isAnthropicBillingError } from '../scripts/import-google-venues/lib/anthropic-errors.mjs';

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

async function testDiscoverFromSitemapLive() {
  const { candidates, sitemapFound } = await discoverFromSitemap('https://lapuertasd.com/');
  assert.equal(sitemapFound, true);
  assert.ok(candidates.some((c) => /happy-hours/i.test(c.url)));
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
  assert.deepEqual(venueDealLines({ deals: [] }), ['Happy hour']);
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
  testDiscoverFromSitemapLive,
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

tests.push(
  testDedupeSeesVenuesTheCacheStoresAsPlainStrings,
  testFoundWithoutAScheduleIsNotAFinding,
  testCountyComesFromGoogleNotTheBoundsRectangle,
  testCatalogHasNoPublishedOutOfCountyVenues,
  testLocatorWidgetApiIsFoundFromItsScriptTag,
  testLocatorOfferSurvivesWithoutAPriceField,
  testLocatorOffersAreMatchedPerLocationNotBrandWide,
  testLocatorLinksRankBelowSpecialsAndMenus,
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
