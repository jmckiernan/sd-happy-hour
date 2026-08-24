import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const ROOT = process.cwd();
const outputPath = path.join(ROOT, '.data', 'tests', 'shared-lists.bundle.mjs');
await mkdir(path.dirname(outputPath), { recursive: true });

await build({
  entryPoints: [path.join(ROOT, 'tests', 'shared-lists.test.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outputPath,
  define: { 'import.meta.env.PROD': 'false' },
  plugins: [
    {
      name: 'shared-list-api-fixtures',
      setup(context) {
        context.onResolve({ filter: /\/lib\/sharedLists$/ }, (args) => {
          if (!args.importer.includes(`${path.sep}pages${path.sep}api${path.sep}`)) return null;
          return { path: 'shared-list-store-fixture', namespace: 'shared-list-test' };
        });
        context.onResolve({ filter: /\/lib\/session$/ }, (args) => {
          if (!args.importer.includes(`${path.sep}pages${path.sep}api${path.sep}`)) return null;
          return { path: 'shared-list-session-fixture', namespace: 'shared-list-test' };
        });
        context.onResolve({ filter: /\/lib\/store$/ }, (args) => {
          if (!args.importer.includes(`${path.sep}pages${path.sep}api${path.sep}`)) return null;
          return { path: 'shared-list-user-fixture', namespace: 'shared-list-test' };
        });
        context.onResolve({ filter: /\/lib\/savedLists$/ }, (args) => {
          if (!args.importer.includes(`${path.sep}pages${path.sep}api${path.sep}`)) return null;
          return { path: 'saved-list-store-fixture', namespace: 'shared-list-test' };
        });

        context.onLoad({ filter: /^shared-list-session-fixture$/, namespace: 'shared-list-test' }, () => ({
          loader: 'js',
          contents: `
            export async function getSession(cookies) {
              const value = cookies?.get?.('sdhh_session')?.value;
              return value ? { role: 'user', userId: value } : null;
            }
          `,
        }));
        context.onLoad({ filter: /^shared-list-user-fixture$/, namespace: 'shared-list-test' }, () => ({
          loader: 'js',
          contents: `
            export async function getUserById(id) {
              return { id, name: 'Fixture User', email: id + '@example.test' };
            }
          `,
        }));
        context.onLoad({ filter: /^saved-list-store-fixture$/, namespace: 'shared-list-test' }, () => ({
          loader: 'js',
          contents: `
            export const MAX_VENUES_PER_SAVED_LIST = 250;

            export async function getDefaultListId() {
              return 'default-list';
            }

            export async function addVenueToDefaultList(userId, venueId) {
              globalThis.__sharedListApiFixture.calls.push(['quick-add', 'default-list', userId, venueId]);
              return { listId: 'default-list', status: 'added' };
            }

            export async function getUnifiedSavedState() {
              return { defaultListId: 'default-list', lists: [], venues: [] };
            }
          `,
        }));
        context.onLoad({ filter: /^shared-list-store-fixture$/, namespace: 'shared-list-test' }, () => ({
          loader: 'js',
          contents: `
            export const MAX_VENUES_PER_LIST = 250;

            function fixture() {
              globalThis.__sharedListApiFixture ||= { calls: [] };
              return globalThis.__sharedListApiFixture;
            }

            function detail(role, isMember, inviteId = null) {
              return {
                id: 'list-1', title: 'Canonical List', description: 'One live object',
                ownerUserId: 'owner', ownerName: 'Owner', role,
                itemCount: 1, memberCount: 2,
                createdAt: '2026-08-01T00:00:00.000Z',
                updatedAt: '2026-08-23T00:00:00.000Z',
                access: { role, isMember },
                canEdit: isMember && (role === 'owner' || role === 'editor'),
                canManageSharing: isMember && role === 'owner',
                inviteId, inviteEmail: null, inviteExpiresAt: null,
                items: [{ venueId: 1, addedByUserId: 'owner', createdAt: '2026-08-01T00:00:00.000Z' }],
              };
            }

            export async function getHappyHourListForViewer(listId, userId, token) {
              fixture().calls.push(['get', listId, userId, token]);
              if (listId !== 'list-1') return null;
              if (userId === 'owner') return detail('owner', true);
              if (userId === 'editor') return detail('editor', true);
              if (userId === 'viewer') return detail('viewer', true);
              if (token === 'valid-editor-link') return detail('editor', false, 'invite-1');
              if (token === 'valid-viewer-link') return detail('viewer', false, 'invite-2');
              return null;
            }

            export async function recordHappyHourListActivity(...args) {
              fixture().calls.push(['activity', ...args]);
            }

            export async function listHappyHourListAccess(listId, userId) {
              if (listId !== 'list-1' || !['owner', 'viewer'].includes(userId)) return null;
              return [{
                id: 'owner', kind: 'owner', name: 'Owner', email: 'owner@example.test',
                role: 'owner', expiresAt: null, isLinkInvite: false,
              }, {
                id: '72af67fb-78d0-4fad-8939-69af156a10dc', kind: 'invite', name: '',
                email: 'Anyone with the link', role: 'viewer',
                expiresAt: '2026-09-22T00:00:00.000Z', isLinkInvite: true,
              }];
            }

            export async function createHappyHourListInvite() { return null; }

            export async function updateHappyHourList() { return null; }
            export async function deleteHappyHourList() { return false; }

            export async function addVenueToHappyHourList(listId, userId, venueId) {
              fixture().calls.push(['add', listId, userId, venueId]);
              return userId === 'owner' || userId === 'editor' ? 'added' : 'forbidden';
            }

            export async function removeVenueFromHappyHourList(listId, userId, venueId) {
              fixture().calls.push(['remove', listId, userId, venueId]);
              return userId === 'owner' || userId === 'editor' ? 'removed' : 'forbidden';
            }

            export async function acceptHappyHourListInvite(identifier, user, token) {
              fixture().calls.push(['accept', identifier, user.id, token]);
              if (identifier === 'invite-1' && token === 'valid-editor-link') {
                return { listId: 'list-1', role: 'editor' };
              }
              return 'not_found';
            }
          `,
        }));
      },
    },
  ],
});
