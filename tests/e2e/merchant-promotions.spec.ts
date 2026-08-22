import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  MerchantPromotionDto,
  MerchantPromotionEntitlementDto,
  PromotionActionsDto,
  PromotionState,
} from '../../src/lib/merchantPromotionDashboard';

const SERVER_NOW = '2026-08-22T01:00:00.000Z';
const VENUE_ID = 42;

const ACCOUNT_RESPONSE = {
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
};

const CLAIMS_RESPONSE = {
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
      happyHourSchedule: {
        id: VENUE_ID,
        days: ['Friday'],
        startTime: '16:00',
        endTime: '19:00',
      },
    },
  ],
};

function entitlement(
  consumed = 1,
  reserved = 1,
  allowance = 3
): MerchantPromotionEntitlementDto {
  const remaining = Math.max(allowance - consumed - reserved, 0);
  return {
    plan: 'pro',
    allowance,
    monthlyAllowance: allowance,
    monthKey: '2026-08',
    consumed,
    reserved,
    usedThisMonth: consumed,
    remainingThisMonth: remaining,
    freePromotionsRemaining: remaining,
    canLaunchPromotion: remaining > 0,
    isUnlimited: false,
  };
}

function actionsFor(state: PromotionState): PromotionActionsDto {
  return {
    update: state === 'draft' || state === 'scheduled',
    publish: state === 'draft',
    startNow: state === 'draft' || state === 'scheduled',
    cancel: state === 'scheduled',
    end: state === 'live',
    delete: state === 'draft',
  };
}

function promotion(
  state: PromotionState,
  overrides: Partial<MerchantPromotionDto> = {}
): MerchantPromotionDto {
  const timingByState: Record<
    PromotionState,
    Pick<
      MerchantPromotionDto,
      'startsAt' | 'endsAt' | 'effectiveEndsAt' | 'publishedAt' | 'endedAt' | 'cancelledAt'
    >
  > = {
    draft: {
      startsAt: null,
      endsAt: null,
      effectiveEndsAt: null,
      publishedAt: null,
      endedAt: null,
      cancelledAt: null,
    },
    scheduled: {
      startsAt: '2026-08-23T01:00:00.000Z',
      endsAt: '2026-08-23T03:00:00.000Z',
      effectiveEndsAt: '2026-08-23T03:00:00.000Z',
      publishedAt: '2026-08-21T18:00:00.000Z',
      endedAt: null,
      cancelledAt: null,
    },
    live: {
      startsAt: '2026-08-22T00:00:00.000Z',
      endsAt: '2026-08-22T03:00:00.000Z',
      effectiveEndsAt: '2026-08-22T03:00:00.000Z',
      publishedAt: '2026-08-22T00:00:00.000Z',
      endedAt: null,
      cancelledAt: null,
    },
    ended: {
      startsAt: '2026-08-20T22:00:00.000Z',
      endsAt: '2026-08-21T02:00:00.000Z',
      effectiveEndsAt: '2026-08-21T01:30:00.000Z',
      publishedAt: '2026-08-20T20:00:00.000Z',
      endedAt: '2026-08-21T01:30:00.000Z',
      cancelledAt: null,
    },
    cancelled: {
      startsAt: '2026-08-24T00:00:00.000Z',
      endsAt: '2026-08-24T02:00:00.000Z',
      effectiveEndsAt: '2026-08-24T02:00:00.000Z',
      publishedAt: '2026-08-20T20:00:00.000Z',
      endedAt: null,
      cancelledAt: '2026-08-21T01:30:00.000Z',
    },
  };

  return {
    id: `promotion-${state}`,
    venueId: VENUE_ID,
    type: 'special_deal',
    title: `${state} promotion`,
    description: 'A merchant promotion fixture.',
    dealCode: null,
    ...timingByState[state],
    state,
    createdAt: '2026-08-20T18:00:00.000Z',
    updatedAt: '2026-08-21T18:00:00.000Z',
    allowedActions: actionsFor(state),
    ...overrides,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockDashboard(
  page: Page,
  options: {
    promotions?: MerchantPromotionDto[];
    entitlement?: MerchantPromotionEntitlementDto;
    handlePromotions?: (route: Route) => Promise<void>;
  } = {}
): Promise<void> {
  await page.route('**/api/account/me', (route) => fulfillJson(route, ACCOUNT_RESPONSE));
  await page.route('**/api/admin/me', (route) =>
    fulfillJson(route, { authenticated: false, admin: null })
  );
  await page.route('**/api/restaurant/claims', (route) =>
    fulfillJson(route, CLAIMS_RESPONSE)
  );
  await page.route('**/api/restaurant/promotions**', async (route) => {
    if (options.handlePromotions) {
      await options.handlePromotions(route);
      return;
    }
    await fulfillJson(route, {
      serverNow: SERVER_NOW,
      venueId: VENUE_ID,
      promotions: options.promotions ?? [],
      entitlement: options.entitlement ?? entitlement(),
    });
  });
}

test('verified venue separates recurring happy hour from backend-grouped promotions and keeps terminal history read-only', async ({
  page,
}) => {
  await mockDashboard(page, {
    promotions: [
      promotion('live', { id: 'promotion-live', title: 'Sunset Oyster Hour' }),
      promotion('scheduled', { id: 'promotion-scheduled', title: 'Sunday Brunch Preview' }),
      promotion('draft', { id: 'promotion-draft', title: 'Draft Taco Drop' }),
      promotion('ended', { id: 'promotion-ended', title: 'Expired Chef Special' }),
    ],
  });

  await page.goto('/restaurant/');

  const claim = page.locator(`.claim-card[data-venue-id="${VENUE_ID}"]`);
  await expect(claim.locator('.pill.verified')).toHaveText('verified');

  const command = claim.locator('[data-promotion-command]');
  const today = command.locator('section[aria-label="Today\'s Happy Hour"]');
  const promotionsHeader = command.locator('section[aria-label="Promotions"]');
  await expect(today).toContainText("Today's Happy Hour");
  await expect(today).toContainText('4:00 PM–7:00 PM');
  await expect(today).toContainText('Recurring listing schedule · informational only');
  await expect(today).not.toContainText('Sunset Oyster Hour');
  await expect(promotionsHeader).toContainText('Promotions');
  await expect(promotionsHeader).toContainText(
    'Allowance: 1 included promotion remaining this month · 1 scheduled promotion reserved'
  );

  const active = command.locator('section[aria-label="Active promotions"]');
  const scheduled = command.locator('section[aria-label="Scheduled promotions"]');
  const drafts = command.locator('section[aria-label="Drafts promotions"]');
  const past = command.locator('section[aria-label="Past promotions"]');

  const activeCard = active.locator('[data-promotion-id="promotion-live"]');
  await expect(active.locator('.merchant-promotion-count')).toHaveText('1');
  await expect(activeCard).toContainText('Sunset Oyster Hour');
  await expect(activeCard.locator('.merchant-state-badge.live')).toHaveText('Live promotion');
  await expect(activeCard.getByRole('button', { name: 'End promotion' })).toBeVisible();
  await expect(activeCard.getByRole('button', { name: 'Edit' })).toHaveCount(0);

  const scheduledCard = scheduled.locator('[data-promotion-id="promotion-scheduled"]');
  await expect(scheduledCard).toContainText('Sunday Brunch Preview');
  await expect(scheduledCard.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(scheduledCard.getByRole('button', { name: 'Start Now' })).toBeVisible();
  await expect(scheduledCard.getByRole('button', { name: 'Cancel' })).toBeVisible();

  const draftCard = drafts.locator('[data-promotion-id="promotion-draft"]');
  await expect(draftCard).toContainText('Draft Taco Drop');
  await expect(draftCard.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(draftCard.getByRole('button', { name: 'Schedule' })).toBeVisible();
  await expect(draftCard.getByRole('button', { name: 'Start Now' })).toBeVisible();
  await expect(draftCard.getByRole('button', { name: 'Delete draft' })).toBeVisible();

  const terminalCard = past.locator('[data-promotion-id="promotion-ended"]');
  await expect(terminalCard).toHaveClass(/is-terminal/);
  await expect(terminalCard.locator('.merchant-state-badge.ended')).toHaveText('Ended');
  await expect(terminalCard).toContainText('Read-only history');
  await expect(terminalCard.locator('[data-promotion-action]')).toHaveCount(0);
  await expect(terminalCard.locator('.merchant-card-actions')).toHaveCount(0);
});

test('Launch Live Promotion confirms, creates an untimed draft, starts it with only endsAt, and refetches', async ({
  page,
}) => {
  type PromotionCall = {
    method: string;
    pathname: string;
    body?: Record<string, unknown>;
  };

  const calls: PromotionCall[] = [];
  const initialEntitlement = entitlement(0, 0, 3);
  const liveEntitlement = entitlement(1, 0, 3);
  const draft = promotion('draft', {
    id: 'promotion-created',
    title: '$5 Margaritas + $2 Tacos',
    description: 'Patio only.',
    dealCode: 'SUNSET',
  });
  const live = promotion('live', {
    ...draft,
    state: 'live',
    startsAt: '2026-08-22T01:00:05.000Z',
    endsAt: '2026-08-22T03:00:00.000Z',
    effectiveEndsAt: '2026-08-22T03:00:00.000Z',
    publishedAt: '2026-08-22T01:00:05.000Z',
    allowedActions: actionsFor('live'),
  });
  let backendState: 'empty' | 'draft' | 'live' = 'empty';

  await mockDashboard(page, {
    handlePromotions: async (route) => {
      const request = route.request();
      const method = request.method();
      const url = new URL(request.url());
      const body = request.postData()
        ? (request.postDataJSON() as Record<string, unknown>)
        : undefined;
      calls.push({ method, pathname: url.pathname, body });

      if (method === 'GET' && url.pathname === '/api/restaurant/promotions') {
        const promotions = backendState === 'empty' ? [] : [backendState === 'draft' ? draft : live];
        await fulfillJson(route, {
          serverNow: SERVER_NOW,
          venueId: VENUE_ID,
          promotions,
          entitlement: backendState === 'live' ? liveEntitlement : initialEntitlement,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/restaurant/promotions') {
        backendState = 'draft';
        await fulfillJson(
          route,
          { serverNow: SERVER_NOW, promotion: draft, entitlement: initialEntitlement },
          201
        );
        return;
      }

      if (
        method === 'POST' &&
        url.pathname === '/api/restaurant/promotions/promotion-created/start-now'
      ) {
        backendState = 'live';
        await fulfillJson(route, {
          serverNow: '2026-08-22T01:00:05.000Z',
          promotion: live,
          entitlement: liveEntitlement,
        });
        return;
      }

      await fulfillJson(route, { errors: [`Unexpected ${method} ${url.pathname}.`] }, 500);
    },
  });

  await page.goto('/restaurant/');
  const claim = page.locator(`.claim-card[data-venue-id="${VENUE_ID}"]`);
  await expect(claim.locator('.merchant-entitlement')).toContainText(
    '3 included promotions remaining this month'
  );
  await claim.getByRole('button', { name: 'Launch Live Promotion' }).click();

  const dialog = page.getByRole('dialog', { name: 'Launch Live Promotion' });
  await dialog.getByLabel('Headline').fill('$5 Margaritas + $2 Tacos');
  await dialog.getByLabel('Details').fill('Patio only.');
  await dialog.getByLabel('Deal code').fill('SUNSET');
  await dialog.getByLabel('End in San Diego').fill('2026-08-21T20:00');
  await dialog.getByRole('button', { name: 'Review promotion' }).click();

  await expect(dialog.getByRole('heading', { name: 'Ready to go Live?' })).toBeVisible();
  await expect(dialog).toContainText(
    'This promotion will become visible as soon as the server starts it.'
  );
  await expect(dialog.locator('[data-confirmation-headline]')).toHaveText(
    '$5 Margaritas + $2 Tacos'
  );
  await dialog.getByRole('button', { name: 'GO LIVE' }).click();

  await expect(dialog).not.toBeVisible();
  await expect(
    claim
      .locator('section[aria-label="Active promotions"]')
      .locator('[data-promotion-id="promotion-created"]')
  ).toContainText('$5 Margaritas + $2 Tacos');

  const createIndex = calls.findIndex(
    (call) => call.method === 'POST' && call.pathname === '/api/restaurant/promotions'
  );
  const startIndex = calls.findIndex((call) => call.pathname.endsWith('/start-now'));
  expect(createIndex).toBeGreaterThan(-1);
  expect(startIndex).toBeGreaterThan(createIndex);

  const createCall = calls[createIndex];
  expect(createCall.body).toEqual({
    venueId: VENUE_ID,
    type: 'special_deal',
    title: '$5 Margaritas + $2 Tacos',
    description: 'Patio only.',
    dealCode: 'SUNSET',
  });
  expect(createCall.body).not.toHaveProperty('startsAt');
  expect(createCall.body).not.toHaveProperty('endsAt');

  const startCall = calls[startIndex];
  expect(startCall.pathname).toBe('/api/restaurant/promotions/promotion-created/start-now');
  expect(startCall.body).toEqual({ endsAt: '2026-08-22T03:00:00.000Z' });
  expect(startCall.body).not.toHaveProperty('startsAt');

  expect(
    calls.slice(createIndex + 1, startIndex).some((call) => call.method === 'GET')
  ).toBe(true);
  expect(calls.slice(startIndex + 1).some((call) => call.method === 'GET')).toBe(true);
});

test('quota conflict reports the canonical target month, preserves the draft, and refetches current state', async ({
  page,
}) => {
  const currentEntitlement = entitlement(1, 0, 1);
  const targetEntitlement: MerchantPromotionEntitlementDto = {
    ...entitlement(1, 2, 3),
    monthKey: '2026-09',
  };
  const savedDraft = promotion('draft', {
    id: 'promotion-quota-draft',
    title: 'September sunset menu',
    startsAt: '2026-09-02T01:00:00.000Z',
    endsAt: '2026-09-02T03:00:00.000Z',
    effectiveEndsAt: '2026-09-02T03:00:00.000Z',
  });
  const calls: Array<{ method: string; pathname: string }> = [];
  let draftCreated = false;
  let quotaConflictIndex = -1;

  await mockDashboard(page, {
    handlePromotions: async (route) => {
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;
      calls.push({ method, pathname });

      if (method === 'GET' && pathname === '/api/restaurant/promotions') {
        await fulfillJson(route, {
          serverNow: SERVER_NOW,
          venueId: VENUE_ID,
          promotions: draftCreated ? [savedDraft] : [],
          entitlement: currentEntitlement,
        });
        return;
      }
      if (method === 'POST' && pathname === '/api/restaurant/promotions') {
        draftCreated = true;
        await fulfillJson(route, {
          serverNow: SERVER_NOW,
          promotion: savedDraft,
          entitlement: currentEntitlement,
        }, 201);
        return;
      }
      if (
        method === 'POST' &&
        pathname === '/api/restaurant/promotions/promotion-quota-draft/publish'
      ) {
        quotaConflictIndex = calls.length - 1;
        await fulfillJson(route, {
          code: 'promotion_quota_exhausted',
          errors: ['No included promotion is available for 2026-09.'],
          details: { entitlement: targetEntitlement },
        }, 409);
        return;
      }
      await fulfillJson(route, { errors: [`Unexpected ${method} ${pathname}.`] }, 500);
    },
  });

  await page.goto('/restaurant/');
  const claim = page.locator(`.claim-card[data-venue-id="${VENUE_ID}"]`);
  await expect(claim.getByRole('button', { name: 'Launch Live Promotion' })).toBeDisabled();
  await expect(claim.getByRole('button', { name: 'Schedule Promotion' })).toBeEnabled();

  await claim.getByRole('button', { name: 'Schedule Promotion' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule Promotion' });
  await expect(dialog.getByRole('button', { name: 'Save Draft' })).toBeEnabled();
  await dialog.getByLabel('Headline').fill('September sunset menu');
  await dialog.getByLabel('Start in San Diego').fill('2026-09-01T18:00');
  await dialog.getByLabel('End in San Diego').fill('2026-09-01T20:00');
  await dialog.getByRole('button', { name: 'Review promotion' }).click();
  await dialog.getByRole('button', { name: 'SCHEDULE PROMOTION', exact: true }).click();

  await expect(dialog).not.toBeVisible();
  const status = claim.locator('.merchant-promotion-load-status');
  await expect(status).toContainText('No included promotions remaining for September 2026.');
  await expect(status).toContainText(
    'Allowance: 3 included total · 1 used · 2 scheduled promotions reserved.'
  );
  await expect(status).toContainText('drafts remain available');
  await expect(status).not.toContainText(/upgrade|billing|paid/i);
  await expect(
    claim.locator('[data-promotion-id="promotion-quota-draft"]')
  ).toContainText('September sunset menu');
  await expect(claim.getByRole('button', { name: 'Schedule Promotion' })).toBeEnabled();
  await expect(claim.getByRole('button', { name: 'Launch Live Promotion' })).toBeDisabled();

  expect(calls.filter((call) =>
    call.method === 'POST' && call.pathname === '/api/restaurant/promotions'
  )).toHaveLength(1);
  expect(quotaConflictIndex).toBeGreaterThan(-1);
  expect(calls.slice(quotaConflictIndex + 1).some((call) =>
    call.method === 'GET' && call.pathname === '/api/restaurant/promotions'
  )).toBe(true);
});

test('silent canonical refresh preserves keyboard focus on a promotion action', async ({ page }) => {
  await mockDashboard(page, { promotions: [], entitlement: entitlement(0, 0, 3) });
  await page.goto('/restaurant/');

  const schedule = page
    .locator(`.claim-card[data-venue-id="${VENUE_ID}"]`)
    .getByRole('button', { name: 'Schedule Promotion' });
  await schedule.focus();
  await expect(schedule).toBeFocused();

  await Promise.all([
    page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/restaurant/promotions' &&
      response.request().method() === 'GET'
    ),
    page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow'))),
  ]);
  await expect(schedule).toBeFocused();
});

test('merchant deal codes clear before bfcache and on claim authorization failure', async ({
  page,
}) => {
  const privateDraft = promotion('draft', {
    id: 'promotion-private-draft',
    title: 'Owner-only draft',
    dealCode: 'OWNER-ONLY',
  });
  let authorized = true;
  await mockDashboard(page, {
    handlePromotions: async (route) => {
      if (route.request().method() !== 'GET') {
        await fulfillJson(route, { errors: ['Unexpected mutation.'] }, 500);
        return;
      }
      if (!authorized) {
        await fulfillJson(route, { errors: ['Verified claim required.'] }, 403);
        return;
      }
      await fulfillJson(route, {
        serverNow: SERVER_NOW,
        venueId: VENUE_ID,
        promotions: [privateDraft],
        entitlement: entitlement(0, 0, 3),
      });
    },
  });

  await page.goto('/restaurant/');
  await expect(page.getByText('Deal code: OWNER-ONLY')).toBeVisible();

  const cachedState = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    return {
      hasCode: document.body.textContent?.includes('OWNER-ONLY') ?? false,
      dashboardHidden: document.getElementById('dashboard')?.classList.contains('hidden') ?? false,
    };
  });
  expect(cachedState).toEqual({ hasCode: false, dashboardHidden: true });

  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  );
  await expect(page.getByText('Deal code: OWNER-ONLY')).toBeVisible();

  authorized = false;
  await Promise.all([
    page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/restaurant/promotions' &&
      response.status() === 403
    ),
    page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow'))),
  ]);
  await expect(page.getByText('Deal code: OWNER-ONLY')).toHaveCount(0);
  await expect(page.locator('.merchant-promotion-load-status')).toContainText(
    'Verified claim required.'
  );
});

test('San Diego DST gap is rejected and fall-back fold offers both occurrences', async ({ page }) => {
  await mockDashboard(page, { promotions: [], entitlement: entitlement(0, 0, 3) });
  await page.goto('/restaurant/');

  const claim = page.locator(`.claim-card[data-venue-id="${VENUE_ID}"]`);
  await expect(claim.locator('.merchant-entitlement')).toContainText(
    '3 included promotions remaining this month'
  );
  await claim.getByRole('button', { name: 'Schedule Promotion' }).click();

  const dialog = page.getByRole('dialog', { name: 'Schedule Promotion' });
  const startInput = dialog.getByLabel('Start in San Diego');
  const startError = dialog.locator('[data-start-error]');
  const startFold = dialog.locator('[data-start-fold]');

  await startInput.fill('2026-03-08T02:30');
  await expect(startError).toHaveText(
    'This time does not exist in San Diego because the clocks move forward. Choose another time.'
  );
  await expect(startFold).toBeHidden();

  await startInput.fill('2026-11-01T01:30');
  await expect(startError).toHaveText(
    'This San Diego time occurs twice. Choose the first or second occurrence.'
  );
  await expect(startFold).toBeVisible();
  await expect(startFold).toContainText('This time occurs twice. Choose one.');

  const firstOccurrence = startFold.getByLabel('First occurrence');
  const secondOccurrence = startFold.getByLabel('Second occurrence');
  await expect(firstOccurrence).toBeVisible();
  await expect(secondOccurrence).toBeVisible();
  await firstOccurrence.check();
  await expect(startError).toBeEmpty();
  await secondOccurrence.check();
  await expect(secondOccurrence).toBeChecked();
  await expect(startError).toBeEmpty();
});
