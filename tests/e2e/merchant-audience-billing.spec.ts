import { expect, test, type Route } from '@playwright/test';

/**
 * Audience and Billing pages SSR-auth gate; without a session they redirect
 * to account. Smoke covers that gate plus owner shell tab wiring on the
 * client-side promotions workspace (mocked claims).
 */

async function fulfill(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test('unauthenticated Audience and Billing routes redirect to account with next', async ({ page }) => {
  await page.goto('/restaurant/audience/?venueId=42');
  await expect(page).toHaveURL(/\/account\/\?next=/);
  expect(decodeURIComponent(new URL(page.url()).searchParams.get('next') || '')).toContain(
    '/restaurant/audience/'
  );

  await page.goto('/restaurant/billing/?venueId=42');
  await expect(page).toHaveURL(/\/account\/\?next=/);
  expect(decodeURIComponent(new URL(page.url()).searchParams.get('next') || '')).toContain(
    '/restaurant/billing/'
  );
});

test('owner promotions shell exposes Audience and Billing tabs with venue links', async ({ page }) => {
  const venueId = 42;
  await page.route('**/api/account/me', (route) =>
    fulfill(route, {
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
    })
  );
  await page.route('**/api/admin/me', (route) =>
    fulfill(route, { authenticated: false, admin: null })
  );
  await page.route('**/api/restaurant/claims', (route) =>
    fulfill(route, {
      authenticated: true,
      serverNow: '2026-08-22T01:00:00.000Z',
      claims: [
        {
          id: 'claim-verified',
          userId: 'user-owner',
          venueId,
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
            id: venueId,
            days: ['Friday'],
            startTime: '16:00',
            endTime: '19:00',
          },
        },
      ],
    })
  );
  await page.route('**/api/restaurant/promotions**', (route) =>
    fulfill(route, {
      serverNow: '2026-08-22T01:00:00.000Z',
      venueId,
      promotions: [],
      entitlement: {
        plan: 'pro',
        allowance: 3,
        baseAllowance: 3,
        additionalAllowance: 0,
        monthlyAllowance: 3,
        monthKey: '2026-08',
        consumed: 0,
        reserved: 0,
        usedThisMonth: 0,
        remainingThisMonth: 3,
        freePromotionsRemaining: 3,
        canLaunchPromotion: true,
        isUnlimited: false,
      },
    })
  );

  await page.goto('/restaurant/');
  await expect(page.locator('[data-merchant-shell]')).toBeVisible();
  await expect(page.locator('[data-merchant-shell-tab="audience"]')).toHaveAttribute(
    'href',
    `/restaurant/audience/?venueId=${venueId}`
  );
  await expect(page.locator('[data-merchant-shell-tab="billing"]')).toHaveAttribute(
    'href',
    `/restaurant/billing/?venueId=${venueId}`
  );
  await expect(page.locator(`[data-venue-id="${venueId}"][data-verified-workspace="true"]`)).toBeVisible();
});
