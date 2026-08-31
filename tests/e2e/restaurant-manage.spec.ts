import { expect, test } from '@playwright/test';

const venueId = 2;
const currentFeaturedImage = '/images/vibes/trendy-gastropub.jpg';
const menuPhoto = {
  id: '11111111-1111-4111-8111-111111111111',
  url: '/images/vibes/craft-cocktails.jpg',
  caption: 'Old fashioned',
  status: 'published',
  photoType: 'menu_item',
  reason: '',
  sortOrder: 0,
  createdAt: '2026-08-22T00:00:00.000Z',
};

const listing = {
  id: venueId,
  name: 'Craft & Commerce',
  neighborhood: 'Little Italy',
  address: '675 W Beech St',
  days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  openTime: '11:30',
  closeTime: '23:00',
  startTime: '16:00',
  endTime: '18:00',
  deals: ['$8 cocktails'],
  vibe: 'Trendy gastropub',
  website: 'https://example.com',
  phone: '(619) 555-0100',
  dealTypes: ['cocktails'],
  image: currentFeaturedImage,
};

const menu = [
  {
    id: '22222222-2222-4222-8222-222222222222',
    venueId,
    title: 'Cocktails',
    note: '',
    sortOrder: 0,
    items: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        sectionId: '22222222-2222-4222-8222-222222222222',
        name: 'Old Fashioned',
        price: '$8',
        description: 'Bourbon, bitters, and orange.',
        photoId: menuPhoto.id,
        showPhotoInGallery: true,
        sortOrder: 0,
      },
    ],
  },
];

test('restaurant manager shows the current image and can edit menu item gallery behavior', async ({ page }) => {
  const menuActions: any[] = [];
  const currentMenu = structuredClone(menu);

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
  await page.route(`**/api/restaurant/venues/${venueId}/listing`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        listing,
        photoOptions: [],
        editableFields: [],
        hasOverride: false,
        updatedAt: null,
      }),
    });
  });
  await page.route(`**/api/restaurant/venues/${venueId}/photos`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ photos: [menuPhoto], limit: 40 }),
    });
  });
  await page.route(`**/api/restaurant/venues/${venueId}/menu`, async (route) => {
    if (route.request().method() === 'POST') {
      const action = route.request().postDataJSON();
      menuActions.push(action);
      const item = currentMenu[0].items[0];
      if (typeof action.showPhotoInGallery === 'boolean') {
        item.showPhotoInGallery = action.showPhotoInGallery;
      }
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ menu: currentMenu, limits: { sections: 12, items: 60 } }),
    });
  });

  await page.goto('/restaurant/manage/craft-commerce/');

  await expect(page.getByRole('heading', { name: 'Venue details' })).toBeVisible();
  await expect(page.getByText('Open Time', { exact: true })).toBeVisible();
  await expect(page.getByText('Close Time', { exact: true })).toBeVisible();
  await expect(page.getByText('Happy Hour Start Time', { exact: true })).toBeVisible();
  await expect(page.getByText('Happy Hour End Time', { exact: true })).toBeVisible();

  const featuredPicker = page.locator('[data-lf-picker]');
  await expect(featuredPicker.getByRole('img', { name: 'Current featured image' })).toHaveAttribute(
    'src',
    currentFeaturedImage
  );
  await expect(featuredPicker.getByText('No featured photo')).toHaveCount(0);

  const item = page.locator('[data-item-id="33333333-3333-4333-8333-333333333333"]');
  const galleryToggle = item.locator('[data-item-gallery-toggle]');
  await expect(galleryToggle).toBeChecked();
  await galleryToggle.uncheck();
  await expect.poll(() => menuActions.length).toBe(1);
  expect(menuActions[0]).toMatchObject({
    action: 'update-item',
    itemId: '33333333-3333-4333-8333-333333333333',
    showPhotoInGallery: false,
  });

  await item.getByRole('button', { name: 'Edit' }).click();
  await expect(item.locator('[data-edit-item] [data-item-gallery]')).not.toBeChecked();
  await item.locator('[data-edit-item] [name="name"]').fill('Discard this edit');
  await item.getByRole('button', { name: 'Cancel' }).click();
  await item.getByRole('button', { name: 'Edit' }).click();
  await expect(item.locator('[data-edit-item] [name="name"]')).toHaveValue('Old Fashioned');
  await item.locator('[data-edit-item] [name="name"]').fill('Smoked Old Fashioned');
  await item.locator('[data-edit-item] [name="price"]').fill('$10');
  await item.locator('[data-edit-item] [name="description"]').fill('Bourbon, smoke, bitters, and orange.');
  await item.locator('[data-edit-item] [data-item-photo]').selectOption('');
  await expect(item.locator('[data-edit-item] [data-item-gallery]')).not.toBeChecked();
  await item.getByRole('button', { name: 'Save item' }).click();

  await expect.poll(() => menuActions.length).toBe(2);
  expect(menuActions[1]).toMatchObject({
    action: 'update-item',
    itemId: '33333333-3333-4333-8333-333333333333',
    name: 'Smoked Old Fashioned',
    price: '$10',
    description: 'Bourbon, smoke, bitters, and orange.',
    photoId: null,
    showPhotoInGallery: false,
  });
});
