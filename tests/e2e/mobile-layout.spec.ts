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
  test('desktop homepage filters use two compact rows', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });

    const rowTops = (await page.locator(
      '.filters > .search-input, .filter-details > .filter-btn, .filter-details > .time-filter-label, .filter-utilities',
    ).evaluateAll((items) => items.map((item) => item.getBoundingClientRect().top)))
      .sort((a, b) => a - b);
    const rows = rowTops.reduce<number[]>((groups, top) => {
      if (!groups.some((rowTop) => Math.abs(rowTop - top) <= 2)) groups.push(top);
      return groups;
    }, []);
    expect(rows).toHaveLength(2);

    const alignment = await page.evaluate(() => {
      const search = document.querySelector('.search-input')!.getBoundingClientRect();
      const results = document.querySelector('.results-info')!.getBoundingClientRect();
      const day = document.querySelector('#day-filter')!.getBoundingClientRect();
      const end = document.querySelector('#end-time-filter')!.closest('label')!.getBoundingClientRect();
      return {
        searchLeft: search.left,
        resultsLeft: results.left,
        dayLeft: day.left,
        endLeft: end.left,
        resultsCenter: results.top + results.height / 2,
        endCenter: end.top + end.height / 2,
      };
    });
    expect(alignment.resultsLeft).toBeCloseTo(alignment.searchLeft, 0);
    expect(alignment.endLeft).toBeCloseTo(alignment.dayLeft, 0);
    expect(alignment.resultsCenter).toBeCloseTo(alignment.endCenter, 0);
  });

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

  test('shared mobile menu stays visually consistent on My Stuff', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });

    const toggle = page.locator('.mobile-nav-toggle');
    const closed = await toggle.evaluate((button) => {
      const icon = button.querySelector<HTMLElement>('.mobile-nav-toggle-icon')!;
      return {
        buttonPadding: getComputedStyle(button).padding,
        middleWidth: icon.getBoundingClientRect().width,
        beforeWidth: Number.parseFloat(getComputedStyle(icon, '::before').width),
        afterWidth: Number.parseFloat(getComputedStyle(icon, '::after').width),
      };
    });
    expect(closed.buttonPadding).toBe('0px');
    expect(closed.middleWidth).toBeCloseTo(closed.beforeWidth, 0);
    expect(closed.middleWidth).toBeCloseTo(closed.afterWidth, 0);

    await toggle.click();
    await expect(page.locator('.site-nav .links')).toBeVisible();
    const open = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('.mobile-nav-toggle')!;
      const icon = button.querySelector<HTMLElement>('.mobile-nav-toggle-icon')!;
      const buttonRect = button.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      const backdrop = document.querySelector<HTMLElement>('.mobile-nav-backdrop')!;
      return {
        centerDelta: Math.abs(
          (buttonRect.left + buttonRect.width / 2) - (iconRect.left + iconRect.width / 2),
        ),
        backdropRadius: getComputedStyle(backdrop).borderRadius,
        backdropShadow: getComputedStyle(backdrop).boxShadow,
      };
    });
    expect(open.centerDelta).toBeLessThanOrEqual(1);
    expect(open.backdropRadius).toBe('0px');
    expect(open.backdropShadow).toBe('none');
  });

  test('homepage alert composer keeps channels and actions in clean mobile rows', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.route('**/api/account/me', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        isAdmin: false,
        lists: { lists: [], pendingInvites: [] },
        user: {
          id: 'mobile-alert-user',
          name: 'Mobile Alert User',
          email: 'mobile-alert@example.com',
          phone: '+18055551234567890',
          smsOptedIn: true,
          alerts: [],
          saved: { defaultListId: '', lists: [], venues: [] },
        },
      }),
    }));
    await page.route('**/api/account/follows', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ follows: [] }),
    }));

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });
    await page.locator('#save-alert-btn').click();

    const panel = page.locator('#save-alert-panel');
    await expect(panel).toBeVisible();
    await expect(page.locator('#alert-text-note')).toContainText('+18055551234567890');

    const layout = await panel.evaluate((element) => {
      const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
      const panelRect = element.getBoundingClientRect();
      const input = rect('#alert-name-input');
      const email = rect('label:has(#alert-channel-email)');
      const text = rect('label:has(#alert-channel-text)');
      const save = rect('#alert-save-confirm');
      const cancel = rect('#alert-save-cancel');
      const note = rect('#alert-text-note');
      return {
        panel: { left: panelRect.left, right: panelRect.right },
        input: { left: input.left, right: input.right },
        channels: [email, text].map((item) => ({ left: item.left, right: item.right, top: item.top, height: item.height })),
        actions: [save, cancel].map((item) => ({ left: item.left, right: item.right, top: item.top, height: item.height })),
        note: { top: note.top },
      };
    });

    expect(layout.input.left).toBeGreaterThanOrEqual(layout.panel.left);
    expect(layout.input.right).toBeLessThanOrEqual(layout.panel.right + 1);
    expect(new Set(layout.channels.map((box) => Math.round(box.top))).size).toBe(1);
    expect(new Set(layout.actions.map((box) => Math.round(box.top))).size).toBe(1);
    expect(Math.min(...layout.channels.map((box) => box.height))).toBeGreaterThanOrEqual(44);
    expect(Math.min(...layout.actions.map((box) => box.height))).toBeGreaterThanOrEqual(44);
    expect(Math.max(...layout.channels.map((box) => box.right))).toBeLessThanOrEqual(layout.panel.right + 1);
    expect(Math.max(...layout.actions.map((box) => box.right))).toBeLessThanOrEqual(layout.panel.right + 1);
    expect(layout.note.top).toBeGreaterThan(layout.channels[0].top);

    await page.locator('#alert-save-confirm').click();
    await expect(page.locator('#alert-save-status')).toHaveText('Give this alert a name.');
  });

  test('neighborhood card popovers render above following cards', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/account/me', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        isAdmin: false,
        lists: { lists: [], pendingInvites: [] },
        user: { id: 'neighborhood-user', name: 'Neighborhood User', email: 'neighbor@example.com' },
      }),
    }));
    await page.route('**/api/account/follows**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/api/account/follows') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ follows: [] }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ follow: { promotionAlertsEnabled: true } }),
      });
    });

    await page.goto('/neighborhoods/east-village/', { waitUntil: 'domcontentloaded' });
    const firstCard = page.locator('.venue-result').first();
    await expect(firstCard).toBeVisible();

    const expectPopoverAboveNextCard = async (selector: string) => {
      const menu = firstCard.locator(selector);
      await expect(menu).toBeVisible();
      await menu.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      const geometry = await page.evaluate((menuSelector) => {
        const card = document.querySelector<HTMLElement>('.venue-result')!;
        const nextCard = document.querySelectorAll<HTMLElement>('.venue-result')[1];
        const menu = card.querySelector<HTMLElement>(menuSelector)!;
        const cardRect = card.getBoundingClientRect();
        const nextRect = nextCard.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const x = menuRect.left + menuRect.width / 2;
        const y = Math.min(menuRect.bottom - 2, Math.max(cardRect.bottom + 2, nextRect.top + 2));
        const hit = document.elementFromPoint(x, y);
        return {
          extendsPastCard: menuRect.bottom > cardRect.bottom,
          overlapsNextCard: menuRect.bottom > nextRect.top,
          hitMenu: Boolean(hit?.closest(menuSelector)),
          cardOverflow: getComputedStyle(card).overflow,
        };
      }, selector);
      expect(geometry.cardOverflow).toBe('visible');
      expect(geometry.extendsPastCard).toBe(true);
      expect(geometry.overlapsNextCard).toBe(true);
      expect(geometry.hitMenu).toBe(true);
    };

    await firstCard.locator('[data-card-share]').click();
    await expectPopoverAboveNextCard('[data-card-share-menu]');
    await firstCard.locator('[data-card-share]').click();

    await firstCard.locator('[data-card-notify]').click();
    await expectPopoverAboveNextCard('[data-card-notify-menu]');
  });

  test('neighborhood image framing never covers card copy', async ({ page }) => {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/neighborhoods/kearny-mesa/', { waitUntil: 'domcontentloaded' });
      const card = page.locator('[data-venue-card="80"]');
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();

      const layout = await card.evaluate((element) => {
        const frame = element.querySelector<HTMLElement>('.venue-image')!;
        const image = frame.querySelector('img')!;
        const schedule = element.querySelector<HTMLElement>('.schedule')!;
        const title = element.querySelector<HTMLElement>('h3')!;
        const copyIsAboveImage = (copy: HTMLElement) => {
          const rect = copy.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return hit !== image && !image.contains(hit);
        };
        return {
          frameOverflow: getComputedStyle(frame).overflow,
          scheduleVisible: copyIsAboveImage(schedule),
          titleVisible: copyIsAboveImage(title),
        };
      });

      expect(layout.frameOverflow).toBe('hidden');
      expect(layout.scheduleVisible).toBe(true);
      expect(layout.titleVisible).toBe(true);
    }
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
