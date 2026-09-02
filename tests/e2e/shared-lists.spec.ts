import { expect, test, type Page, type Route } from '@playwright/test';

const venues = [
  {
    id: 1,
    name: 'Sunset Patio',
    neighborhood: 'North Park',
    deals: ['$8 spritzes'],
    days: ['Friday'],
    startTime: '16:00',
    endTime: '18:00',
  },
  {
    id: 2,
    name: 'Harbor Bar',
    neighborhood: 'Little Italy',
    deals: ['$6 drafts'],
    days: ['Friday'],
    startTime: '15:00',
    endTime: '18:00',
  },
];

async function fulfill(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockSharedListBasics(page: Page) {
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('**/data/happy-hours.json', (route) => fulfill(route, venues));
  await page.route('**/api/config', (route) => fulfill(route, { googleClientId: '' }));
  await page.route('**/api/admin/me', (route) => fulfill(route, { authenticated: false }));
  await page.route('**/api/restaurant/claims', (route) => fulfill(route, { authenticated: true, claims: [] }));
}

test('account and admin navigation stay in sync when authentication changes', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await mockSharedListBasics(page);
  await page.route('**/api/account/me', (route) => fulfill(route, {
    authenticated: false,
    user: null,
    isAdmin: false,
  }));

  await page.goto('/account/');
  await expect.poll(() => pageErrors).toEqual([]);
  await expect(page.locator('#account-nav-link')).toHaveText('Sign In');
  await expect(page.locator('#admin-nav-link')).toBeHidden();

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('sdhh:auth-changed', {
    detail: { authenticated: true, isAdmin: true },
  })));
  await expect(page.locator('#account-nav-link')).toHaveText('My Stuff');
  await expect(page.locator('#admin-nav-link')).toBeVisible();
  await expect(page.locator('#blog-admin-nav-link')).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('sdhh:auth-changed', {
    detail: { authenticated: false, isAdmin: false },
  })));
  await expect(page.locator('#account-nav-link')).toHaveText('Sign In');
  await expect(page.locator('#admin-nav-link')).toBeHidden();
});

test('account discovers owned/shared lists and creates a new custom list', async ({ page }) => {
  await mockSharedListBasics(page);
  let createdBody: Record<string, unknown> | null = null;
  await page.route('**/api/account/me', (route) => fulfill(route, {
    authenticated: true,
    user: {
      id: 'owner', name: 'Alex', email: 'alex@example.com', shareId: 'legacy-share',
      savedSpots: [], alerts: [], phone: '', smsOptedIn: false,
      weeklyDigestOptIn: false, hasPassword: true,
      saved: {
        defaultListId: 'favorites',
        lists: [
          { id: 'favorites', title: 'Favorites', systemKey: 'favorites', role: 'owner', canEdit: true, ratingsEnabled: true, commentsEnabled: true },
          { id: 'want-to-try', title: 'Want to Try', systemKey: 'want_to_try', role: 'owner', canEdit: true, ratingsEnabled: false, commentsEnabled: true },
          { id: 'been-to', title: 'Been To', systemKey: 'been_to', role: 'owner', canEdit: true, ratingsEnabled: true, commentsEnabled: true },
          { id: 'list-1', title: 'Friday Crew', systemKey: null, role: 'owner', canEdit: true, ratingsEnabled: true, commentsEnabled: true },
        ],
        venues: [{
          venueId: 1,
          myFeedback: { rating: 4, comment: 'Great patio' },
          lists: [
            { listId: 'favorites', title: 'Favorites', role: 'owner', canEdit: true, ratingsEnabled: true, commentsEnabled: true, myFeedback: { rating: 4, comment: 'Great patio' }, myNote: '', feedback: [] },
            { listId: 'list-1', title: 'Friday Crew', role: 'owner', canEdit: true, ratingsEnabled: true, commentsEnabled: true, myFeedback: { rating: 4, comment: 'Great patio' }, myNote: '', feedback: [] },
            { listId: 'want-to-try', title: 'Want to Try', systemKey: 'want_to_try', role: 'owner', canEdit: true, ratingsEnabled: false, commentsEnabled: true, myFeedback: { rating: 4, comment: 'Great patio' }, myNote: '', feedback: [] },
          ],
        }],
      },
    },
  }));
  await page.route('**/api/account/lists', async (route) => {
    if (route.request().method() === 'POST') {
      createdBody = route.request().postDataJSON();
      await fulfill(route, { list: { id: 'new-list', ...createdBody } }, 201);
      return;
    }
    await fulfill(route, {
      lists: [{
        id: 'list-1', title: 'Friday Crew', description: 'Cocktails after work',
        ownerName: 'Alex', role: 'owner', itemCount: 2, memberCount: 1,
        canEdit: true, ratingsEnabled: true, commentsEnabled: true,
      }, {
        id: 'favorites', title: 'Favorites', description: '', systemKey: 'favorites',
        ownerName: 'Alex', role: 'owner', itemCount: 1, memberCount: 1,
        canEdit: true, ratingsEnabled: true, commentsEnabled: true, isDefault: true,
      }, {
        id: 'want-to-try', title: 'Want to Try', description: '', systemKey: 'want_to_try',
        ownerName: 'Alex', role: 'owner', itemCount: 0, memberCount: 1,
        canEdit: true, ratingsEnabled: false, commentsEnabled: true,
      }, {
        id: 'been-to', title: 'Been To', description: '', systemKey: 'been_to',
        ownerName: 'Alex', role: 'owner', itemCount: 0, memberCount: 1,
        canEdit: true, ratingsEnabled: true, commentsEnabled: true,
      }],
      pendingInvites: [{
        id: 'invite-2', listId: 'list-2', title: 'Birthday Crawl',
        ownerName: 'Jamie', role: 'editor',
      }],
    });
  });
  await page.route('**/api/lists/new-list**', (route) => fulfill(route, { errors: ['fixture navigation complete'] }, 404));

  await page.goto('/account/');
  await expect(page.getByRole('heading', { name: 'Your lists' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Friday Crew' })).toBeVisible();
  await expect(page.getByText('Birthday Crawl')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All Saved Spots' })).toBeVisible();
  const sunsetCard = page.locator('.saved-card').filter({ hasText: 'Sunset Patio' });
  await expect(sunsetCard.locator('.list-chip')).toHaveText([/Favorites/, /Friday Crew/, /Want to Try/]);
  await expect(page.getByLabel('Default quick-save list')).toHaveValue('favorites');
  await expect(sunsetCard.getByLabel('Add to another list')).toContainText('Been To · moves from Want to Try');
  await expect(sunsetCard.getByRole('group', { name: 'Your rating' }).locator('.filled')).toHaveCount(4);

  const createForm = page.locator('#create-list-form');
  await createForm.getByLabel('List title', { exact: true }).fill('Beach Day');
  await createForm.getByLabel('Description (optional)', { exact: true }).fill('Ocean-view happy hours');
  await createForm.getByRole('button', { name: 'Create list' }).click();
  await expect.poll(() => createdBody).toEqual({
    title: 'Beach Day',
    description: 'Ocean-view happy hours',
    commentsEnabled: false,
  });
  await expect(page).toHaveURL(/\/lists\/new-list\//);
});

test('adding a fourth list is additive and removing the third targets only that membership', async ({ page }) => {
  await mockSharedListBasics(page);
  const allLists = [
    { id: 'list-one', title: 'List One' },
    { id: 'list-two', title: 'List Two' },
    { id: 'list-three', title: 'List Three' },
    { id: 'list-four', title: 'List Four' },
  ];
  const memberships = [
    { listId: 'list-one', title: 'List One', role: 'owner', canEdit: true, ratingsEnabled: false, commentsEnabled: false, myFeedback: null, myNote: '', feedback: [] },
    { listId: 'list-two', title: 'List Two', role: 'owner', canEdit: true, ratingsEnabled: false, commentsEnabled: false, myFeedback: null, myNote: '', feedback: [] },
    { listId: 'list-three', title: 'List Three', role: 'owner', canEdit: true, ratingsEnabled: false, commentsEnabled: false, myFeedback: null, myNote: '', feedback: [] },
  ];
  const otherMemberships = [
    { listId: 'list-one', title: 'List One', role: 'owner', canEdit: true, ratingsEnabled: false, commentsEnabled: false, myFeedback: null, myNote: '', feedback: [] },
  ];
  let venueOrder = [2, 1];
  const addedPaths: string[] = [];
  const deletedPaths: string[] = [];
  let releaseAdd!: () => void;
  const addGate = new Promise<void>((resolve) => { releaseAdd = resolve; });

  await page.route('**/api/account/me', (route) => fulfill(route, {
    authenticated: true,
    user: {
      id: 'owner', name: 'Alex', email: 'alex@example.com', shareId: 'legacy-share',
      savedSpots: [], alerts: [], phone: '', smsOptedIn: false,
      weeklyDigestOptIn: false, hasPassword: true,
      saved: {
        defaultListId: 'list-one',
        lists: allLists.map((list, index) => ({
          id: list.id,
          title: list.title,
          description: '',
          systemKey: null,
          role: 'owner',
          canEdit: true,
          ratingsEnabled: false,
          commentsEnabled: false,
          isDefault: index === 0,
        })),
        venues: venueOrder.map((venueId) => ({
          venueId,
          myFeedback: null,
          lists: venueId === 1 ? memberships : otherMemberships,
        })),
      },
    },
  }));
  await page.route('**/api/account/lists', (route) => fulfill(route, {
    lists: allLists.map((list, index) => ({
      id: list.id,
      title: list.title,
      description: '',
      ownerName: 'Alex',
      role: 'owner',
      canEdit: true,
      itemCount: 1,
      memberCount: 0,
      ratingsEnabled: false,
      commentsEnabled: false,
      isDefault: index === 0,
    })),
    pendingInvites: [],
  }));
  await page.route('**/api/lists/*/items/1', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const listId = pathname.split('/')[3];
    if (route.request().method() === 'PUT') {
      addedPaths.push(pathname);
      await addGate;
      const list = allLists.find((candidate) => candidate.id === listId)!;
      memberships.push({
        listId: list.id, title: list.title, role: 'owner', canEdit: true,
        ratingsEnabled: false, commentsEnabled: false, myFeedback: null, myNote: '', feedback: [],
      });
      // Simulate the server returning this changed venue at a different grid
      // position; the UI should compensate so the user's viewport stays put.
      venueOrder = [1, 2];
      await fulfill(route, { status: 'added', venueId: 1 });
      return;
    }
    if (route.request().method() === 'DELETE') {
      deletedPaths.push(pathname);
      const index = memberships.findIndex((membership) => membership.listId === listId);
      if (index >= 0) memberships.splice(index, 1);
      await fulfill(route, { status: 'removed', venueId: 1 });
      return;
    }
    await route.fallback();
  });

  await page.goto('/account/');
  const card = page.locator('.saved-card').filter({ hasText: 'Sunset Patio' });
  await card.evaluate((element) => {
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 180);
  });
  const beforeTop = await card.evaluate((element) => element.getBoundingClientRect().top);
  await expect(card.locator('.list-chip')).toHaveText([/List One/, /List Two/, /List Three/]);

  const addPicker = card.getByLabel('Add to another list');
  await addPicker.selectOption('list-four');
  await expect.poll(() => addedPaths).toEqual(['/api/lists/list-four/items/1']);
  await expect(addPicker).toBeDisabled();
  await expect(card.getByRole('status')).toHaveText(/Adding to List Four/);
  releaseAdd();
  await expect(deletedPaths).toEqual([]);
  await expect(card.getByRole('button', { name: 'Remove Sunset Patio from List One' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Remove Sunset Patio from List Two' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Remove Sunset Patio from List Three' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Remove Sunset Patio from List Four' })).toBeVisible();
  await expect(card.getByRole('status')).toHaveText(/Added to List Four/);
  const afterTop = await card.evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(afterTop - beforeTop)).toBeLessThan(2);

  await card.getByRole('button', { name: 'Remove Sunset Patio from List Three' }).click();

  await expect.poll(() => deletedPaths).toEqual(['/api/lists/list-three/items/1']);
  await expect(card.getByRole('button', { name: 'Remove Sunset Patio from List One' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Remove Sunset Patio from List Two' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Remove Sunset Patio from List Four' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Remove Sunset Patio from List Three' })).toHaveCount(0);
  await expect(card.getByRole('status')).toHaveText(/Removed from List Three/);
});

test('editor mutates the canonical list while a link-only visitor stays read-only', async ({ page }) => {
  await mockSharedListBasics(page);
  let editor = true;
  const mutations: Array<{ method: string; venueId: number }> = [];

  await page.route('**/api/lists/list-1**', async (route) => {
    const url = new URL(route.request().url());
    const itemMatch = url.pathname.match(/\/items\/(\d+)$/);
    if (itemMatch) {
      mutations.push({ method: route.request().method(), venueId: Number(itemMatch[1]) });
      await fulfill(route, { status: route.request().method() === 'DELETE' ? 'removed' : 'added' });
      return;
    }
    if (url.pathname.endsWith('/shares')) {
      await fulfill(route, { access: [] });
      return;
    }
    await fulfill(route, {
      authenticated: editor,
      list: {
        id: 'list-1', title: 'Friday Crew', description: 'One shared plan',
        ownerName: 'Alex', role: editor ? 'editor' : 'viewer',
        access: { role: editor ? 'editor' : 'viewer', isMember: editor },
        canEdit: editor, canManageSharing: false,
        ratingsEnabled: true, commentsEnabled: true,
        inviteId: editor ? null : 'invite-view', updatedAt: `version-${mutations.length}`,
        items: [{ venueId: 1, venue: { ...venues[0], slug: 'sunset-patio' }, feedback: [], myFeedback: null, notes: [], myNote: '' }],
      },
    });
  });

  await page.goto('/lists/list-1/');
  await expect(page.locator('#role-pill')).toHaveText('Can edit');
  const commentField = page.getByLabel('Public comment');
  await expect(commentField).toBeVisible();
  expect(await commentField.evaluate((element) => getComputedStyle(element).paddingLeft)).toBe('11px');
  await expect(page.getByLabel('Note for this list')).toBeVisible();
  await expect(page.getByPlaceholder('What did you think of this place?')).toBeVisible();
  await expect(page.getByPlaceholder(/Only on this list/)).toBeVisible();
  const venueSearch = page.getByLabel('Search venues');
  await venueSearch.fill('harb');
  const harborResult = page.getByRole('option', { name: 'Harbor Bar · Little Italy' });
  await expect(harborResult).toBeVisible();
  const searchBox = await venueSearch.boundingBox();
  const resultsBox = await page.locator('#venue-search-results').boundingBox();
  expect(Math.abs((resultsBox?.x || 0) - (searchBox?.x || 0))).toBeLessThan(2);
  expect(Math.abs((resultsBox?.width || 0) - (searchBox?.width || 0))).toBeLessThan(2);
  expect(resultsBox?.y).toBeGreaterThanOrEqual((searchBox?.y || 0) + (searchBox?.height || 0));
  await harborResult.click();
  await expect(venueSearch).toHaveValue('Harbor Bar · Little Italy');
  await expect(page.locator('#venue-search-results')).toBeHidden();
  await page.getByRole('button', { name: 'Add to list' }).click();
  await expect.poll(() => mutations).toContainEqual({ method: 'PUT', venueId: 2 });
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => mutations).toContainEqual({ method: 'DELETE', venueId: 1 });

  editor = false;
  await page.goto('/lists/list-1/?invite=viewer-link');
  await expect(page.locator('#role-pill')).toHaveText('View only');
  await expect(page.getByRole('button', { name: 'Add to list' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await expect(page.getByText(/invited to view this live list/i)).toBeVisible();
});

test('owner shares in a modal, can recover link URLs, and settings auto-save', async ({ page }) => {
  await mockSharedListBasics(page);
  let title = 'Friday Crew';
  let description = 'One shared plan';
  let version = 1;
  let subscription: Record<string, boolean> | null = null;
  const detailUpdates: Record<string, unknown>[] = [];
  const subscriptionUpdates: Record<string, unknown>[] = [];
  const persistentLink = 'http://127.0.0.1:4321/lists/list-1/?invite=72af67fb-78d0-4fad-8939-69af156a10dc';

  await page.route('**/api/lists/list-1**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith('/shares')) {
      await fulfill(route, {
        access: [{
          id: 'owner', kind: 'owner', name: 'Alex', email: 'alex@example.com',
          role: 'owner', expiresAt: null, isLinkInvite: false, inviteUrl: null,
        }, {
          id: '72af67fb-78d0-4fad-8939-69af156a10dc', kind: 'invite', name: '',
          email: 'Anyone with the link', role: 'viewer', expiresAt: '2026-09-22T00:00:00.000Z',
          isLinkInvite: true, inviteUrl: persistentLink,
        }],
      });
      return;
    }
    if (url.pathname.endsWith('/subscription')) {
      if (method === 'DELETE') {
        subscription = null;
      } else {
        subscription = route.request().postDataJSON();
        subscriptionUpdates.push(subscription!);
      }
      version += 1;
      await fulfill(route, { subscription });
      return;
    }
    if (url.pathname.endsWith('/activity')) {
      await fulfill(route, { recorded: true });
      return;
    }
    if (url.pathname === '/api/lists/list-1' && method === 'PUT') {
      const body = route.request().postDataJSON();
      detailUpdates.push(body);
      title = body.title ?? title;
      description = body.description ?? description;
      version += 1;
      await fulfill(route, { list: { title, description, ...body, updatedAt: `version-${version}` } });
      return;
    }
    await fulfill(route, {
      authenticated: true,
      list: {
        id: 'list-1', title, description, ownerName: 'Alex', role: 'owner', systemKey: null,
        ratingsEnabled: false, commentsEnabled: false, subscription,
        access: { role: 'owner', isMember: true }, canEdit: true, canManageSharing: true,
        inviteId: null, updatedAt: `version-${version}`,
        items: [{ venueId: 1, venue: { ...venues[0], slug: 'sunset-patio' }, feedback: [], myFeedback: null, notes: [], myNote: '' }],
      },
    });
  });

  await page.goto('/lists/list-1/');
  await expect(page.getByRole('button', { name: 'Save list details' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save my alerts' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Share' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share this list' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Reusable share link')).toHaveValue(persistentLink);
  const sendInviteBox = await dialog.getByRole('button', { name: 'Send invite' }).boundingBox();
  const copyLinkBox = await dialog.getByRole('button', { name: 'Copy share link' }).boundingBox();
  expect(sendInviteBox?.height).toBeLessThan(45);
  expect(copyLinkBox?.height).toBeLessThan(45);
  expect(copyLinkBox?.width).toBeLessThan(220);
  await dialog.getByRole('button', { name: 'Close sharing' }).click();
  await expect(dialog).not.toBeVisible();

  await page.getByLabel('List title').fill('Saturday Crew');
  await expect.poll(() => detailUpdates.at(-1)?.title).toBe('Saturday Crew');
  await expect(page.locator('#details-status')).toHaveText('Saved automatically.');

  await page.getByLabel('Happy-hour alerts').check();
  await expect.poll(() => subscriptionUpdates.at(-1)).toEqual({
    happyHour: true,
    liveDeals: false,
    email: true,
    text: false,
  });
  await expect(page.getByRole('checkbox', { name: 'Email' })).toBeChecked();
  await expect(page.locator('#list-alerts-status')).toHaveText('Alert settings saved automatically.');
});

test('venue quick-save button toggles only the configured default list', async ({ page }) => {
  await mockSharedListBasics(page);
  let savedToDefault = true;
  const methods: string[] = [];
  const savedState = () => ({
    defaultListId: 'favorites',
    lists: [{ id: 'favorites', title: 'Favorites', canEdit: true }],
    venues: savedToDefault
      ? [{ venueId: 1, lists: [{ listId: 'favorites', title: 'Favorites' }] }]
      : [],
  });

  await page.route('**/api/account/me', (route) => fulfill(route, {
    authenticated: true,
    user: { id: 'owner', name: 'Alex', email: 'alex@example.com', saved: savedState() },
  }));
  await page.route('**/api/account/saved-venues/1', async (route) => {
    methods.push(route.request().method());
    savedToDefault = route.request().method() === 'POST';
    await fulfill(route, { listId: 'favorites', status: savedToDefault ? 'added' : 'removed', saved: savedState() });
  });

  await page.goto('/venues/ironside-fish-oyster/');
  const saveButton = page.locator('#save-btn');
  await expect(saveButton).toHaveText('Saved');
  await expect(saveButton).toHaveAttribute('aria-label', 'Remove from Favorites');
  await expect(page.locator('#save-list-info-text')).toHaveText(
    'Saved in Favorites, your default list. Select Saved to remove it.',
  );
  await expect(page.getByRole('link', { name: 'Change your default list in My Stuff' }))
    .toHaveAttribute('href', '/account/#section-lists');
  await expect(saveButton).toHaveClass(/saved/);
  await expect(saveButton).toHaveAttribute('aria-pressed', 'true');

  await saveButton.click();
  await expect.poll(() => methods).toEqual(['DELETE']);
  await expect(saveButton).toHaveText('Save');
  await expect(saveButton).toHaveAttribute('aria-label', 'Save to Favorites');
  await expect(page.locator('#save-list-info-text')).toHaveText(
    'This will save to Favorites, your default list.',
  );
  await expect(saveButton).not.toHaveClass(/saved/);
  await expect(saveButton).toHaveAttribute('aria-pressed', 'false');

  await saveButton.click();
  await expect.poll(() => methods).toEqual(['DELETE', 'POST']);
  await expect(saveButton).toHaveText('Saved');
  await expect(saveButton).toHaveClass(/saved/);
});

test('home card saves to the default or selected list from one compact row', async ({ page }) => {
  await mockSharedListBasics(page);
  await page.route('**/data/happy-hours.json', (route) => fulfill(route, venues.map((venue) => ({
    ...venue,
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  }))));
  const longListTitle = 'List Number 3 — an intentionally long name that must stay on one row';
  const lists = [
    { id: 'favorites', title: 'Favorites', systemKey: 'favorites', canEdit: true },
    { id: 'list-three', title: longListTitle, systemKey: null, canEdit: true },
  ];
  const savedListIds = new Set<string>();
  const mutations: string[] = [];

  await page.route('**/api/account/me', (route) => fulfill(route, {
    authenticated: true,
    user: {
      id: 'owner', name: 'Alex', email: 'alex@example.com',
      saved: {
        defaultListId: 'list-three',
        lists,
        venues: savedListIds.size
          ? [{
              venueId: 1,
              lists: [...savedListIds].map((listId) => ({
                listId,
                title: lists.find((list) => list.id === listId)?.title,
                role: 'owner',
                canEdit: true,
              })),
            }]
          : [],
      },
    },
  }));
  await page.route('**/api/lists/*/items/1', async (route) => {
    mutations.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    const listId = new URL(route.request().url()).pathname.split('/')[3];
    if (route.request().method() === 'DELETE') savedListIds.delete(listId);
    else savedListIds.add(listId);
    await fulfill(route, { status: route.request().method() === 'DELETE' ? 'removed' : 'added', listId, venueId: 1 });
  });

  await page.goto('/');
  const card = page.locator('[data-venue-card="1"]');
  const picker = card.getByLabel('Choose a list for Sunset Patio');
  const saveButton = card.getByRole('button', { name: 'Save', exact: true });

  await expect(card.getByText('Save to List Number 3', { exact: true })).toHaveCount(0);
  await expect(picker).toHaveAttribute('data-save-list-value', 'list-three');
  await expect(picker).toContainText(longListTitle);
  const rowAlignment = await card.locator('.save-panel-row').evaluate((row) => {
    const pickerBox = row.querySelector('.save-list-trigger')!.getBoundingClientRect();
    const saveBox = row.querySelector('[data-save-spot]')!.getBoundingClientRect();
    return Math.abs(pickerBox.y - saveBox.y);
  });
  expect(rowAlignment).toBeLessThan(3);

  await picker.click();
  const listbox = card.getByRole('listbox', { name: 'Lists for Sunset Patio' });
  await expect(listbox).toBeVisible();
  const menuAlignment = await card.locator('.save-list-combobox').evaluate((combobox) => {
    const triggerBox = combobox.querySelector('.save-list-trigger')!.getBoundingClientRect();
    const menuBox = combobox.querySelector('.save-list-options')!.getBoundingClientRect();
    return {
      xDifference: Math.abs(triggerBox.x - menuBox.x),
      widthDifference: Math.abs(triggerBox.width - menuBox.width),
    };
  });
  expect(menuAlignment.xDifference).toBeLessThan(3);
  expect(menuAlignment.widthDifference).toBeLessThan(3);
  await listbox.getByRole('option', { name: 'Favorites' }).click();
  await expect(picker).toHaveAttribute('data-save-list-value', 'favorites');
  await saveButton.click();
  await expect.poll(() => mutations).toEqual(['PUT /api/lists/favorites/items/1']);
  await expect(card.locator('.save-list-chip')).toHaveText('Favorites');

  await expect(card.locator('select[data-list-picker]')).toHaveCount(0);
  const managePicker = card.getByRole('button', { name: 'Manage lists for Sunset Patio' });
  await managePicker.click();
  const manageListbox = card.getByRole('listbox', { name: 'Manage lists for Sunset Patio' });
  await expect(manageListbox).toBeVisible();
  await expect(manageListbox.getByRole('option', { name: 'Favorites' })).toHaveAttribute('aria-selected', 'true');
  await manageListbox.getByRole('option', { name: longListTitle }).click();
  await expect.poll(() => mutations).toEqual([
    'PUT /api/lists/favorites/items/1',
    'PUT /api/lists/list-three/items/1',
  ]);
  await expect(card.locator('.save-list-chip')).toHaveText(['Favorites', longListTitle]);
  await expect(card.locator('.save-list-chip').last()).toHaveAttribute('title', longListTitle);
  const chipOverflow = await card.locator('.save-list-chips').evaluate((container) => {
    const chips = [...container.querySelectorAll<HTMLElement>('.save-list-chip')];
    const longChip = chips.at(-1)!;
    const style = getComputedStyle(longChip);
    return {
      priorChips: chips.slice(0, -1).map((chip) => ({
        isTruncated: chip.scrollWidth > chip.clientWidth,
        flexShrink: getComputedStyle(chip).flexShrink,
      })),
      whiteSpace: style.whiteSpace,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      isTruncated: longChip.scrollWidth > longChip.clientWidth,
      rows: Math.round(container.getBoundingClientRect().height / Math.max(...chips.map((chip) => chip.getBoundingClientRect().height))),
    };
  });
  expect(chipOverflow).toEqual({
    priorChips: [{ isTruncated: false, flexShrink: '0' }],
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    isTruncated: true,
    rows: 1,
  });
});
