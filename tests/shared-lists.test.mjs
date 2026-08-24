import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  canEditList,
  canManageListSharing,
  canViewList,
  cleanListDescription,
  cleanListTitle,
  isListMemberRole,
  isProtectedList,
  mutuallyExclusiveSystemKey,
  requiredRatingsSetting,
  strongestListRole,
  venueAdditionDecision,
  venueRemovalDecision,
} from '../src/lib/sharedListPermissions.ts';
import { GET as getList } from '../src/pages/api/lists/[id]/index.ts';
import { GET as getShares } from '../src/pages/api/lists/[id]/shares/index.ts';
import { PUT as addVenue, DELETE as removeVenue } from '../src/pages/api/lists/[id]/items/[venueId].ts';
import { POST as acceptInvite } from '../src/pages/api/list-invites/[identifier]/accept.ts';
import {
  POST as saveToDefault,
  DELETE as removeFromDefault,
} from '../src/pages/api/account/saved-venues/[venueId].ts';

function cookies(userId = null) {
  return { get: (name) => name === 'sdhh_session' && userId ? { value: userId } : undefined };
}

function listContext({ userId = null, token = null, track = false } = {}) {
  const url = new URL('https://sdhappyhours.com/api/lists/list-1');
  if (token) url.searchParams.set('invite', token);
  if (track) url.searchParams.set('track', '1');
  return { params: { id: 'list-1' }, url, cookies: cookies(userId) };
}

function itemContext(userId, venueId = '1') {
  return { params: { id: 'list-1', venueId }, cookies: cookies(userId) };
}

function sharesContext(userId) {
  return {
    params: { id: 'list-1' },
    cookies: cookies(userId),
    request: new Request('https://sdhappyhours.com/api/lists/list-1/shares'),
  };
}

function defaultSaveContext(userId, venueId = '1') {
  return { params: { venueId }, cookies: cookies(userId) };
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

async function main() {
  // Pure role rules: tokens can view, but only account-bound owner/editor
  // memberships can mutate. Only owners manage collaborators.
  assert.equal(canViewList({ role: 'viewer', isMember: false }), true);
  assert.equal(canEditList({ role: 'editor', isMember: false }), false);
  assert.equal(canEditList({ role: 'editor', isMember: true }), true);
  assert.equal(canEditList({ role: 'viewer', isMember: true }), false);
  assert.equal(canEditList({ role: 'owner', isMember: true }), true);
  assert.equal(canManageListSharing({ role: 'editor', isMember: true }), false);
  assert.equal(canManageListSharing({ role: 'owner', isMember: true }), true);
  assert.equal(strongestListRole('viewer', 'editor'), 'editor');
  assert.equal(strongestListRole('owner', 'editor'), 'owner');
  assert.equal(isListMemberRole('editor'), true);
  assert.equal(isListMemberRole('owner'), false);
  assert.equal(isProtectedList('favorites'), true);
  assert.equal(isProtectedList(null), false);
  assert.equal(requiredRatingsSetting('favorites', false), true);
  assert.equal(requiredRatingsSetting('been_to', false), true);
  assert.equal(requiredRatingsSetting('want_to_try', true), false);
  assert.equal(requiredRatingsSetting(null, true), true);
  assert.equal(mutuallyExclusiveSystemKey('want_to_try'), 'been_to');
  assert.equal(mutuallyExclusiveSystemKey('been_to'), 'want_to_try');
  assert.equal(mutuallyExclusiveSystemKey('favorites'), null);
  assert.equal(cleanListTitle('  Friday   Favorites  '), 'Friday Favorites');
  assert.equal(cleanListTitle('x'.repeat(100)).length, 80);
  assert.equal(cleanListDescription('x'.repeat(600)).length, 500);
  assert.equal(venueAdditionDecision({ canEdit: false, alreadyIncluded: false, itemCount: 0, maxItems: 2 }), 'forbidden');
  assert.equal(venueAdditionDecision({ canEdit: true, alreadyIncluded: true, itemCount: 1, maxItems: 2 }), 'exists');
  assert.equal(venueAdditionDecision({ canEdit: true, alreadyIncluded: false, itemCount: 2, maxItems: 2 }), 'full');
  assert.equal(venueAdditionDecision({ canEdit: true, alreadyIncluded: false, itemCount: 1, maxItems: 2 }), 'add');
  assert.equal(venueRemovalDecision({ canEdit: false, alreadyIncluded: true }), 'forbidden');
  assert.equal(venueRemovalDecision({ canEdit: true, alreadyIncluded: false }), 'missing');
  assert.equal(venueRemovalDecision({ canEdit: true, alreadyIncluded: true }), 'remove');

  globalThis.__sharedListApiFixture = { calls: [] };

  // A valid unguessable link previews the canonical list immediately, but an
  // anonymous visitor is explicitly non-editable until the invite is accepted.
  let result = await responseJson(await getList(listContext({ token: 'valid-editor-link', track: true })));
  assert.equal(result.status, 200);
  assert.equal(result.body.list.id, 'list-1');
  assert.equal(result.body.list.role, 'editor');
  assert.equal(result.body.list.canEdit, false);
  assert.equal(result.body.list.items[0].venue.id, 1);
  assert.ok(globalThis.__sharedListApiFixture.calls.some((call) => call[0] === 'activity' && call[3] === 'shared_list_viewed'));

  // The same private list ID without membership or a valid link is not exposed.
  result = await responseJson(await getList(listContext()));
  assert.equal(result.status, 404);

  // Owners can recover a reusable bearer URL for a pending link-only invite.
  // Non-owner members may see access entries but never receive that URL.
  result = await responseJson(await getShares(sharesContext('owner')));
  assert.equal(result.status, 200);
  assert.equal(
    result.body.access.find((entry) => entry.isLinkInvite).inviteUrl,
    'https://sdhappyhours.com/lists/list-1/?invite=72af67fb-78d0-4fad-8939-69af156a10dc'
  );
  result = await responseJson(await getShares(sharesContext('viewer')));
  assert.equal(result.status, 200);
  assert.equal(result.body.access.find((entry) => entry.isLinkInvite).inviteUrl, null);

  // Collaborator writes hit the one canonical list; viewers and anonymous link
  // holders cannot write through the mutation endpoint.
  result = await responseJson(await addVenue(itemContext('editor')));
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'added');
  result = await responseJson(await removeVenue(itemContext('editor')));
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'removed');
  result = await responseJson(await addVenue(itemContext('viewer')));
  assert.equal(result.status, 403);
  result = await responseJson(await addVenue(itemContext(null)));
  assert.equal(result.status, 401);

  // The venue-page quick action toggles only the configured default list.
  result = await responseJson(await saveToDefault(defaultSaveContext('owner')));
  assert.equal(result.status, 200);
  assert.equal(result.body.listId, 'default-list');
  result = await responseJson(await removeFromDefault(defaultSaveContext('owner')));
  assert.equal(result.status, 200);
  assert.equal(result.body.listId, 'default-list');
  assert.equal(result.body.status, 'removed');
  assert.ok(globalThis.__sharedListApiFixture.calls.some((call) =>
    call[0] === 'remove' && call[1] === 'default-list' && call[2] === 'owner' && call[3] === 1
  ));

  // Accepting the link turns editor intent into an account membership.
  result = await responseJson(await acceptInvite({
    params: { identifier: 'invite-1' },
    cookies: cookies('new-collaborator'),
    request: new Request('https://sdhappyhours.com/api/list-invites/invite-1/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'valid-editor-link' }),
    }),
  }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { accepted: true, listId: 'list-1', role: 'editor' });

  const migration = await readFile(path.join(process.cwd(), 'migrations', '0012_collaborative_lists.sql'), 'utf8');
  for (const table of ['happy_hour_lists', 'happy_hour_list_members', 'happy_hour_list_items', 'happy_hour_list_invites', 'happy_hour_list_activity']) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(migration, /token_hash\s+text NOT NULL UNIQUE/);
  assert.match(migration, /CHECK \(role IN \('editor', 'viewer'\)\)/);

  const unifiedMigration = await readFile(path.join(process.cwd(), 'migrations', '0013_unified_saved_lists.sql'), 'utf8');
  assert.match(unifiedMigration, /system_key IN \('favorites', 'want_to_try', 'been_to'\)/);
  assert.match(unifiedMigration, /CREATE TABLE happy_hour_list_item_feedback/);
  assert.match(unifiedMigration, /CREATE TABLE happy_hour_list_subscriptions/);
  assert.match(unifiedMigration, /ADD COLUMN default_list_id uuid/);
  assert.match(unifiedMigration, /FROM saved_spots spots/);

  console.log('shared lists: permission, API, link-access, collaborator-mutation, and migration tests passed');
}

await main();
