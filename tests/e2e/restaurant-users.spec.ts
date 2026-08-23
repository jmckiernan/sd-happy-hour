import { expect, test, type Route } from '@playwright/test';

async function fulfill(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test('owner can search privately, add an existing manager, and invite an unknown exact email', async ({ page }) => {
  let searchCalls = 0;
  const writes: Array<Record<string, unknown>> = [];
  await page.route('**/api/restaurant/venues/1/managers', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await fulfill(route, {
        owner: { name: 'Owner One', email: 'owner@example.com' },
        managers: [],
        invites: [],
      });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    writes.push(body);
    await fulfill(route, body.userId
      ? { kind: 'manager', manager: { id: 'manager-1', ...body } }
      : { kind: 'invite', invite: { id: 'invite-1', ...body }, email: { sent: true, simulated: false } }, 201);
  });
  await page.route('**/api/restaurant/venues/1/manager-search**', async (route) => {
    searchCalls += 1;
    const query = new URL(route.request().url()).searchParams.get('q');
    await fulfill(route, query === 'Alex'
      ? { exactEmail: false, results: [{ id: 'user-alex', name: 'Alex Manager', email: 'a***@example.com' }] }
      : { exactEmail: true, results: [] });
  });

  await page.goto('/restaurant/manage/ironside-fish-oyster/users/');
  await expect(page.getByText('Owner One')).toBeVisible();
  const search = page.getByLabel('Search users');
  await search.fill('Al');
  await page.waitForTimeout(350);
  expect(searchCalls).toBe(0);

  await page.getByLabel('Access level').selectOption('promotions');
  await search.fill('Alex');
  await expect(page.getByText('a***@example.com')).toBeVisible();
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Managing user added.')).toBeVisible();
  expect(writes[0]).toMatchObject({ userId: 'user-alex', role: 'promotions' });

  await search.fill('new.manager@example.com');
  await expect(page.getByText('No account yet — send a 7-day invitation')).toBeVisible();
  await page.getByRole('button', { name: 'Send Invite' }).click();
  await expect(page.getByText('Invitation sent.')).toBeVisible();
  expect(writes[1]).toMatchObject({ email: 'new.manager@example.com', role: 'promotions' });
});
