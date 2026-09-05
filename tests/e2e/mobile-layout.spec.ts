import { expect, test, type Page } from '@playwright/test';

const routes = [
  '/',
  '/live-deals/',
  '/neighborhoods/',
  '/neighborhoods/little-italy/',
  '/venues/your-mother-s-house/',
  '/blog/',
  '/about/',
  '/features/',
  '/submit/',
  '/report-a-bug/',
  '/account/',
] as const;

async function expectNoHorizontalPageOverflow(page: Page, route: string) {
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  if (route === '/') {
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });
  }
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    dimensions.scrollWidth,
    `${route} is ${dimensions.scrollWidth - dimensions.clientWidth}px wider than the mobile viewport`,
  ).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

test.describe('mobile layout regressions', () => {
  test('key routes fit a 320px viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    for (const route of routes) {
      await expectNoHorizontalPageOverflow(page, route);
    }
  });

  test('key routes fit a 430px viewport', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    for (const route of routes) {
      await expectNoHorizontalPageOverflow(page, route);
    }
  });

  test('homepage navigation and filters leave the content usable', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });

    const layout = await page.evaluate(() => {
      const nav = document.querySelector('.site-nav')!.getBoundingClientRect();
      const badge = document.querySelector('.hero-badge')!.getBoundingClientRect();
      const filters = document.querySelector('.filters-section')!;
      const firstCard = document.querySelector('.card')!.getBoundingClientRect();
      return {
        navBottom: nav.bottom,
        badgeTop: badge.top,
        filterPosition: getComputedStyle(filters).position,
        firstCardLeft: firstCard.left,
        firstCardRight: firstCard.right,
        viewportWidth: document.documentElement.clientWidth,
      };
    });

    expect(layout.navBottom).toBeLessThanOrEqual(layout.badgeTop + 1);
    expect(layout.filterPosition).toBe('static');
    expect(layout.firstCardLeft).toBeGreaterThanOrEqual(0);
    expect(layout.firstCardRight).toBeLessThanOrEqual(layout.viewportWidth + 1);

    await expect(page.locator('.site-nav .links')).toBeHidden();
    const menuToggle = page.getByRole('button', { name: 'Open menu' });
    await expect(menuToggle).toBeVisible();
    await page.locator('.mobile-nav-toggle').click();
    await expect(page.locator('.site-nav .links')).toBeVisible();

    const navPanel = await page.locator('.site-nav .links').boundingBox();
    expect(navPanel?.x || 0).toBeGreaterThanOrEqual(0);
    expect((navPanel?.x || 0) + (navPanel?.width || 999)).toBeLessThanOrEqual(layout.viewportWidth + 1);

    const navLinks = page.locator('.site-nav .links a:visible');
    for (let index = 0; index < await navLinks.count(); index += 1) {
      expect((await navLinks.nth(index).boundingBox())?.height || 0).toBeGreaterThanOrEqual(44);
    }

    await page.locator('.mobile-nav-toggle').click();
    await expect(page.locator('.site-nav .links')).toBeHidden();

    const filterDetails = page.locator('#filter-details');
    await expect(filterDetails).toBeHidden();
    await page.locator('#mobile-filter-toggle').click();
    await expect(filterDetails).toBeVisible();
    const filterBox = await filterDetails.boundingBox();
    expect(filterBox?.x || 0).toBeGreaterThanOrEqual(0);
    expect((filterBox?.x || 0) + (filterBox?.width || 999)).toBeLessThanOrEqual(layout.viewportWidth + 1);
  });

  test('venue actions and text menu use their mobile layouts', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/venues/the-waterfront-bar-grill/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('.venue-hero #share-btn')).toHaveCount(0);
    await expect(page.locator('.venue-actions #share-btn')).toBeVisible();

    const actions = page.locator('.venue-actions > a:visible, .venue-actions > button:visible, .venue-actions > div:visible');
    await expect(actions).toHaveCount(6);
    const actionBoxes = await actions.evaluateAll((items) => items.map((item) => {
      const rect = item.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top };
    }));
    expect(Math.max(...actionBoxes.map((box) => box.right))).toBeLessThanOrEqual(320);
    expect(new Set(actionBoxes.map((box) => Math.round(box.top))).size).toBe(3);

    const textMenuButton = page.getByRole('button', { name: /View menu as text/i });
    await textMenuButton.scrollIntoViewIfNeeded();
    await textMenuButton.click();
    await expect(page.locator('#hh-menu-text-dialog')).toBeVisible();
    const menuLayout = await page.evaluate(() => {
      const header = document.querySelector('.hh-menu-text-dialog-header')!.getBoundingClientRect();
      const body = document.querySelector('.hh-menu-text-dialog-body')!.getBoundingClientRect();
      return { headerBottom: header.bottom, bodyTop: body.top };
    });
    expect(menuLayout.bodyTop).toBeGreaterThanOrEqual(menuLayout.headerBottom - 1);
  });

  test('sign-in card stays inside a 320px viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.auth-grid .panel').first()).toBeVisible();

    const bounds = await page.locator('.auth-grid .panel').first().boundingBox();
    expect(bounds?.x || 0).toBeGreaterThanOrEqual(0);
    expect((bounds?.x || 0) + (bounds?.width || 999)).toBeLessThanOrEqual(320);

    const googleBounds = await page.locator('#google-signin').boundingBox();
    expect(googleBounds?.x || 0).toBeGreaterThanOrEqual(bounds?.x || 0);
    expect((googleBounds?.x || 0) + (googleBounds?.width || 999)).toBeLessThanOrEqual((bounds?.x || 0) + (bounds?.width || 320));
  });

  test('My Stuff alert actions share one row and fields use the branded control system', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.route('**/api/account/me', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        isAdmin: false,
        lists: { lists: [], pendingInvites: [] },
        user: {
          id: 'mobile-user',
          name: 'Mobile User',
          email: 'mobile@example.com',
          phone: '',
          smsOptedIn: false,
          weeklyDigestOptIn: false,
          hasPassword: false,
          alerts: [{
            id: 'alert-mobile',
            name: 'Friday drinks',
            active: true,
            filters: { days: ['Friday'], neighborhood: '', dealType: '', query: '', startTime: '', endTime: '' },
            channels: { email: true, text: false },
          }],
          saved: { defaultListId: '', lists: [], venues: [] },
        },
      }),
    }));
    await page.route('**/data/happy-hours.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    }));

    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    const actionRow = page.locator('.alert-card-actions');
    await expect(actionRow).toBeVisible();
    const buttonBoxes = await actionRow.locator('button').evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top };
    }));
    expect(buttonBoxes).toHaveLength(3);
    expect(new Set(buttonBoxes.map((box) => Math.round(box.top))).size).toBe(1);
    expect(Math.max(...buttonBoxes.map((box) => box.right))).toBeLessThanOrEqual(320);

    const alertName = page.locator('.alert-card input[data-field="name"]');
    await expect(alertName).toBeVisible();
    const controlStyle = await alertName.evaluate((input) => ({
      radius: getComputedStyle(input).borderRadius,
      height: input.getBoundingClientRect().height,
    }));
    expect(Number.parseFloat(controlStyle.radius)).toBeGreaterThanOrEqual(14);
    expect(controlStyle.height).toBeGreaterThanOrEqual(48);
  });

  test('mobile forms do not trigger iOS input zoom or inflate checkboxes', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/submit/', { waitUntil: 'domcontentloaded' });

    const fieldFontSizes = await page.locator('input:not([type="checkbox"]), textarea, select').evaluateAll((fields) =>
      fields.map((field) => Number.parseFloat(getComputedStyle(field).fontSize)),
    );
    expect(fieldFontSizes.length).toBeGreaterThan(0);
    expect(Math.min(...fieldFontSizes)).toBeGreaterThanOrEqual(16);

    const checkbox = page.locator('.checkbox-grid input[type="checkbox"]').first();
    const checkboxBox = await checkbox.boundingBox();
    const labelBox = await checkbox.locator('xpath=..').boundingBox();
    expect(checkboxBox?.width || 999).toBeLessThanOrEqual(24);
    expect(labelBox?.height || 0).toBeGreaterThanOrEqual(44);
  });
});
