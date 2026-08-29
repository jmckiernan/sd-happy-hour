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
} from '../scripts/import-google-venues/lib/ai-extract.mjs';
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
import { isPlausibleHappyHourWindow, normalizeWindows, endTimeFromOpenUntilQuote, applyOpenUntilFromQuotes } from '../scripts/import-google-venues/lib/schedule-windows.mjs';
import { classifyUrl, scoreMediaUrl, discoverSocialLinks, discoverSpecialsImages, discoverSpecialsMedia, sniffMediaFromBytes, anthropicMediaType, selectMenuFlyerPages } from '../scripts/import-google-venues/lib/media.mjs';
import { pageMatchesVenueListing, isUsableVenueWebsite, hostnameCorroboratesVenue, listingUrlCorroboratesVenue, listedHostMatchesVenueName } from '../scripts/import-google-venues/lib/website-ownership.mjs';
import { venueMatchesQuery, venueSearchScore } from '../src/lib/venueSearch.ts';
import { rasterizePdfPages } from '../scripts/import-google-venues/lib/pdf-raster.mjs';
import { renderMenuBoardJpeg, menuBoardFromDealLines } from '../scripts/import-google-venues/lib/html-menu-flyer.mjs';
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
  const guessed = buildCandidateUrls('https://kingfishersd.com', []);
  assert.ok(guessed.some((url) => /\/list\/?$/.test(url)));
  assert.ok(guessed.some((url) => /\/golden-hour\/?$/.test(url)));
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
  assert.ok(urls.some((u) => u.includes('/specials')));
  assert.ok(urls.some((u) => /\/menu\/?$/.test(u)), 'menu stays in the core set even when sitemap is strong');
  assert.ok(!urls.some((u) => u.includes('/drinks')), 'secondary guesses stay off when sitemap is strong');
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
  const board = menuBoardFromDealLines(
    ['$2 off beers, wine, cocktails & appetizers', '50% off wings & wine Wednesday'],
    [{ days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '12:00', endTime: '17:00' }]
  );
  assert.equal(board.sections[0].items.length, 2);
  const image = renderMenuBoardJpeg(board, { name: 'The Sandbox' });
  assert.equal(image.bytes[0], 0xff);
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

function testRenderMenuBoardJpeg() {
  const board = normalizeMenuBoard({
    hours: 'Mon all day · Tue–Fri 3–6pm',
    note: '10% off entire regular menu',
    sections: [
      { title: 'Food', items: [{ name: 'Esquites', price: '$6' }, { name: 'Chips & Queso', price: '$5' }, { name: 'Deviled Eggs', price: '$15' }] },
      { title: 'Drinks', items: [{ name: 'Vodka Highball', price: '$6' }, { name: 'All Draft Cocktails', price: '$10' }] },
    ],
  });
  const image = renderMenuBoardJpeg(board, { name: 'Misadventure & Co' });
  assert.equal(image.mediaType, 'image/jpeg');
  assert.equal(image.bytes[0], 0xff);
  assert.ok(image.bytes.length > 2000);
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

const tests = [
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
  testRenderMenuBoardJpeg,
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
