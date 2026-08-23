import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  SERVER_NOW,
  livePromotion,
  mockConsumerApis,
  venueFixture,
} from './helpers/promotion-fixtures';

const normalVenue = venueFixture(101, 'Quiet Patio', {
  neighborhood: 'South Park',
  startTime: '09:00',
  endTime: '10:00',
  deals: ['$5 lager'],
  dealTypes: ['beer'],
});
const happyHourVenue = venueFixture(102, 'HH Only Oyster Bar', {
  neighborhood: 'Little Italy',
  startTime: '16:00',
  endTime: '19:00',
  deals: ['$1 oysters'],
  dealTypes: ['oysters'],
});
const liveOnlyVenue = venueFixture(103, 'Live Only Cantina', {
  neighborhood: 'North Park',
  startTime: '09:00',
  endTime: '10:00',
  deals: ['$6 margarita'],
  dealTypes: ['cocktails'],
});
const bothVenue = venueFixture(104, 'Both Bistro', {
  neighborhood: 'North Park',
  startTime: '16:00',
  endTime: '19:00',
  deals: ['$8 wine'],
  dealTypes: ['wine'],
});

const liveOnlyPromotion = livePromotion(liveOnlyVenue, {
  id: 'promotion-live-only',
  title: 'Live-only taco drop',
  description: 'Full live-only promotion details belong in discovery.',
  effectiveEndsAt: '2026-08-22T01:30:00.000Z',
  endsAt: '2026-08-22T01:30:00.000Z',
});
const bothPromotion = livePromotion(bothVenue, {
  id: 'promotion-both',
  title: 'Both-state wine flight',
  description: 'Full both-state promotion details belong in discovery.',
  effectiveEndsAt: '2026-08-22T02:00:00.000Z',
  endsAt: '2026-08-22T02:00:00.000Z',
});

const ironside = venueFixture(1, 'Ironside Fish & Oyster', {
  neighborhood: 'Little Italy',
  startTime: '15:00',
  endTime: '18:00',
  deals: ['$1.50 oysters', '$6 beers'],
  dealTypes: ['oysters', 'beer'],
  vibe: 'Seafood spot',
  image: '/images/vibes/seafood-spot.jpg',
});

function directoryCard(page: Page, venueName: string): Locator {
  return page.locator('#grid article.card').filter({ hasText: venueName });
}

function discoveryCard(page: Page, promotionTitle: string): Locator {
  return page.locator('#live-deals-grid article').filter({ hasText: promotionTitle });
}

async function mockVenueImageOverride(page: Page, venueId: number, image: string): Promise<void> {
  await page.unroute('**/api/venue-overrides');
  await page.route('**/api/venue-overrides', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ overrides: { [venueId]: { image } } }),
    })
  );
}

async function expectSinglePrimaryStatus(
  card: Locator,
  expected: 'live-deal' | 'happy-hour' | 'none'
): Promise<void> {
  const liveDeal = card.locator('.card-status-badge .live-deal-badge');
  const happyHour = card.locator('.card-status-badge .happy-hour-now-badge');
  await expect(liveDeal).toHaveCount(expected === 'live-deal' ? 1 : 0);
  await expect(happyHour).toHaveCount(expected === 'happy-hour' ? 1 : 0);
  await expect(card.locator('.card-status-badge')).toHaveCount(expected === 'none' ? 0 : 1);
}

test('homepage renders all four activity states, one primary status, and canonical ordering', async ({
  page,
}) => {
  await mockConsumerApis(page, {
    // Deliberately start in the opposite order: the UI must promote Live Deals,
    // then Happy Hour Now, ahead of the normal directory card.
    venues: [normalVenue, happyHourVenue, bothVenue, liveOnlyVenue],
    livePayload: {
      serverNow: SERVER_NOW,
      promotions: [liveOnlyPromotion, bothPromotion],
    },
  });

  await page.goto('/');

  const liveDeals = page.locator('#live-deals-section');
  await expect(liveDeals).toBeVisible();
  await expect(liveDeals.getByRole('heading', { name: 'Live Deals' })).toBeVisible();
  await expect(page.locator('#live-deals-grid article')).toHaveCount(2);
  await expect(page.locator('#live-deals-count')).toHaveText('2 deals happening now');
  await expect(page.locator('#live-count-big')).toHaveText('2');

  const liveOnlyCard = directoryCard(page, liveOnlyVenue.name);
  const bothCard = directoryCard(page, bothVenue.name);
  const happyHourCard = directoryCard(page, happyHourVenue.name);
  const normalCard = directoryCard(page, normalVenue.name);
  await expectSinglePrimaryStatus(liveOnlyCard, 'live-deal');
  await expectSinglePrimaryStatus(bothCard, 'live-deal');
  await expectSinglePrimaryStatus(happyHourCard, 'happy-hour');
  await expectSinglePrimaryStatus(normalCard, 'none');
  await expect(bothCard).toContainText('Happy hour also happening now');
  await expect(liveOnlyCard).not.toContainText('Happy hour also happening now');

  await expect(page.locator('#grid .venue-name')).toHaveText([
    liveOnlyVenue.name,
    bothVenue.name,
    happyHourVenue.name,
    normalVenue.name,
  ]);

  // Directory cards may summarize a promotion headline, but full body copy is
  // rendered only in the dedicated inventory rather than duplicated in both sections.
  await expect(
    page.getByText(liveOnlyPromotion.description, { exact: true })
  ).toHaveCount(1);
  await expect(
    page.getByText(bothPromotion.description, { exact: true })
  ).toHaveCount(1);
  await expect(liveOnlyCard).not.toContainText(liveOnlyPromotion.description);
  await expect(bothCard).not.toContainText(bothPromotion.description);
});

test('homepage directory card falls back to its vibe image when a live venue image override is missing', async ({
  page,
}) => {
  const venue = venueFixture(301, 'Fallback Taproom', {
    vibe: 'Trendy gastropub',
    image: '',
  });
  const missingImage = '/api/images/missing-directory-override.jpg';
  const stockImage = '/images/vibes/trendy-gastropub.jpg';
  let missingImageRequests = 0;

  await mockConsumerApis(page, { venues: [venue] });
  await mockVenueImageOverride(page, venue.id, missingImage);
  await page.route(`**${missingImage}`, async (route) => {
    missingImageRequests += 1;
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
  });

  await page.goto('/');

  const card = directoryCard(page, venue.name);
  await expect(card).toBeVisible();
  const image = card.locator('.card-image img');
  await expect.poll(() => missingImageRequests).toBeGreaterThan(0);
  await expect(image).toHaveAttribute('src', stockImage);
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
});

test('homepage Live Deal card falls back to the venue vibe when its live image override is missing', async ({
  page,
}) => {
  const missingImage = '/api/images/missing-live-deal-override.jpg';
  const stockImage = '/images/vibes/seafood-spot.jpg';
  const venue = venueFixture(302, 'Fallback Oyster Bar', {
    vibe: 'Seafood spot',
    image: '',
  });
  const promotion = livePromotion(venue, {
    id: 'promotion-fallback-image',
    title: 'Fallback oyster flash deal',
    venue: {
      id: venue.id,
      name: venue.name,
      slug: 'fallback-oyster-bar',
      neighborhood: venue.neighborhood,
      // Deliberately stale: the homepage must prefer the newer image from
      // /api/venue-overrides instead of this independently fetched snapshot.
      image: '/images/vibes/rooftop-vibes.jpg',
    },
  });
  let missingImageRequests = 0;

  await mockConsumerApis(page, {
    venues: [venue],
    livePayload: { serverNow: SERVER_NOW, promotions: [promotion] },
  });
  await mockVenueImageOverride(page, venue.id, missingImage);
  await page.route(`**${missingImage}`, async (route) => {
    missingImageRequests += 1;
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
  });

  await page.goto('/');

  const card = discoveryCard(page, promotion.title);
  await expect(card).toBeVisible();
  const image = card.locator('.live-deal-discovery-image img');
  await expect.poll(() => missingImageRequests).toBeGreaterThan(0);
  await expect(image).toHaveAttribute('src', stockImage);
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
});

test('homepage refreshes a regular venue image on window focus without duplicating filter options', async ({
  page,
}) => {
  const venue = venueFixture(303, 'Focus Refresh Lounge', {
    vibe: 'Trendy gastropub',
    image: '',
  });
  const firstImage = '/images/vibes/rooftop-vibes.jpg';
  const refreshedImage = '/images/vibes/seafood-spot.jpg';
  let overrideImage = firstImage;
  let overrideRequests = 0;

  await mockConsumerApis(page, { venues: [venue] });
  await page.unroute('**/api/venue-overrides');
  await page.route('**/api/venue-overrides', (route) => {
    overrideRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ overrides: { [venue.id]: { image: overrideImage } } }),
    });
  });

  await page.goto('/');

  const image = directoryCard(page, venue.name).locator('.card-image img');
  await expect(image).toHaveAttribute('src', firstImage);
  const requestsBeforeFocus = overrideRequests;
  const filterOptionCounts = await page.evaluate(() =>
    ['day-filter', 'neighborhood-filter', 'deal-filter', 'feature-filter', 'status-filter', 'trust-filter']
      .map((id) => document.querySelectorAll(`#${id} option`).length)
  );

  overrideImage = refreshedImage;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect.poll(() => overrideRequests).toBeGreaterThan(requestsBeforeFocus);
  await expect(image).toHaveAttribute('src', refreshedImage);
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect(await page.evaluate(() =>
    ['day-filter', 'neighborhood-filter', 'deal-filter', 'feature-filter', 'status-filter', 'trust-filter']
      .map((id) => document.querySelectorAll(`#${id} option`).length)
  )).toEqual(filterOptionCounts);
  await expect(page.locator('#neighborhood-filter option[value="North Park"]')).toHaveCount(1);
  await expect(page.locator('#deal-filter option[value="cocktails"]')).toHaveCount(1);
  await expect(page.locator('#feature-filter option[value="patio"]')).toHaveCount(1);
});

test('homepage card retries a healthy original once after a CDN transform fails', async ({ page }) => {
  const venue = venueFixture(304, 'Original Image Retry Bar', {
    vibe: 'Trendy gastropub',
    image: '',
  });
  const originalImage = '/api/images/healthy-original.jpg';
  const transformedImage = `/.netlify/images?url=${encodeURIComponent(originalImage)}&w=800&q=80`;
  const stockImage = '/images/vibes/trendy-gastropub.jpg';
  const requests: string[] = [];

  await mockConsumerApis(page, { venues: [venue] });
  await page.route(
    (url) => url.pathname === '/.netlify/images' && url.searchParams.get('url') === originalImage,
    async (route) => {
      requests.push('transform');
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Transform not found' });
    }
  );
  await page.route(`**${originalImage}`, async (route) => {
    requests.push('original');
    await route.fulfill({
      path: `${process.cwd()}/public/images/vibes/rooftop-vibes.jpg`,
      contentType: 'image/jpeg',
    });
  });

  await page.goto('/');

  const image = directoryCard(page, venue.name).locator('.card-image img');
  await expect(image).toHaveAttribute('data-listing-image', '');
  await expect(image).toHaveAttribute('data-stock-src', stockImage);
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

  // Astro dev deliberately skips Netlify transforms. Point the rendered card
  // at a production-shaped transform while retaining its real delegated error
  // listener and fallback data attributes, so the two-step chain stays exact.
  await image.evaluate(
    (element, sources) => {
      const imageElement = element as HTMLImageElement;
      imageElement.dataset.originalSrc = sources.original;
      imageElement.src = sources.transformed;
    },
    { original: originalImage, transformed: transformedImage }
  );

  await expect.poll(() => [...requests]).toEqual(['transform', 'original']);
  await expect(image).toHaveAttribute('src', originalImage);
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect(requests.filter((request) => request === 'transform')).toHaveLength(1);
  expect(requests.filter((request) => request === 'original')).toHaveLength(1);
  await expect(image).not.toHaveAttribute('data-original-src');
  await expect(image).toHaveAttribute('data-stock-src', stockImage);
});

test('homepage discovery uses explicit search/geography, ignores recurring-only filters, and redacts codes synchronously', async ({
  page,
}) => {
  const noCodeVenue = venueFixture(201, 'No Code Taproom', {
    neighborhood: 'North Park',
    deals: ['$5 draft beer'],
    dealTypes: ['beer'],
  });
  const secretVenue = venueFixture(202, 'Cipher Lounge', {
    neighborhood: 'Little Italy',
    deals: ['$9 house wine'],
    dealTypes: ['wine'],
  });
  const noCodePromotion = livePromotion(noCodeVenue, {
    id: 'promotion-no-code',
    title: 'Taproom flash pour',
    description: 'A public offer with no code.',
    hasDealCode: false,
  });
  let signedIn = false;
  const secretPromotion = () => livePromotion(secretVenue, {
    id: 'promotion-secret',
    title: 'Saffron signal launch',
    description: 'A session-sensitive offer.',
    hasDealCode: true,
    ...(signedIn ? { dealCode: 'SECRET-42' } : {}),
  });

  await mockConsumerApis(page, {
    venues: [noCodeVenue, secretVenue],
    accountPayload: () => signedIn
      ? { authenticated: true, user: { id: 'consumer-1', savedSpots: [] } }
      : { authenticated: false, user: null },
    livePayload: () => ({
      serverNow: SERVER_NOW,
      promotions: [noCodePromotion, secretPromotion()],
    }),
  });

  await page.goto('/');

  const noCodeCard = discoveryCard(page, noCodePromotion.title);
  const secretCard = discoveryCard(page, 'Saffron signal launch');
  await expect(noCodeCard).toBeVisible();
  await expect(noCodeCard.locator('.live-deal-code-row')).toHaveCount(0);
  await expect(secretCard).toContainText('Deal code available');
  await expect(secretCard.getByRole('link', { name: 'Sign in to see deal code' })).toBeVisible();
  await expect(secretCard.locator('code')).toHaveCount(0);

  // Recurring-HH deal filters affect the directory only. They must not silently
  // shrink the separately sourced Live Deals inventory.
  await page.locator('#deal-filter').selectOption('beer');
  await expect(page.locator('#grid article.card')).toHaveCount(1);
  await expect(directoryCard(page, noCodeVenue.name)).toBeVisible();
  await expect(page.locator('#live-deals-grid article')).toHaveCount(2);

  await page.locator('#deal-filter').selectOption('');
  await page.locator('#neighborhood-filter').selectOption('Little Italy');
  await expect(page.locator('#live-deals-grid article')).toHaveCount(1);
  await expect(discoveryCard(page, 'Saffron signal launch')).toBeVisible();
  await expect(noCodeCard).toHaveCount(0);

  await page.locator('#neighborhood-filter').selectOption('');
  const search = page.getByRole('searchbox', { name: 'Search venues and Live Deals' });
  await search.fill('saffron signal');
  await expect(page.locator('#live-deals-grid article')).toHaveCount(1);
  await expect(discoveryCard(page, 'Saffron signal launch')).toBeVisible();
  await expect(page.locator('#grid article.card')).toHaveCount(0);

  // The filter row has a usable keyboard sequence from search into day filtering.
  await search.click();
  await page.keyboard.press('Tab');
  await expect(page.locator('#day-filter')).toBeFocused();
  await search.fill('');

  signedIn = true;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('sdhh:auth-changed')));
  await expect(discoveryCard(page, 'Saffron signal launch').locator('code')).toHaveText('SECRET-42');

  const redactedDuringPageHide = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    const cards = [...document.querySelectorAll<HTMLElement>('#live-deals-grid article')];
    const secret = cards.find((card) => card.textContent?.includes('Saffron signal launch'));
    return {
      code: secret?.querySelector('code')?.textContent ?? null,
      signIn: secret?.querySelector<HTMLAnchorElement>('a[href^="/account/"]')?.textContent ?? null,
    };
  });
  expect(redactedDuringPageHide).toEqual({
    code: null,
    signIn: 'Sign in to see deal code',
  });
});

test('venue page gives Live Deal priority on mobile while preserving regular happy hour and accessible motion', async ({
  page,
}) => {
  const promotion = livePromotion(ironside, {
    id: 'promotion-ironside-live',
    title: 'Oyster bar lightning round',
    description: 'Half-price chef oysters until the server-owned end time.',
    hasDealCode: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockConsumerApis(page, {
    livePayload: { serverNow: SERVER_NOW, promotions: [promotion] },
  });

  await page.goto('/venues/ironside-fish-oyster/');

  const hero = page.locator('#hero-frame');
  const primary = page.locator('#hero-primary-badge');
  const liveDealSection = page.locator('#live-deal-section');
  await expect(hero).toHaveClass(/is-live-deal/);
  await expect(hero).not.toHaveClass(/is-happy-hour-now/);
  await expect(primary).toContainText('LIVE DEAL');
  await expect(primary).not.toContainText('HAPPY HOUR NOW');
  await expect(page.locator('#hero-live-deal-dot')).toBeVisible();
  await expect(liveDealSection).toBeVisible();
  await expect(liveDealSection).toContainText('Oyster bar lightning round');
  await expect(liveDealSection).toContainText('Regular happy hour also happening now');

  const countdown = page.locator('#live-deal-countdown');
  await expect(countdown).toContainText('remaining');
  await expect(countdown).not.toHaveAttribute('aria-live', /.+/);
  expect(await countdown.evaluate((element) => element.closest('[aria-live]') === null)).toBe(true);

  const regularHappyHour = page.locator('.regular-happy-hour');
  await expect(regularHappyHour.getByRole('heading', { name: 'Regular Happy Hour' })).toBeVisible();
  await expect(regularHappyHour).toContainText('3:00 PM – 6:00 PM');
  await expect(regularHappyHour).toContainText('$1.50 oysters');

  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  expect(
    await page.locator('#hero-live-deal-dot').evaluate((element) =>
      getComputedStyle(element).animationName
    )
  ).toBe('none');
  expect(await hero.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  const mobileLayout = await liveDealSection.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      viewportWidth: window.innerWidth,
    };
  });
  expect(mobileLayout.left).toBeGreaterThanOrEqual(0);
  expect(mobileLayout.right).toBeLessThanOrEqual(mobileLayout.viewportWidth);

  await hero.focus();
  await expect(hero).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#lightbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#lightbox')).toBeHidden();
});

test('venue page keeps the stock hero and lightbox image when a live featured-image override is missing', async ({
  page,
}) => {
  const missingImage = '/api/images/missing-live-featured.jpg';
  const stockImage = '/images/vibes/trendy-gastropub.jpg';
  let missingImageRequests = 0;

  await mockConsumerApis(page, {
    venueContentPayload: {
      venueId: 2,
      hasOwnerEdits: true,
      listing: { image: missingImage },
      photos: [],
      menu: [],
    },
  });
  await page.route(`**${missingImage}`, async (route) => {
    missingImageRequests += 1;
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
  });

  await page.goto('/venues/craft-commerce/');

  const hero = page.locator('#hero-frame');
  const heroImage = hero.locator('img').first();
  await expect.poll(() => missingImageRequests).toBeGreaterThan(0);
  await expect(heroImage).toHaveAttribute('src', stockImage);
  await expect
    .poll(() => heroImage.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

  await hero.click();
  await expect(page.locator('#lightbox')).toBeVisible();
  const lightboxImage = page.locator('#lightbox-img');
  await expect(lightboxImage).toHaveAttribute('src', stockImage);
  await expect
    .poll(() => lightboxImage.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
});

test('venue page restores the stock hero when a live override clears a build-time featured image', async ({
  page,
}) => {
  const buildTimeImage = '/api/images/your-mother-s-house-1787356091402-57d84087.png';
  const stockImage = '/images/vibes/speakeasy.jpg';

  await mockConsumerApis(page, {
    venueContentPayload: {
      venueId: 21,
      hasOwnerEdits: true,
      listing: { image: '' },
      photos: [],
      menu: [],
    },
  });
  // Keep the prerendered featured image healthy so only the explicit empty
  // live override can cause the switch back to the venue's stock fallback.
  await page.route(`**${buildTimeImage}`, (route) =>
    route.fulfill({
      path: `${process.cwd()}/public/images/vibes/rooftop-vibes.jpg`,
      contentType: 'image/jpeg',
    })
  );

  await page.goto('/venues/your-mother-s-house/');

  const heroImage = page.locator('#hero-frame > img');
  await expect(heroImage).toHaveAttribute('src', stockImage);
  await expect
    .poll(() => heroImage.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
});

test('venue page reserves the pulse for Live Deal and falls through Happy Hour Now to no status', async ({
  page,
}) => {
  let serverNow = SERVER_NOW;
  await mockConsumerApis(page, {
    livePayload: () => ({ serverNow, promotions: [] }),
  });

  await page.goto('/venues/ironside-fish-oyster/');

  const hero = page.locator('#hero-frame');
  const primary = page.locator('#hero-primary-badge');
  const liveDealDot = page.locator('#hero-live-deal-dot');
  await expect(hero).toHaveClass(/is-happy-hour-now/);
  await expect(hero).not.toHaveClass(/is-live-deal/);
  await expect(primary).toContainText('HAPPY HOUR NOW');
  await expect(primary).not.toContainText('LIVE DEAL');
  await expect(liveDealDot).toBeHidden();
  await expect(page.locator('#live-deal-section')).toBeHidden();
  expect(await hero.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');

  // 1 p.m. PDT is before Ironside's ordinary 3–6 p.m. Friday happy hour.
  serverNow = '2026-08-21T20:00:00.000Z';
  await page.reload();
  await expect(primary).toBeHidden();
  await expect(hero).not.toHaveClass(/is-live-deal|is-happy-hour-now/);
  await expect(liveDealDot).toBeHidden();
  await expect(page.locator('.regular-happy-hour')).toBeVisible();
});

test('venue page removes an expired promotion at the half-open boundary and downgrades to Happy Hour Now', async ({
  page,
}) => {
  const expiringPromotion = livePromotion(ironside, {
    id: 'promotion-exact-expiry',
    title: 'Boundary oyster offer',
    effectiveEndsAt: '2026-08-22T00:30:01.500Z',
    endsAt: '2026-08-22T00:30:01.500Z',
  });
  const mocked = await mockConsumerApis(page, {
    livePayload: (requestNumber) => ({
      serverNow: SERVER_NOW,
      promotions: requestNumber === 1 ? [expiringPromotion] : [],
    }),
  });

  await page.goto('/venues/ironside-fish-oyster/');

  const hero = page.locator('#hero-frame');
  const liveDealSection = page.locator('#live-deal-section');
  await expect(hero).toHaveClass(/is-live-deal/);
  await expect(liveDealSection).toBeVisible();
  await expect(liveDealSection).toContainText('Boundary oyster offer');

  await expect(hero).toHaveClass(/is-happy-hour-now/, { timeout: 5_000 });
  await expect(hero).not.toHaveClass(/is-live-deal/);
  await expect(page.locator('#hero-primary-label')).toHaveText('HAPPY HOUR NOW');
  await expect(liveDealSection).toBeHidden();
  await expect(page.locator('#live-deal-title')).toHaveText('');
  await expect(page.locator('#hero-live-deal-dot')).toBeHidden();
  await expect(page.locator('.regular-happy-hour')).toContainText('$1.50 oysters');
  await expect.poll(mocked.liveRequestCount).toBeGreaterThanOrEqual(2);
});
