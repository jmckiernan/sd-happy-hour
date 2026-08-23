import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { listingFormHTML } from '../src/lib/listingForm.ts';
import {
  getVenueContent,
  OWNER_EDITABLE_FIELDS,
  validateOwnerPatch,
} from '../src/lib/venueContent.ts';

const ROOT = process.cwd();

function validOwnerListing(overrides = {}) {
  return {
    days: ['Monday', 'Friday'],
    startTime: '15:00',
    endTime: '18:00',
    deals: ['$8 cocktails'],
    dealTypes: ['cocktails'],
    features: ['patio'],
    vibe: 'Trendy gastropub',
    website: 'https://example.test',
    phone: '(619) 555-0100',
    address: '123 Test Street',
    image: '',
    ...overrides,
  };
}

function venuePhoto(id, imageKey, caption, photoType = 'menu_item') {
  return {
    id,
    venueId: 2,
    imageKey,
    caption,
    status: 'published',
    photoType,
    moderation: null,
    reviewNote: '',
    reviewedBy: '',
    reviewedAt: null,
    sortOrder: 0,
    uploadedBy: 'owner-1',
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  };
}

test('venue open and close times are an optional, validated pair', () => {
  const legacy = validateOwnerPatch(validOwnerListing());
  assert.deepEqual(legacy.errors, []);
  assert.equal(legacy.patch.openTime, '');
  assert.equal(legacy.patch.closeTime, '');
  assert.ok(OWNER_EDITABLE_FIELDS.includes('openTime'));
  assert.ok(OWNER_EDITABLE_FIELDS.includes('closeTime'));

  const complete = validateOwnerPatch(validOwnerListing({
    openTime: ' 11:00 ',
    closeTime: '23:30',
  }));
  assert.deepEqual(complete.errors, []);
  assert.equal(complete.patch.openTime, '11:00');
  assert.equal(complete.patch.closeTime, '23:30');

  const oneSided = validateOwnerPatch(validOwnerListing({ openTime: '11:00' }));
  assert.ok(oneSided.errors.includes('Add both venue open and close times, or leave both blank.'));

  const malformed = validateOwnerPatch(validOwnerListing({
    openTime: '9:00',
    closeTime: '25:00',
    startTime: '3:00',
    endTime: '18:75',
  }));
  assert.ok(malformed.errors.includes('Venue open time must use HH:MM 24-hour format.'));
  assert.ok(malformed.errors.includes('Venue close time must use HH:MM 24-hour format.'));
  assert.ok(malformed.errors.includes('Happy hour start time must use HH:MM 24-hour format.'));
  assert.ok(malformed.errors.includes('Happy hour end time must use HH:MM 24-hour format.'));
});

test('manager listing form distinguishes venue hours from happy-hour hours', () => {
  const html = listingFormHTML(validOwnerListing({
    openTime: '11:00',
    closeTime: '23:00',
  }), { ownerMode: true });

  assert.match(html, /<label>Open Time<\/label>\s*<input data-lf="openTime" type="time" value="11:00"/);
  assert.match(html, /<label>Close Time<\/label>\s*<input data-lf="closeTime" type="time" value="23:00"/);
  assert.match(html, /<label>Happy Hour Start Time<\/label>\s*<input data-lf="startTime" type="time" value="15:00"/);
  assert.match(html, /<label>Happy Hour End Time<\/label>\s*<input data-lf="endTime" type="time" value="18:00"/);
  assert.doesNotMatch(html, /<label>Start time<\/label>/);
  assert.doesNotMatch(html, /<label>End time<\/label>/);
});

test('featured picker displays the current admin image and offers no empty-image choice', () => {
  const adminImage = '/api/images/admin-featured-craft-commerce.png';
  const albumImage = '/api/images/owner-album-photo.png';
  const html = listingFormHTML(validOwnerListing({ image: adminImage }), {
    ownerMode: true,
    photoOptions: [{ id: 'album-1', url: albumImage, caption: 'Owner patio photo' }],
  });

  assert.match(html, /<input type="hidden" data-lf="image" value="\/api\/images\/admin-featured-craft-commerce\.png">/);
  assert.match(html, /class="lf-pick selected" data-lf-pick="\/api\/images\/admin-featured-craft-commerce\.png" title="Current featured image"/);
  assert.match(html, /<img src="\/api\/images\/admin-featured-craft-commerce\.png" alt="Current featured image"/);
  assert.match(html, /data-lf-pick="\/api\/images\/owner-album-photo\.png"/);
  assert.doesNotMatch(html, /No featured photo/i);
  assert.doesNotMatch(html, /lf-pick-none/);
});

test('featured picker represents the stock site image without turning it into an owner override', () => {
  const html = listingFormHTML(validOwnerListing(), { ownerMode: true, photoOptions: [] });

  assert.match(html, /<input type="hidden" data-lf="image" value="">/);
  assert.match(html, /class="lf-pick selected" data-lf-pick="" title="Current featured image"/);
  assert.match(html, /<img src="\/images\/vibes\/trendy-gastropub\.jpg" alt="Current featured image"/);
  assert.doesNotMatch(html, /No featured photo/i);
});

test('menu gallery migration and application plumbing preserve checked-by-default behavior', async () => {
  const [migration, store, menuRoute, managerPage] = await Promise.all([
    readFile(path.join(ROOT, 'migrations', '0008_menu_item_gallery_choice.sql'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'lib', 'store.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'api', 'restaurant', 'venues', '[id]', 'menu.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'restaurant', 'manage', '[slug].astro'), 'utf8'),
  ]);

  assert.match(migration, /ADD COLUMN\s+show_photo_in_gallery boolean NOT NULL DEFAULT true/i);
  assert.match(migration, /WHERE show_photo_in_gallery = true AND photo_id IS NOT NULL/i);

  assert.match(store, /showPhotoInGallery:\s*boolean;/);
  assert.match(store, /showPhotoInGallery:\s*row\.show_photo_in_gallery/);
  assert.match(store, /\$\{input\.showPhotoInGallery \?\? true\}/);
  assert.match(store, /show_photo_in_gallery = COALESCE\(\$\{input\.showPhotoInGallery \?\? null\}/);

  assert.match(menuRoute, /typeof body\.showPhotoInGallery !== 'boolean'/);
  assert.match(menuRoute, /showPhotoInGallery:\s*body\.showPhotoInGallery !== false/);
  assert.match(menuRoute, /showPhotoInGallery:\s*body\.showPhotoInGallery,/);

  assert.match(managerPage, /data-action="edit-item">Edit<\/button>/);
  assert.match(managerPage, /<input type="checkbox" data-item-gallery checked>/);
  assert.match(managerPage, /photoId:\s*selectedPhotoId \|\| \(isEdit \? null : ''\)/);
  assert.match(managerPage, /showPhotoInGallery:\s*\(form\.querySelector\('\[data-item-gallery\]'\)/);
  assert.match(managerPage, /<h2>Venue details<\/h2>/);
});

test('admin venue editor grants monthly promotion slots through an admin-only API', async () => {
  const [migration, allowanceRepo, allowanceRoute, promotionService, adminPage] = await Promise.all([
    readFile(path.join(ROOT, 'migrations', '0009_venue_promotion_allowances.sql'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'lib', 'promotionAllowanceRepo.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'api', 'admin', 'venues', '[id]', 'promotion-allowance.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'lib', 'promotionService.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'admin', 'venues', '[slug].astro'), 'utf8'),
  ]);

  assert.match(migration, /PRIMARY KEY \(venue_id, month_key\)/);
  assert.match(migration, /additional_allowance\s+integer NOT NULL DEFAULT 0/);
  assert.match(allowanceRepo, /additional_allowance = venue_promotion_allowances\.additional_allowance \+ 1/);
  assert.match(allowanceRepo, /additional_allowance = additional_allowance - 1/);
  assert.match(allowanceRoute, /getAdminUser\(cookies\)/);
  assert.match(allowanceRoute, /await lockPromotionVenue\(tx, auth\.venueId\)/);
  assert.match(promotionService, /getAdditionalPromotionAllowance\(venueId, targetMonth, tx\)/);
  assert.match(adminPage, /id="ve-promotion-used"/);
  assert.match(adminPage, /id="ve-promotion-remaining"/);
  assert.match(adminPage, /id="ve-promotion-add"/);
  assert.match(adminPage, /id="ve-promotion-remove"/);
});

test('restaurant managing users preserve one owner and separate full-admin from promotion access', async () => {
  const [migration, accessRepo, listingAuth, promotionAuth, managersRoute, dashboard, usersPage, ownerRoute] = await Promise.all([
    readFile(path.join(ROOT, 'migrations', '0011_venue_managing_users.sql'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'lib', 'venueUsers.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'lib', 'venueManager.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'lib', 'promotionAuthorization.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'api', 'restaurant', 'venues', '[id]', 'managers.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'restaurant.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'restaurant', 'manage', '[slug]', 'users.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'api', 'admin', 'venues', '[id]', 'owner.ts'), 'utf8'),
  ]);

  assert.match(migration, /role IN \('full_admin', 'promotions'\)/);
  assert.match(migration, /UNIQUE \(venue_id, user_id\)/);
  assert.match(migration, /venue_manager_invites_pending_unique/);
  assert.match(accessRepo, /WHERE lower\(email\) = \$\{normalized\} LIMIT 1/);
  assert.match(accessRepo, /normalized\.length < 3/);
  assert.match(accessRepo, /now\(\) \+ interval '7 days'/);
  assert.match(listingAuth, /access\?\.role === 'owner' \|\| access\?\.role === 'full_admin'/);
  assert.match(promotionAuth, /FROM venue_managers m JOIN venue_claims c/);
  assert.match(managersRoute, /Only the restaurant owner can manage users/);
  assert.match(dashboard, /Managing users →/);
  assert.match(usersPage, /No account yet — send a 7-day invitation/);
  assert.match(ownerRoute, /getAdminUser\(cookies\)/);
  assert.match(ownerRoute, /transferVenueOwner/);
});

test('public gallery includes opted-in menu photos once and leaves opted-out photos in the menu only', async () => {
  const venueGalleryPhoto = venuePhoto('venue-1', 'venue-patio.jpg', 'Patio', 'venue');
  const legacyOptedOutPhoto = venuePhoto('venue-2', 'legacy-menu-photo.jpg', 'Legacy dish', 'venue');
  const optedInPhoto = venuePhoto('menu-1', 'crispy-tacos.jpg', '');
  const optedOutPhoto = venuePhoto('menu-2', 'house-martini.jpg', 'House martini');

  globalThis.__venueManagementStoreFixture = {
    galleryPhotos: [venueGalleryPhoto, legacyOptedOutPhoto],
    allPhotos: [venueGalleryPhoto, legacyOptedOutPhoto, optedInPhoto, optedOutPhoto],
    menu: [
      {
        id: 'section-1',
        venueId: 2,
        title: 'Happy Hour Food',
        note: '',
        sortOrder: 0,
        items: [
          {
            id: 'item-1', sectionId: 'section-1', name: 'Crispy tacos', price: '$8',
            description: '', photoId: 'menu-1', showPhotoInGallery: true, sortOrder: 0,
          },
          {
            id: 'item-2', sectionId: 'section-1', name: 'Taco encore', price: '$8',
            description: '', photoId: 'menu-1', showPhotoInGallery: true, sortOrder: 1,
          },
          {
            id: 'item-3', sectionId: 'section-1', name: 'House martini', price: '$9',
            description: '', photoId: 'menu-2', showPhotoInGallery: false, sortOrder: 2,
          },
          {
            id: 'item-4', sectionId: 'section-1', name: 'Patio duplicate', price: '',
            description: '', photoId: 'venue-1', showPhotoInGallery: true, sortOrder: 3,
          },
          {
            id: 'item-5', sectionId: 'section-1', name: 'Unpublished photo', price: '',
            description: '', photoId: 'not-published', showPhotoInGallery: true, sortOrder: 4,
          },
          {
            id: 'item-6', sectionId: 'section-1', name: 'Legacy venue-typed dish photo', price: '',
            description: '', photoId: 'venue-2', showPhotoInGallery: false, sortOrder: 5,
          },
        ],
      },
    ],
  };

  try {
    const content = await getVenueContent(2);

    assert.deepEqual(content.photos, [
      { id: 'venue-1', url: '/api/images/venue-patio.jpg', caption: 'Patio' },
      { id: 'menu-1', url: '/api/images/crispy-tacos.jpg', caption: 'Crispy tacos' },
    ]);
    assert.equal(content.photos.filter((photo) => photo.id === 'menu-1').length, 1);

    const items = content.menu[0].items;
    assert.equal(items[0].photo?.url, '/api/images/crispy-tacos.jpg');
    assert.equal(items[1].photo?.url, '/api/images/crispy-tacos.jpg');
    assert.equal(items[2].photo?.url, '/api/images/house-martini.jpg');
    assert.equal(items[4].photo, null);
  } finally {
    delete globalThis.__venueManagementStoreFixture;
  }
});
