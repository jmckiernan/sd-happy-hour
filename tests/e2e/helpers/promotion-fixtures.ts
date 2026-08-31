import type { Page, Route } from '@playwright/test';
import type { PublicPromotionDto } from '../../../src/lib/promotionDtos';

export const SERVER_NOW = '2026-08-22T00:30:00.000Z';

export interface ConsumerVenueFixture {
  id: number;
  name: string;
  neighborhood: string;
  address: string;
  lat: number;
  lng: number;
  days: string[];
  startTime: string;
  endTime: string;
  deals: string[];
  vibe: string;
  website: string;
  phone: string;
  verified: boolean;
  lastVerifiedAt: string | null;
  sourceUrl: string;
  dealTypes: string[];
  image: string;
}

export interface LivePromotionPayload {
  serverNow: string;
  promotions: PublicPromotionDto[];
}

interface ConsumerApiOptions {
  venues?: ConsumerVenueFixture[];
  livePayload?: LivePromotionPayload | ((requestNumber: number, url: URL) => LivePromotionPayload);
  accountPayload?: unknown | (() => unknown);
  venueContentPayload?: unknown;
}

export function venueFixture(
  id: number,
  name: string,
  overrides: Partial<ConsumerVenueFixture> = {}
): ConsumerVenueFixture {
  return {
    id,
    name,
    neighborhood: 'North Park',
    address: `${id} E Test Avenue`,
    lat: 32.75 + id / 10_000,
    lng: -117.13 - id / 10_000,
    days: ['Friday'],
    startTime: '10:00',
    endTime: '11:00',
    deals: ['$7 fixture cocktail'],
    vibe: 'Neighborhood bar',
    website: 'https://example.com',
    phone: '(619) 555-0100',
    verified: true,
    lastVerifiedAt: '2026-08-20T18:00:00.000Z',
    sourceUrl: 'https://example.com/menu',
    dealTypes: ['cocktails'],
    image: '/images/vibes/craft-cocktails.jpg',
    ...overrides,
  };
}

export function livePromotion(
  venue: Pick<ConsumerVenueFixture, 'id' | 'name' | 'neighborhood' | 'image'>,
  overrides: Partial<PublicPromotionDto> = {}
): PublicPromotionDto {
  const promotion: PublicPromotionDto = {
    id: `promotion-${venue.id}`,
    venueId: venue.id,
    venue: {
      id: venue.id,
      name: venue.name,
      slug: venue.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, ''),
      neighborhood: venue.neighborhood,
      image: venue.image,
    },
    type: 'special_deal',
    title: `${venue.name} live special`,
    description: 'A fixture-only limited-time offer.',
    startsAt: '2026-08-21T23:30:00.000Z',
    endsAt: '2026-08-22T02:30:00.000Z',
    effectiveEndsAt: '2026-08-22T02:30:00.000Z',
    state: 'live',
    hasDealCode: false,
    ...overrides,
  };

  // Omission is the privacy contract for an unrevealed code. A spread with
  // `dealCode: undefined` would still create the property and weaken this fixture.
  if (!Object.prototype.hasOwnProperty.call(overrides, 'dealCode')) {
    delete promotion.dealCode;
  }
  return promotion;
}

export async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

export async function mockConsumerApis(
  page: Page,
  options: ConsumerApiOptions = {}
): Promise<{ liveRequestCount: () => number }> {
  let liveRequests = 0;
  const anonymousAccount = { authenticated: false, user: null };
  const defaultPayload: LivePromotionPayload = {
    serverNow: SERVER_NOW,
    promotions: [],
  };

  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' })
  );
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.route('https://unpkg.com/**', (route) => {
    const isStylesheet = new URL(route.request().url()).pathname.endsWith('.css');
    return route.fulfill({
      status: 200,
      contentType: isStylesheet ? 'text/css' : 'application/javascript',
      body: '',
    });
  });
  await page.route('**/data/happy-hours.json', (route) =>
    fulfillJson(route, options.venues ?? [])
  );
  await page.route('**/api/venue-overrides', (route) =>
    fulfillJson(route, { overrides: {} })
  );
  await page.route('**/api/account/me', (route) =>
    fulfillJson(
      route,
      typeof options.accountPayload === 'function'
        ? options.accountPayload()
        : options.accountPayload ?? anonymousAccount
    )
  );
  await page.route('**/api/admin/me', (route) =>
    fulfillJson(route, { authenticated: false, admin: null })
  );
  await page.route('**/api/venue-content/**', (route) =>
    fulfillJson(
      route,
      options.venueContentPayload ?? {
        hasOwnerEdits: false,
        listing: null,
        photos: [],
        menu: [],
      }
    )
  );
  await page.route('**/api/promotions/live**', (route) => {
    liveRequests += 1;
    const payload = typeof options.livePayload === 'function'
      ? options.livePayload(liveRequests, new URL(route.request().url()))
      : options.livePayload ?? defaultPayload;
    return fulfillJson(route, payload);
  });

  return { liveRequestCount: () => liveRequests };
}
