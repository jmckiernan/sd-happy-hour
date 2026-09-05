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

    const navLinks = page.locator('.site-nav .links a:visible');
    for (let index = 0; index < await navLinks.count(); index += 1) {
      expect((await navLinks.nth(index).boundingBox())?.height || 0).toBeGreaterThanOrEqual(44);
    }
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
