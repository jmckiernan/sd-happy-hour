import { expect, test, type Route } from '@playwright/test';

const VENUE_ID = 42;
const SERVER_NOW = '2026-09-03T04:00:00.000Z';

async function fulfill(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test('Promotions paints from session cache before delayed network revalidate', async ({ page }) => {
  const cachedTitle = 'Cached SWR Promotion';
  let promotionsHits = 0;
  let releaseMe: (() => void) | null = null;
  let releasePromotions: (() => void) | null = null;
  const meGate = new Promise<void>((resolve) => {
    releaseMe = resolve;
  });
  const promotionsGate = new Promise<void>((resolve) => {
    releasePromotions = resolve;
  });

  // Gate /api/account/me too — cache paint must not wait on auth bootstrap.
  await page.route('**/api/account/me', async (route) => {
    await meGate;
    await fulfill(route, {
      authenticated: true,
      user: {
        id: 'user-owner',
        name: 'Alex Owner',
        email: 'owner@example.com',
        shareId: 'share-owner',
        savedSpots: [],
        alerts: [],
        phone: '',
        smsOptedIn: false,
        weeklyDigestOptIn: false,
        hasPassword: true,
      },
    });
  });
  await page.route('**/api/admin/me', (route) => fulfill(route, { authenticated: false, admin: null }));
  await page.route('**/api/restaurant/claims', async (route) => {
    await fulfill(route, {
      authenticated: true,
      serverNow: SERVER_NOW,
      claims: [
        {
          id: 'claim-verified',
          userId: 'user-owner',
          venueId: VENUE_ID,
          status: 'verified',
          verificationMethod: 'domain',
          phone: '',
          phoneVerifiedAt: null,
          claimNote: '',
          plan: 'paid',
          smsFundingEnabled: false,
          createdAt: '2026-08-01T18:00:00.000Z',
          updatedAt: '2026-08-01T18:00:00.000Z',
          venueName: 'The Sunset Room',
          venueSlug: 'the-sunset-room',
          venueNeighborhood: 'North Park',
          venuePhoneAvailable: true,
          accessRole: 'owner',
          happyHourSchedule: {
            id: VENUE_ID,
            days: ['Friday'],
            startTime: '16:00',
            endTime: '19:00',
          },
        },
      ],
    });
  });
  await page.route('**/api/restaurant/promotions**', async (route) => {
    promotionsHits += 1;
    await promotionsGate;
    await fulfill(route, {
      promotions: [
        {
          id: 'promotion-fresh',
          venueId: VENUE_ID,
          type: 'special_deal',
          title: 'Fresh Network Promotion',
          description: 'Arrived after cache paint.',
          dealCode: null,
          imageKey: null,
          imageUrl: '',
          startsAt: null,
          endsAt: null,
          effectiveEndsAt: null,
          publishedAt: null,
          endedAt: null,
          cancelledAt: null,
          state: 'draft',
          createdAt: '2026-08-20T18:00:00.000Z',
          updatedAt: '2026-08-21T18:00:00.000Z',
          allowedActions: {
            update: true,
            publish: true,
            startNow: true,
            cancel: false,
            end: false,
            delete: true,
          },
        },
      ],
      entitlement: {
        plan: 'paid',
        allowance: 4,
        baseAllowance: 4,
        additionalAllowance: 0,
        monthlyAllowance: 4,
        monthKey: '2026-09',
        consumed: 0,
        reserved: 0,
        usedThisMonth: 0,
        remainingThisMonth: 4,
        freePromotionsRemaining: null,
        canLaunchPromotion: true,
        isUnlimited: false,
      },
      serverNow: SERVER_NOW,
    });
  });

  await page.addInitScript(
    ({ venueId, cachedTitle, serverNow }) => {
      const write = (venueKey: number, resource: string, data: unknown) => {
        const key = `sdhh:merchant-tab:${venueKey}:${resource}`;
        sessionStorage.setItem(
          key,
          JSON.stringify({
            v: 1,
            venueId: venueKey,
            resource,
            suffix: '',
            cachedAt: Date.now(),
            data,
          })
        );
      };
      write(0, 'claims', {
        claims: [
          {
            id: 'claim-verified',
            venueId,
            status: 'verified',
            venueName: 'The Sunset Room',
            venueSlug: 'the-sunset-room',
            venueNeighborhood: 'North Park',
            venuePhoneAvailable: true,
            accessRole: 'owner',
            happyHourSchedule: {
              id: venueId,
              days: ['Friday'],
              startTime: '16:00',
              endTime: '19:00',
            },
          },
        ],
        serverNow,
      });
      write(venueId, 'promotions', {
        promotions: [
          {
            id: 'promotion-cached',
            venueId,
            type: 'special_deal',
            title: cachedTitle,
            description: 'Served from session cache.',
            dealCode: null,
            imageKey: null,
            imageUrl: '',
            startsAt: null,
            endsAt: null,
            effectiveEndsAt: null,
            publishedAt: null,
            endedAt: null,
            cancelledAt: null,
            state: 'draft',
            createdAt: '2026-08-20T18:00:00.000Z',
            updatedAt: '2026-08-21T18:00:00.000Z',
            allowedActions: {
              update: true,
              publish: true,
              startNow: true,
              cancel: false,
              end: false,
              delete: true,
            },
          },
        ],
        entitlement: {
          plan: 'paid',
          allowance: 4,
          baseAllowance: 4,
          additionalAllowance: 0,
          monthlyAllowance: 4,
          monthKey: '2026-09',
          consumed: 0,
          reserved: 0,
          usedThisMonth: 0,
          remainingThisMonth: 4,
          freePromotionsRemaining: null,
          canLaunchPromotion: true,
          isUnlimited: false,
        },
        serverNow,
      });
    },
    { venueId: VENUE_ID, cachedTitle, serverNow: SERVER_NOW }
  );

  await page.goto('/restaurant/?venueId=42');

  // Cached paint must win before /api/account/me and promotions network are released.
  await expect(page.getByText(cachedTitle)).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('#loading-panel')).toBeHidden();

  releaseMe?.();
  releasePromotions?.();
  await expect(page.getByText('Fresh Network Promotion')).toBeVisible({ timeout: 10_000 });
  expect(promotionsHits).toBeGreaterThanOrEqual(1);
});
