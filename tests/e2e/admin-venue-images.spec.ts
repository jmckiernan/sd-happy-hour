import { expect, test } from '@playwright/test';

const venue = {
  id: 2,
  name: 'Craft & Commerce',
  neighborhood: 'Little Italy',
  address: '675 W Beech St',
  lat: 32.7195,
  lng: -117.1711,
  days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  startTime: '16:00',
  endTime: '18:00',
  deals: ['$8 cocktails', '$5 draft beers'],
  vibe: 'Trendy gastropub',
  website: 'https://consortium-holdings.com/craft-commerce',
  phone: '(619) 269-2202',
  verified: false,
  lastVerifiedAt: null,
  sourceUrl: 'https://consortium-holdings.com/craft-commerce',
  dealTypes: ['cocktails', 'beer'],
  features: ['date night'],
  image: '/images/vibes/trendy-gastropub.jpg',
};

test('admin waits for the upload and saves a featured image with an immediate-live baseline', async ({ page }) => {
  const uploadedImage = '/api/images/craft-commerce-new-featured.jpg';
  let uploadStarted = false;
  let releaseUpload: (() => void) | undefined;
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  let savedPayload: any = null;

  await page.route('**/api/account/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }) })
  );
  await page.route('**/api/admin/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, user: { id: 'admin-1' } }),
    })
  );
  await page.route('**/api/admin/venues/2', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ venue, hasLiveOverride: true }),
      });
      return;
    }

    savedPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        venue: { ...venue, image: uploadedImage },
        liveNow: true,
        imageFallbackApplied: false,
      }),
    });
  });
  await page.route('**/api/admin/upload-image', async (route) => {
    uploadStarted = true;
    await uploadGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: uploadedImage }),
    });
  });

  try {
    await page.goto('/admin/venues/craft-commerce/');

    const save = page.getByRole('button', { name: 'Save changes' });
    await expect(save).toBeEnabled();
    await expect(page.locator('.ve-note')).toContainText('go live as soon as Save succeeds');

    await page.locator('[data-lf-image-file]').setInputFiles(
      `${process.cwd()}/public/images/vibes/trendy-gastropub.jpg`
    );
    await expect.poll(() => uploadStarted).toBe(true);
    await expect(save).toBeDisabled();
    await expect(page.locator('#ve-status')).toContainText('Waiting for the image upload');

    releaseUpload?.();
    await expect(page.locator('[data-lf="image"]')).toHaveValue(uploadedImage);
    await expect(save).toBeEnabled();

    await save.click();
    await expect.poll(() => savedPayload).not.toBeNull();
    expect(savedPayload.listing.image).toBe(uploadedImage);
    expect(savedPayload.baseline.image).toBe(venue.image);
    await expect(page.locator('#ve-status')).toContainText('live now');
    await expect(page.locator('#ve-status')).not.toContainText('live on the next deploy');
  } finally {
    releaseUpload?.();
  }
});
