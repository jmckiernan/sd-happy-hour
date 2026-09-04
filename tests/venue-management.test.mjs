import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { listingFormHTML } from '../src/lib/listingForm.ts';
import {
  getVenueContent,
  mergeVenue,
  OWNER_EDITABLE_FIELDS,
  validateOwnerPatch,
} from '../src/lib/venueContent.ts';
import { validateListing, validateSubmission, normalizeListingConsistency, cleanList } from '../src/lib/validation.ts';

const ROOT = process.cwd();

function validOwnerListing(overrides = {}) {
  return {
    days: ['Monday', 'Friday'],
    startTime: '15:00',
    endTime: '18:00',
    deals: ['$8 cocktails'],
    dealTypes: ['cocktails'],
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

/**
 * The regression that would silently reclose the claim flow.
 *
 * A window-only venue page invites whoever works there to add the happy hour
 * menu, and until this was fixed the save behind that invitation refused every
 * listing with no deals — so the only owners the panel spoke to were the only
 * owners who could not save. Requiring a deal again would restore that state
 * with no other visible symptom.
 */
test('an owner can save a window-only listing', () => {
  const windowOnly = validateOwnerPatch(validOwnerListing({ deals: [], dealTypes: [] }));
  assert.deepEqual(windowOnly.errors, []);
  assert.deepEqual(windowOnly.patch.deals, []);
  assert.deepEqual(windowOnly.patch.dealTypes, []);

  // A blank textarea reaches the validator as an empty string rather than an
  // empty array, which is the shape the dashboard actually submits.
  const blankTextarea = validateOwnerPatch(validOwnerListing({ deals: '', dealTypes: [] }));
  assert.deepEqual(blankTextarea.errors, []);

  // The window is still the minimum. A listing with neither times nor deals
  // describes nothing and is not worth publishing.
  const nothingAtAll = validateOwnerPatch(
    validOwnerListing({ deals: [], dealTypes: [], days: [], startTime: '', endTime: '' })
  );
  assert.ok(nothingAtAll.errors.includes('Choose at least one valid day.'));
  assert.ok(nothingAtAll.errors.includes('Happy hour start time must use HH:MM 24-hour format.'));

  // Deal types are read off deal text, so they cannot outlive it: a ticked
  // "beer" with no deals would put the venue in a filtered browse for an offer
  // nobody published.
  const typesWithoutDeals = validateOwnerPatch(validOwnerListing({ deals: [] }));
  assert.ok(typesWithoutDeals.errors.includes('Remove the deal types, or add the deals they describe.'));

  assert.ok(!JSON.stringify(validateOwnerPatch(validOwnerListing({ deals: [], dealTypes: [] })).errors)
    .includes('at least one deal'));
});

test('the admin and submission validators accept a window with no deals too', () => {
  const base = {
    name: 'Window Only Tavern',
    neighborhood: 'North Park',
    address: '123 Test Street',
    lat: 32.7157,
    lng: -117.1611,
    days: ['Monday'],
    startTime: '15:00',
    endTime: '18:00',
    vibe: 'Neighborhood bar',
    website: 'https://example.test',
    sourceUrl: 'https://example.test/happy-hour',
    deals: [],
    dealTypes: [],
  };

  const listing = validateListing(base);
  assert.deepEqual(listing.errors, []);
  // happy-hours.json requires empty deals to say so rather than sit silent —
  // scripts/validate-data.js rejects an empty deal list without this flag — so
  // the validator derives it instead of trusting the form to send it.
  assert.equal(listing.listing.dealsUnknown, true);
  assert.equal(validateListing({ ...base, deals: ['$5 tacos'], dealTypes: ['food'] }).listing.dealsUnknown, false);

  const submission = validateSubmission({
    ...base,
    contactName: 'Owner',
    contactEmail: 'owner@example.test',
    relationshipToVenue: '  Regular guest  ',
  });
  assert.deepEqual(submission.errors, []);
  assert.equal(submission.contact.relationshipToVenue, 'Regular guest');

  const updateWithoutRelationship = validateSubmission({
    ...base,
    contactName: 'Owner',
    contactEmail: 'owner@example.test',
  }, { requireRelationshipToVenue: true });
  assert.ok(updateWithoutRelationship.errors.includes('Tell us how you are connected to the venue.'));

  assert.ok(
    validateListing({ ...base, dealTypes: ['beer'] }).errors
      .includes('Remove the deal types, or add the deals they describe.')
  );
});

test('mergeVenue clears deal types when a listing has no deals', () => {
  const venue = {
    id: 246,
    name: 'Bullpen',
    neighborhood: 'Kearny Mesa',
    address: '8199 Clairemont Mesa Blvd',
    lat: 32.83,
    lng: -117.14,
    days: ['Monday'],
    startTime: '14:00',
    endTime: '17:00',
    deals: [],
    dealTypes: ['beer', 'cocktails', 'wine'],
    vibe: 'Bar and grill',
    website: 'http://www.bullpenbar.com/',
    sourceUrl: 'https://example.test',
  };

  assert.deepEqual(mergeVenue(venue, null).dealTypes, []);
});

test('admin venue save detects clearing inherited deal types', () => {
  const base = {
    name: 'Bullpen',
    neighborhood: 'Kearny Mesa',
    address: '8199 Clairemont Mesa Blvd',
    lat: 32.83,
    lng: -117.14,
    days: ['Monday'],
    startTime: '14:00',
    endTime: '17:00',
    deals: [],
    dealTypes: ['beer', 'cocktails', 'wine'],
    vibe: 'Bar and grill',
    website: 'http://www.bullpenbar.com/',
    sourceUrl: 'https://example.test',
  };

  const rawBaseline = { ...base };
  const normalizedBaseline = validateListing(normalizeListingConsistency(rawBaseline)).listing;
  const clearedListing = validateListing({ ...base, dealTypes: [] }).listing;
  const editorBaseline = {
    ...normalizedBaseline,
    deals: cleanList(rawBaseline.deals),
    dealTypes: cleanList(rawBaseline.dealTypes),
  };
  const listingRecord = clearedListing;
  const changedFields = Object.keys(listingRecord).filter(
    (field) => JSON.stringify(listingRecord[field]) !== JSON.stringify(editorBaseline[field])
  );

  assert.ok(changedFields.includes('dealTypes'));

  const repositoryInput = { ...rawBaseline };
  for (const field of changedFields) repositoryInput[field] = listingRecord[field];
  const saved = validateListing(normalizeListingConsistency(repositoryInput), { requireCoordinates: true });
  assert.deepEqual(saved.errors, []);
  assert.deepEqual(saved.listing.dealTypes, []);
});

test('every form on the claim path presents deals as optional', async () => {
  const [submitPage, form] = await Promise.all([
    readFile(path.join(ROOT, 'src', 'pages', 'submit.astro'), 'utf8'),
    Promise.resolve(listingFormHTML(validOwnerListing(), { ownerMode: true })),
  ]);

  // A form that lets an owner submit and then fails server-side is no better
  // than one that refuses up front, and a required marker is a refusal.
  assert.match(submitPage, /<label for="submit-deals">Deals \(one per line, optional\)<\/label>/);
  assert.doesNotMatch(submitPage, /id="submit-deals"[^>]*required/);
  assert.match(form, /<label>Deals \(one per line, optional\)<\/label>/);
  assert.doesNotMatch(form, /data-lf="deals"[^>]*required/);
});

test('card corrections target an existing venue but remain admin-gated', async () => {
  const [homePage, submitPage, submitRoute, store, reviewRoute, adminPage, relationshipMigration] = await Promise.all([
    readFile(path.join(ROOT, 'src', 'pages', 'index.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'submit.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'api', 'submissions.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'lib', 'store.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'api', 'admin', 'submissions', '[id].ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'admin.astro'), 'utf8'),
    readFile(path.join(ROOT, 'migrations', '0019_submission_contact_relationship.sql'), 'utf8'),
  ]);

  assert.match(homePage, /href="\/submit\/\?venue=\$\{encodeURIComponent\(String\(h\.id\)\)\}">Report update<\/a>/);
  assert.match(submitPage, /name="existingVenueId" type="hidden"/);
  assert.match(submitPage, /fetch\('\/data\/happy-hours\.json'\)/);
  assert.match(submitPage, /Suggest an update to \$\{venue\.name\}/);
  assert.match(submitPage, /Nothing on its public page changes unless an admin reviews and approves this update\./);
  assert.match(submitPage, /<label for="contact-relationship">Your relationship to the venue<\/label>/);
  assert.match(submitPage, /id="contact-relationship"\s+name="relationshipToVenue"/);
  assert.match(submitPage, /relationshipToVenue:\s*formData\.get\('relationshipToVenue'\)/);
  assert.match(submitPage, /document\.getElementById\('relationship-field'\)!\.hidden = false/);
  assert.match(submitPage, /relationshipInput\.disabled = false;\s*relationshipInput\.required = true/);

  assert.match(submitRoute, /getVenueById\(parsedId\)/);
  assert.match(submitRoute, /relationshipToVenue:\s*body\.relationshipToVenue/);
  assert.match(submitRoute, /requireRelationshipToVenue:\s*targetVenueId !== undefined/);
  assert.match(submitRoute, /createSubmission\(\{ contact, listing, approvedListingId: targetVenueId \}\)/);
  assert.match(store, /relationshipToVenue:\s*row\.contact_relationship \?\? ''/);
  assert.match(store, /INSERT INTO submissions \(contact_name, contact_email, contact_relationship, contact_notes, listing, approved_listing_id, submission_kind\)/);
  assert.match(reviewRoute, /submissionKind: 'update'/);
  assert.match(reviewRoute, /submissionKind: 'new'/);
  assert.match(relationshipMigration, /ADD COLUMN contact_relationship text NOT NULL DEFAULT ''/);

  // Merely saving the queued proposal cannot touch a live venue. Only an
  // approval (or a later edit of an already-approved record) reaches it.
  assert.match(reviewRoute, /const publishedId = submission\.status === 'approved'/);
  assert.match(reviewRoute, /if \(action === 'approve'\) \{[\s\S]*if \(submission\.approvedListingId\) \{[\s\S]*await updateVenue\(submission\.approvedListingId, approvedListing\)/);
  assert.match(adminPage, /Approve venue update/);
  assert.match(adminPage, /proposed update to venue #/);
  assert.match(adminPage, /data-filter="new"[^>]*>New venues/);
  assert.match(adminPage, /data-filter="updates"[^>]*>Venue updates/);
  assert.match(adminPage, /consolidateApproved/);
  assert.match(adminPage, /submissionKind === 'new'/);
  assert.match(adminPage, /submissionKind === 'update'/);
  assert.match(adminPage, /item\.contact\.relationshipToVenue[\s\S]{0,160}<strong>Relationship to venue:<\/strong> \$\{escapeHTML\(item\.contact\.relationshipToVenue\)\}/);
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

test('venue page keeps one default-list quick-save action without a list picker', async () => {
  // [slug].astro is now just a router between the full listing and the claim
  // stub; the save action lives in the listing component.
  const venuePage = await readFile(path.join(ROOT, 'src', 'components', 'VenueHappyHourPage.astro'), 'utf8');

  assert.match(venuePage, /\.venue-actions\s*\{[^}]*display:\s*flex;/s);
  assert.match(venuePage, /<div class="venue-topbar">[\s\S]*?class="back-link"[\s\S]*?class="btn-admin-edit"[\s\S]*?<\/div>/);
  assert.match(venuePage, /<div class="venue-actions">[\s\S]*?id="venue-website"[\s\S]*?id="venue-call"[\s\S]*?id="save-btn"[\s\S]*?<\/div>/);
  assert.match(venuePage, /savedState\.defaultListId/);
  assert.match(venuePage, /membership\.listId === defaultList\.id/);
  assert.match(venuePage, /method:\s*removing \? 'DELETE' : 'POST'/);
  assert.match(venuePage, /aria-pressed="false"/);
  assert.doesNotMatch(venuePage, /venue-list-picker|venue-list-memberships|Add or remove a list/);
});

test('venue page exposes verification, report, measured WebP menus, and a custom share surface', async () => {
  const venuePage = await readFile(path.join(ROOT, 'src', 'components', 'VenueHappyHourPage.astro'), 'utf8');

  assert.match(venuePage, /venueVerificationType\(venue\)/);
  assert.match(venuePage, /✓ Web verified/);
  assert.match(venuePage, /✓ Owner verified/);
  assert.doesNotMatch(venuePage, /hero-verification-badge/);
  assert.match(venuePage, /href=\{`\/submit\/\?venue=\$\{venue\.id\}`\}>Report an update<\/a>/);
  assert.doesNotMatch(venuePage, /menu-board-tile--stylized|has-stylized-webp-menu/);

  assert.match(venuePage, /id="share-menu" role="dialog"/);
  assert.match(venuePage, /id="share-menu-title">Share this happy hour<\/strong>/);
  assert.match(venuePage, /\.hero-share\s*\{[^}]*linear-gradient\(135deg, rgba\(16, 42, 86, \.52\)[^}]*rgba\(107, 33, 168, \.52\)/s);
  assert.match(venuePage, /\.hero-share:hover,[\s\S]*?linear-gradient\(135deg, rgba\(234, 88, 12, \.68\)[\s\S]*?rgba\(250, 204, 21, \.68\)/);
  assert.match(venuePage, /aria-haspopup', 'dialog'/);
  assert.match(venuePage, /data-share-action="copy"/);
  assert.match(venuePage, /navigator\.clipboard\.writeText\(shareUrl\(\)\)/);
  assert.match(venuePage, /if \(event\.key === 'Escape' && !shareMenu\.hidden\)/);
  assert.doesNotMatch(venuePage, /navigator\.share/);
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

  assert.match(managerPage, /data-action="edit-section">Edit<\/button>/);
  assert.match(managerPage, /data-action="edit-item">Edit<\/button>/);
  assert.match(managerPage, /action: 'update-section'/);
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
