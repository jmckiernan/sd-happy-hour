import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { expect, test } from '@playwright/test';

// The two halves of the window-only decision, exercised in a real browser.
//
// 1. A venue page with a window and no offers invites whoever works there to
//    add the happy hour menu. Until this pass, the save behind that invitation
//    rejected every listing with no deals, so the only owners the panel spoke
//    to were the only owners who could not save. The owner form has to accept
//    a listing that still has none.
// 2. Those same venues carry no deal types, so every deal-type selection on the
//    homepage excluded them. They are now selectable in their own right, and a
//    deal-type selection says how many venues it is leaving out.
//
// Auth and persistence are stubbed the way the other manage-page specs stub
// them, but the PUT handler runs the real validateOwnerPatch — the validator is
// the thing under test, and a stub that always says yes would prove nothing.

const venueId = 2;

// src/lib/venueContent.ts reaches happy-hours.json and the database layer
// through its imports, neither of which plain Node can load, so it is bundled
// the way tests/build-venue-management-test.mjs bundles it. The point is that
// the PUT stub below runs the route's real validator.
let validateOwnerPatch: (input: Record<string, any>) => { patch: Record<string, any>; errors: string[] };

test.beforeAll(async () => {
  const outfile = path.join(process.cwd(), '.data', 'tests', 'venue-content.e2e.mjs');
  buildSync({
    entryPoints: [path.join(process.cwd(), 'src', 'lib', 'venueContent.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    packages: 'external',
    define: { 'import.meta.env.PROD': 'false' },
    loader: { '.json': 'json' },
  });
  ({ validateOwnerPatch } = await import(pathToFileURL(outfile).href));
});

const windowOnlyListing = {
  id: venueId,
  name: 'Craft & Commerce',
  neighborhood: 'Little Italy',
  address: '675 W Beech St',
  days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  startTime: '16:00',
  endTime: '18:00',
  deals: [],
  dealTypes: [],
 vibe: 'Trendy gastropub',
  website: 'https://example.com',
  phone: '(619) 555-0100',
  image: '',
};

async function stubManagePage(page: import('@playwright/test').Page, saved: Record<string, any>[]) {
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' })
  );
 await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.route('**/api/account/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, user: { id: 'owner-1' } }),
    })
  );
  await page.route('**/api/admin/me', (route) =>
    route.fulfill({
     status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: false, admin: null }),
    })
  );
  await page.route(`**/api/restaurant/venues/${venueId}/photos`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ photos: [], limit: 40 }),
   })
  );
  await page.route(`**/api/restaurant/venues/${venueId}/menu`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ menu: [], limits: { sections: 12, items: 60 } }),
    })
  );
  await page.route(`**/api/restaurant/venues/${venueId}/listing`, async (route) => {
   if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      // The route's own validator, not a stand-in for it.
      const { patch, errors } = validateOwnerPatch(body.listing || {});
      if (errors.length) {
        await route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({ errors }),
        });
       return;
      }
      saved.push(patch);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ listing: { ...windowOnlyListing, ...patch }, updatedAt: null }),
      });
      return;
    }
   await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        listing: windowOnlyListing,
        photoOptions: [],
        editableFields: [],
        hasOverride: false,
        updatedAt: null,
      }),
   });
  });
}

test('an owner can save a window-only listing through the owner edit flow', async ({ page }) => {
  const saved: Record<string, any>[] = [];
  await stubManagePage(page, saved);

  await page.goto('/restaurant/manage/craft-commerce/');
  await expect(page.getByRole('heading', { name: 'Venue details' })).toBeVisible();

  const deals = page.locator('[data-lf="deals"]');
  await expect(deals).toHaveValue('');
  await expect(page.getByText('Deals (one per line, optional)')).toBeVisible();

  const save = page.getByRole('button', { name: 'Save changes' });
  await expect(save).toBeEnabled();
  await save.click();

  await expect(page.getByText('Saved — your page is updated.')).toBeVisible();
  expect(saved).toHaveLength(1);
 expect(saved[0].deals).toEqual([]);
  expect(saved[0].startTime).toBe('16:00');

  // The failure this replaces, so the test fails loudly if the old rule returns.
  await expect(page.getByText('Add at least one deal.')).toHaveCount(0);
});

test('deal types cannot be saved without the deals they describe', async ({ page }) => {
  const saved: Record<string, any>[] = [];
  await stubManagePage(page, saved);

 await page.goto('/restaurant/manage/craft-commerce/');
  await expect(page.getByRole('heading', { name: 'Venue details' })).toBeVisible();

  await page.locator('input[data-lf="dealTypes"][value="beer"]').check();
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByText('Remove the deal types, or add the deals they describe.')).toBeVisible();
  expect(saved).toHaveLength(0);
});

test('a deal-type selection says how many venues it excludes for unknown offers', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' })
  );
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());

  await page.goto('/');
  const count = page.locator('#result-count');
  await expect.poll(async () => Number(await count.textContent())).toBeGreaterThan(0);

  const dealFilter = page.locator('#deal-filter');
  const note = page.locator('#excluded-note');

  // The page opens on today's weekday, which it chose rather than the visitor,
  // so the same note reports what that is hiding and offers to widen it.
  await expect(note).toContainText('no happy hour on');
  const shownToday = Number(await count.textContent());
  await note.getByRole('button', { name: 'show every day' }).click();
  await expect(page.locator('#day-filter')).toHaveValue('');
  await expect.poll(async () => Number(await count.textContent())).toBeGreaterThan(shownToday);

  await dealFilter.selectOption('beer');
  await expect(note).toContainText('publish happy hour times but not what is on offer');
  const excluded = Number((await note.textContent())?.match(/^(\d+)/)?.[1]);
  expect(excluded).toBeGreaterThan(0);

  await note.getByRole('button', { name: 'show those instead' }).click();
 await expect(dealFilter).toHaveValue('offers-unknown');
  await expect.poll(async () => Number(await count.textContent())).toBe(excluded);
  await expect(note).toBeHidden();
});
