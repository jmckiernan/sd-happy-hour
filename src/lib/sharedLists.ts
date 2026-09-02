import crypto from 'node:crypto';
import { sql, withTransaction, type QueryExecutor } from './db';
import {
  canEditList,
  canManageListSharing,
  cleanListDescription,
  cleanListTitle,
  isListMemberRole,
  venueAdditionDecision,
  venueRemovalDecision,
  type ListAccess,
  type ListAccessRole,
  type ListMemberRole,
  type ListSystemKey,
} from './sharedListPermissions';
import {
  addVenueToEditableList,
  cleanVenueFeedbackText,
  createSavedList,
  ensureBuiltInListsForUser,
  listAccessibleSavedLists,
  MAX_CUSTOM_LISTS_PER_USER,
  MAX_VENUES_PER_SAVED_LIST,
  type ListAlertSubscription,
  type VenueFeedback,
} from './savedLists';

export { MAX_CUSTOM_LISTS_PER_USER } from './savedLists';
export const MAX_VENUES_PER_LIST = MAX_VENUES_PER_SAVED_LIST;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ListActivityType =
  | 'list_created'
  | 'list_renamed'
  | 'venue_added_to_list'
  | 'venue_removed_from_list'
  | 'list_shared'
  | 'share_link_copied'
  | 'invite_accepted'
  | 'shared_list_viewed'
  | 'list_settings_updated'
  | 'venue_feedback_updated'
  | 'default_list_changed'
  | 'list_alerts_updated';

export interface HappyHourListSummary {
  id: string;
  title: string;
  description: string;
  ownerUserId: string;
  ownerName: string;
  role: ListAccessRole;
  systemKey: ListSystemKey | null;
  canEdit: boolean;
  ratingsEnabled: boolean;
  commentsEnabled: boolean;
  isDefault: boolean;
  subscription: ListAlertSubscription | null;
  itemCount: number;
  memberCount: number;
  updatedAt: string;
}

export interface PendingListInvite {
  id: string;
  listId: string;
  title: string;
  ownerName: string;
  role: ListMemberRole;
  expiresAt: string;
}

/** List-scoped note visible to people on this shared list only. */
export interface ListItemNote {
  userId: string;
  userName: string;
  note: string;
  updatedAt: string;
  isMine: boolean;
}

export interface HappyHourListItem {
  venueId: number;
  addedByUserId: string | null;
  createdAt: string;
  feedback: VenueFeedback[];
  myFeedback: VenueFeedback | null;
  /** Collaborators' list-scoped notes (not yours). */
  notes: ListItemNote[];
  /** Your list-scoped note for this list only. */
  myNote: string;
}

export interface HappyHourListDetail extends HappyHourListSummary {
  createdAt: string;
  access: ListAccess;
  canEdit: boolean;
  canManageSharing: boolean;
  inviteId: string | null;
  inviteEmail: string | null;
  inviteExpiresAt: string | null;
  items: HappyHourListItem[];
}

export interface ListAccessEntry {
  id: string;
  kind: 'owner' | 'member' | 'invite';
  name: string;
  email: string;
  role: ListAccessRole;
  expiresAt: string | null;
  isLinkInvite: boolean;
}

interface ListSummaryRow {
  id: string;
  title: string;
  description: string;
  owner_user_id: string;
  owner_name: string;
  access_role: ListAccessRole;
  system_key: ListSystemKey | null;
  ratings_enabled: boolean;
  comments_enabled: boolean;
  is_default: boolean;
  happy_hour_alerts_enabled: boolean | null;
  live_deal_alerts_enabled: boolean | null;
  channel_email: boolean | null;
  channel_text: boolean | null;
  item_count: string | number;
  member_count: string | number;
  created_at?: string;
  updated_at: string;
}

interface ListDetailRow extends ListSummaryRow {
  created_at: string;
  is_member: boolean;
  invite_id: string | null;
  invite_email: string | null;
  invite_expires_at: string | null;
}

interface ListItemRow {
  venue_id: number;
  added_by_user_id: string | null;
  created_at: string;
}

interface ListFeedbackRow {
  venue_id: number;
  user_id: string;
  user_name: string;
  rating: number | null;
  comment: string;
  updated_at: string;
}

interface ListNoteRow {
  venue_id: number;
  user_id: string;
  user_name: string;
  note: string;
  updated_at: string;
}

function mapSummary(row: ListSummaryRow): HappyHourListSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    role: row.access_role,
    systemKey: row.system_key,
    canEdit: row.access_role === 'owner' || row.access_role === 'editor',
    ratingsEnabled: row.ratings_enabled,
    commentsEnabled: row.comments_enabled,
    isDefault: row.is_default,
    subscription: row.happy_hour_alerts_enabled === null
      ? null
      : {
          happyHour: Boolean(row.happy_hour_alerts_enabled),
          liveDeals: Boolean(row.live_deal_alerts_enabled),
          email: Boolean(row.channel_email),
          text: Boolean(row.channel_text),
        },
    itemCount: Number(row.item_count),
    memberCount: Number(row.member_count),
    updatedAt: row.updated_at,
  };
}

export function hashListInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function insertActivity(
  executor: QueryExecutor,
  listId: string,
  actorUserId: string | null,
  eventType: ListActivityType,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await executor`
    INSERT INTO happy_hour_list_activity (list_id, actor_user_id, event_type, metadata)
    VALUES (${listId}, ${actorUserId}, ${eventType}, ${JSON.stringify(metadata)}::jsonb)`;
}

export async function listHappyHourListsForUser(userId: string, email: string): Promise<{
  lists: HappyHourListSummary[];
  pendingInvites: PendingListInvite[];
}> {
  await ensureBuiltInListsForUser(userId);
  const [savedLists, memberRows, inviteRows] = await Promise.all([
    listAccessibleSavedLists(userId),
    sql<{ list_id: string; member_count: number | string }>`
      SELECT list_id, count(*) AS member_count
      FROM happy_hour_list_members
      GROUP BY list_id`,
    sql<{
      id: string;
      list_id: string;
      title: string;
      owner_name: string;
      role: ListMemberRole;
      expires_at: string;
    }>`
      SELECT invite.id, invite.list_id, l.title, owner.name AS owner_name, invite.role, invite.expires_at
      FROM happy_hour_list_invites invite
      JOIN happy_hour_lists l ON l.id = invite.list_id
      JOIN users owner ON owner.id = l.owner_user_id
      LEFT JOIN happy_hour_list_members m ON m.list_id = invite.list_id AND m.user_id = ${userId}
      WHERE lower(invite.email) = lower(${email})
        AND invite.accepted_at IS NULL AND invite.revoked_at IS NULL AND invite.expires_at > now()
        AND l.owner_user_id <> ${userId} AND m.user_id IS NULL
      ORDER BY invite.created_at DESC`,
  ]);

  const memberCounts = new Map(memberRows.map((row) => [row.list_id, Number(row.member_count)]));

  return {
    lists: savedLists.map((list) => ({
      id: list.id,
      title: list.title,
      description: list.description,
      ownerUserId: list.ownerUserId,
      ownerName: list.ownerName,
      role: list.role,
      systemKey: list.systemKey,
      canEdit: list.canEdit,
      ratingsEnabled: list.ratingsEnabled,
      commentsEnabled: list.commentsEnabled,
      isDefault: list.isDefault,
      subscription: list.subscription,
      itemCount: list.itemCount,
      memberCount: memberCounts.get(list.id) ?? 0,
      updatedAt: list.updatedAt,
    })),
    pendingInvites: inviteRows.map((row) => ({
      id: row.id,
      listId: row.list_id,
      title: row.title,
      ownerName: row.owner_name,
      role: row.role,
      expiresAt: row.expires_at,
    })),
  };
}

export async function createHappyHourList(
  userId: string,
  input: {
    title: unknown;
    description?: unknown;
    ratingsEnabled?: unknown;
    commentsEnabled?: unknown;
    venueId?: number | null;
  }
): Promise<HappyHourListSummary | null> {
  const list = await createSavedList(userId, input);
  if (!list) return null;
  return {
    ...list,
    memberCount: 0,
  };
}

export async function getHappyHourListForViewer(
  listId: string,
  userId: string | null,
  rawInviteToken?: string | null
): Promise<HappyHourListDetail | null> {
  const tokenHash = rawInviteToken && rawInviteToken.length <= 256
    ? hashListInviteToken(rawInviteToken)
    : null;
  const linkInviteId = rawInviteToken && UUID_PATTERN.test(rawInviteToken)
    ? rawInviteToken
    : null;
  const rows = await sql<ListDetailRow>`
    SELECT
      l.id, l.title, l.description, l.owner_user_id, owner.name AS owner_name,
      l.system_key, l.ratings_enabled, l.comments_enabled,
      CASE
        WHEN l.owner_user_id = ${userId} THEN 'owner'
        WHEN member.role = 'editor' THEN 'editor'
        WHEN member.role = 'viewer' THEN 'viewer'
        WHEN invite.role = 'editor' THEN 'editor'
        ELSE 'viewer'
      END AS access_role,
      (l.owner_user_id = ${userId} OR member.user_id IS NOT NULL) AS is_member,
      (l.id = (SELECT default_list_id FROM users WHERE id = ${userId})) AS is_default,
      (SELECT count(*) FROM happy_hour_list_items i WHERE i.list_id = l.id) AS item_count,
      (SELECT count(*) FROM happy_hour_list_members m WHERE m.list_id = l.id) AS member_count,
      subscription.happy_hour_alerts_enabled,
      subscription.live_deal_alerts_enabled,
      subscription.channel_email, subscription.channel_text,
      invite.id AS invite_id, invite.email AS invite_email, invite.expires_at AS invite_expires_at,
      l.created_at, l.updated_at
    FROM happy_hour_lists l
    JOIN users owner ON owner.id = l.owner_user_id
    LEFT JOIN happy_hour_list_members member
      ON member.list_id = l.id AND member.user_id = ${userId}
    LEFT JOIN happy_hour_list_invites invite
      ON invite.list_id = l.id
      AND (
        invite.token_hash = ${tokenHash}
        OR (invite.email IS NULL AND invite.id::text = ${linkInviteId})
      )
      AND invite.accepted_at IS NULL AND invite.revoked_at IS NULL AND invite.expires_at > now()
    LEFT JOIN happy_hour_list_subscriptions subscription
      ON subscription.list_id = l.id AND subscription.user_id = ${userId}
    WHERE l.id = ${listId}
      AND (l.owner_user_id = ${userId} OR member.user_id IS NOT NULL OR invite.id IS NOT NULL)
    LIMIT 1`;
  if (!rows[0]) return null;

  const ownerUserId = rows[0].owner_user_id;
  const [itemRows, feedbackRows, noteRows] = await Promise.all([
    sql<ListItemRow>`
      SELECT venue_id, added_by_user_id, created_at
      FROM happy_hour_list_items WHERE list_id = ${listId} ORDER BY created_at DESC`,
    sql<ListFeedbackRow>`
      SELECT feedback.venue_id, feedback.user_id, users.name AS user_name,
             feedback.rating, feedback.comment, feedback.updated_at
      FROM user_venue_feedback feedback
      JOIN users ON users.id = feedback.user_id
      JOIN happy_hour_list_items item
        ON item.venue_id = feedback.venue_id AND item.list_id = ${listId}
      LEFT JOIN happy_hour_list_members author_member
        ON author_member.list_id = ${listId}
       AND author_member.user_id = feedback.user_id
      WHERE feedback.user_id = ${ownerUserId}
         OR author_member.user_id IS NOT NULL
      ORDER BY feedback.updated_at DESC`,
    // Same audience as feedback: anyone who can view the list (incl. signed-out).
    sql<ListNoteRow>`
      SELECT notes.venue_id, notes.user_id, users.name AS user_name,
             notes.note, notes.updated_at
      FROM happy_hour_list_item_notes notes
      JOIN users ON users.id = notes.user_id
      LEFT JOIN happy_hour_list_members author_member
        ON author_member.list_id = notes.list_id
       AND author_member.user_id = notes.user_id
      WHERE notes.list_id = ${listId}
        AND (notes.user_id = ${ownerUserId} OR author_member.user_id IS NOT NULL)
      ORDER BY notes.updated_at DESC`,
  ]);
  const feedbackByVenue = new Map<number, VenueFeedback[]>();
  const myFeedbackByVenue = new Map<number, VenueFeedback>();
  for (const row of feedbackRows) {
    const isMine = Boolean(userId) && row.user_id === userId;
    const rating = row.rating !== null ? Number(row.rating) : null;
    const comment = rows[0].comments_enabled
      ? cleanVenueFeedbackText(row.comment)
      : '';
    if (isMine) {
      // Keep the viewer's own rating even when this list hides comments.
      if (rating !== null || comment) {
        myFeedbackByVenue.set(row.venue_id, {
          userId: row.user_id,
          userName: row.user_name,
          rating,
          comment,
          updatedAt: row.updated_at,
          isMine: true,
        });
      }
      continue;
    }
    if (rating === null && !comment) continue;
    const entries = feedbackByVenue.get(row.venue_id) ?? [];
    entries.push({
      userId: row.user_id,
      userName: row.user_name,
      rating,
      comment,
      updatedAt: row.updated_at,
      isMine: false,
    });
    feedbackByVenue.set(row.venue_id, entries);
  }
  const notesByVenue = new Map<number, ListItemNote[]>();
  const myNoteByVenue = new Map<number, string>();
  for (const row of noteRows) {
    const note = cleanVenueFeedbackText(row.note);
    if (!note) continue;
    const isMine = Boolean(userId) && row.user_id === userId;
    if (isMine) {
      myNoteByVenue.set(row.venue_id, note);
      continue;
    }
    const entries = notesByVenue.get(row.venue_id) ?? [];
    entries.push({
      userId: row.user_id,
      userName: row.user_name,
      note,
      updatedAt: row.updated_at,
      isMine: false,
    });
    notesByVenue.set(row.venue_id, entries);
  }
  const access: ListAccess = { role: rows[0].access_role, isMember: rows[0].is_member };
  return {
    ...mapSummary(rows[0]),
    createdAt: rows[0].created_at,
    access,
    canEdit: canEditList(access),
    canManageSharing: canManageListSharing(access),
    inviteId: rows[0].invite_id,
    inviteEmail: rows[0].invite_email,
    inviteExpiresAt: rows[0].invite_expires_at,
    items: itemRows.map((row) => ({
      venueId: row.venue_id,
      addedByUserId: row.added_by_user_id,
      createdAt: row.created_at,
      feedback: feedbackByVenue.get(row.venue_id) ?? [],
      myFeedback: myFeedbackByVenue.get(row.venue_id) ?? null,
      notes: notesByVenue.get(row.venue_id) ?? [],
      myNote: myNoteByVenue.get(row.venue_id) ?? '',
    })),
  };
}

export async function updateHappyHourList(
  listId: string,
  userId: string,
  input: {
    title?: unknown;
    description?: unknown;
    ratingsEnabled?: unknown;
    commentsEnabled?: unknown;
  }
): Promise<HappyHourListSummary | null> {
  const hasTitle = Object.prototype.hasOwnProperty.call(input, 'title');
  const hasDescription = Object.prototype.hasOwnProperty.call(input, 'description');
  const hasRatings = Object.prototype.hasOwnProperty.call(input, 'ratingsEnabled');
  const hasComments = Object.prototype.hasOwnProperty.call(input, 'commentsEnabled');
  const title = hasTitle ? cleanListTitle(input.title) : null;
  const description = hasDescription ? cleanListDescription(input.description) : null;
  if (hasTitle && !title) throw new Error('List title is required.');
  if (!hasTitle && !hasDescription && !hasRatings && !hasComments) {
    throw new Error('Send list details or settings to update.');
  }

  const updated = await withTransaction(async (tx) => {
    const before = await tx<{
      title: string;
      system_key: ListSystemKey | null;
      owner_user_id: string;
      ratings_enabled: boolean;
      comments_enabled: boolean;
    }>`
      SELECT l.title, l.system_key, l.owner_user_id,
             l.ratings_enabled, l.comments_enabled
      FROM happy_hour_lists l
      LEFT JOIN happy_hour_list_members member ON member.list_id = l.id AND member.user_id = ${userId}
      WHERE l.id = ${listId}
        AND (l.owner_user_id = ${userId} OR member.role = 'editor')
      FOR UPDATE OF l`;
    if (!before[0]) return null;
    const isOwner = before[0].owner_user_id === userId;
    if ((hasRatings || hasComments) && !isOwner) {
      throw new Error('Only the list owner can change rating or comment settings.');
    }
    if (hasTitle && before[0].system_key) {
      throw new Error('Built-in lists cannot be renamed.');
    }

    let ratingsEnabled = before[0].ratings_enabled;
    if (hasRatings) {
      if (
        (before[0].system_key === 'favorites' || before[0].system_key === 'been_to')
        && input.ratingsEnabled !== true
      ) {
        throw new Error('Ratings are always available on Favorites and Been To.');
      }
      if (before[0].system_key === 'want_to_try' && input.ratingsEnabled === true) {
        throw new Error('Ratings cannot be enabled on Want to Try.');
      }
      ratingsEnabled = input.ratingsEnabled === true;
    }
    const commentsEnabled = hasComments
      ? input.commentsEnabled === true
      : before[0].comments_enabled;

    await tx`
      UPDATE happy_hour_lists l SET
        title = COALESCE(${title}, l.title),
        description = COALESCE(${description}, l.description),
        ratings_enabled = ${ratingsEnabled},
        comments_enabled = ${commentsEnabled}
      WHERE l.id = ${listId}
      RETURNING l.id`;
    if (title && title !== before[0].title) {
      await insertActivity(tx, listId, userId, 'list_renamed', { from: before[0].title, to: title });
    }
    if (hasRatings || hasComments) {
      await insertActivity(tx, listId, userId, 'list_settings_updated', {
        ratingsEnabled,
        commentsEnabled,
      });
    }
    return true;
  });
  if (!updated) return null;
  return await getHappyHourListForViewer(listId, userId);
}

export async function deleteHappyHourList(listId: string, userId: string): Promise<boolean> {
  return withTransaction(async (tx) => {
    const list = await tx<{ system_key: ListSystemKey | null }>`
      SELECT system_key FROM happy_hour_lists
      WHERE id = ${listId} AND owner_user_id = ${userId}
      FOR UPDATE`;
    if (!list[0]) return false;
    if (list[0].system_key) throw new Error('Built-in lists cannot be deleted.');
    const rows = await tx<{ id: string }>`
      DELETE FROM happy_hour_lists WHERE id = ${listId} RETURNING id`;
    return Boolean(rows[0]);
  });
}

export async function addVenueToHappyHourList(
  listId: string,
  userId: string,
  venueId: number
): Promise<'added' | 'exists' | 'forbidden' | 'full'> {
  return addVenueToEditableList(listId, userId, venueId);
}

export async function removeVenueFromHappyHourList(
  listId: string,
  userId: string,
  venueId: number
): Promise<'removed' | 'missing' | 'forbidden'> {
  return withTransaction(async (tx) => {
    const accessRows = await tx<{ can_edit: boolean; item_exists: boolean }>`
      SELECT
        (l.owner_user_id = ${userId} OR member.role = 'editor') AS can_edit,
        EXISTS(SELECT 1 FROM happy_hour_list_items i WHERE i.list_id = l.id AND i.venue_id = ${venueId}) AS item_exists
      FROM happy_hour_lists l
      LEFT JOIN happy_hour_list_members member ON member.list_id = l.id AND member.user_id = ${userId}
      WHERE l.id = ${listId} FOR UPDATE OF l`;
    const decision = venueRemovalDecision({
      canEdit: Boolean(accessRows[0]?.can_edit),
      alreadyIncluded: Boolean(accessRows[0]?.item_exists),
    });
    if (decision !== 'remove') return decision;
    const removed = await tx<{ venue_id: number }>`
      DELETE FROM happy_hour_list_items
      WHERE list_id = ${listId} AND venue_id = ${venueId}
      RETURNING venue_id`;
    if (!removed[0]) return 'missing';
    await tx`UPDATE happy_hour_lists SET updated_at = now() WHERE id = ${listId}`;
    await insertActivity(tx, listId, userId, 'venue_removed_from_list', { venueId });
    return 'removed';
  });
}

export async function createHappyHourListInvite(
  listId: string,
  ownerUserId: string,
  input: { email?: unknown; role?: unknown }
): Promise<{ id: string; rawToken: string; email: string | null; role: ListMemberRole; expiresAt: string } | null> {
  if (!isListMemberRole(input.role)) throw new Error('Access must be editor or viewer.');
  const email = String(input.email ?? '').trim().toLowerCase() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashListInviteToken(rawToken);

  return withTransaction(async (tx) => {
    const owner = await tx<{ owner_email: string }>`
      SELECT users.email AS owner_email
      FROM happy_hour_lists l JOIN users ON users.id = l.owner_user_id
      WHERE l.id = ${listId} AND l.owner_user_id = ${ownerUserId}
      FOR UPDATE`;
    if (!owner[0]) return null;
    if (email && owner[0].owner_email.toLowerCase() === email) {
      throw new Error('You already own this list.');
    }
    if (email) {
      // A new invitation supersedes an older pending one for the same person,
      // keeping My Stuff free of duplicates and invalidating the older URL.
      await tx`
        UPDATE happy_hour_list_invites SET revoked_at = now()
        WHERE list_id = ${listId} AND lower(email) = lower(${email})
          AND accepted_at IS NULL AND revoked_at IS NULL`;
    }
    const rows = await tx<{
      id: string;
      email: string | null;
      role: ListMemberRole;
      expires_at: string;
    }>`
      INSERT INTO happy_hour_list_invites (
        list_id, email, role, token_hash, invited_by_user_id, expires_at
      ) VALUES (${listId}, ${email}, ${input.role}, ${tokenHash}, ${ownerUserId}, now() + interval '30 days')
      RETURNING id, email, role, expires_at`;
    await insertActivity(tx, listId, ownerUserId, 'list_shared', {
      method: email ? 'email' : 'link',
      role: input.role,
    });
    await tx`UPDATE happy_hour_lists SET updated_at = now() WHERE id = ${listId}`;
    return { id: rows[0].id, rawToken, email: rows[0].email, role: rows[0].role, expiresAt: rows[0].expires_at };
  });
}

export async function listHappyHourListAccess(listId: string, userId: string): Promise<ListAccessEntry[] | null> {
  const accessRows = await sql<{ allowed: boolean }>`
    SELECT true AS allowed FROM happy_hour_lists l
    LEFT JOIN happy_hour_list_members member ON member.list_id = l.id AND member.user_id = ${userId}
    WHERE l.id = ${listId} AND (l.owner_user_id = ${userId} OR member.user_id IS NOT NULL)`;
  if (!accessRows[0]) return null;

  const rows = await sql<{
    id: string;
    kind: 'owner' | 'member' | 'invite';
    name: string;
    email: string;
    role: ListAccessRole;
    expires_at: string | null;
    is_link_invite: boolean;
  }>`
    SELECT l.owner_user_id::text AS id, 'owner'::text AS kind, owner.name, owner.email,
      'owner'::text AS role, NULL::timestamptz AS expires_at, false AS is_link_invite
    FROM happy_hour_lists l JOIN users owner ON owner.id = l.owner_user_id WHERE l.id = ${listId}
    UNION ALL
    SELECT member.user_id::text, 'member'::text, users.name, users.email, member.role, NULL::timestamptz, false
    FROM happy_hour_list_members member JOIN users ON users.id = member.user_id WHERE member.list_id = ${listId}
    UNION ALL
    SELECT invite.id::text, 'invite'::text, ''::text, COALESCE(invite.email, 'Anyone with the link'),
      invite.role, invite.expires_at, invite.email IS NULL
    FROM happy_hour_list_invites invite
    WHERE invite.list_id = ${listId}
      AND invite.accepted_at IS NULL AND invite.revoked_at IS NULL AND invite.expires_at > now()`;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
    isLinkInvite: row.is_link_invite,
  }));
}

export async function updateHappyHourListAccess(
  listId: string,
  ownerUserId: string,
  subjectId: string,
  role: unknown
): Promise<boolean> {
  if (!isListMemberRole(role)) throw new Error('Access must be editor or viewer.');
  return withTransaction(async (tx) => {
    const owner = await tx<{ id: string }>`
      SELECT id FROM happy_hour_lists WHERE id = ${listId} AND owner_user_id = ${ownerUserId} FOR UPDATE`;
    if (!owner[0]) return false;
    const member = await tx<{ user_id: string }>`
      UPDATE happy_hour_list_members SET role = ${role}
      WHERE list_id = ${listId} AND user_id::text = ${subjectId}
      RETURNING user_id`;
    if (member[0]) {
      await tx`UPDATE happy_hour_lists SET updated_at = now() WHERE id = ${listId}`;
      return true;
    }
    const invite = await tx<{ id: string }>`
      UPDATE happy_hour_list_invites SET role = ${role}
      WHERE list_id = ${listId} AND id::text = ${subjectId}
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      RETURNING id`;
    if (invite[0]) await tx`UPDATE happy_hour_lists SET updated_at = now() WHERE id = ${listId}`;
    return Boolean(invite[0]);
  });
}

export async function removeHappyHourListAccess(
  listId: string,
  ownerUserId: string,
  subjectId: string
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const owner = await tx<{ id: string }>`
      SELECT id FROM happy_hour_lists WHERE id = ${listId} AND owner_user_id = ${ownerUserId} FOR UPDATE`;
    if (!owner[0]) return false;
    const member = await tx<{ user_id: string }>`
      DELETE FROM happy_hour_list_members
      WHERE list_id = ${listId} AND user_id::text = ${subjectId}
      RETURNING user_id`;
    if (member[0]) {
      await tx`
        DELETE FROM happy_hour_list_subscriptions
        WHERE list_id = ${listId} AND user_id = ${member[0].user_id}`;
      await tx`
        UPDATE users SET default_list_id = favorites.id
        FROM happy_hour_lists favorites
        WHERE users.id = ${member[0].user_id}
          AND users.default_list_id = ${listId}
          AND favorites.owner_user_id = users.id
          AND favorites.system_key = 'favorites'`;
      await tx`UPDATE happy_hour_lists SET updated_at = now() WHERE id = ${listId}`;
      return true;
    }
    const invite = await tx<{ id: string }>`
      UPDATE happy_hour_list_invites SET revoked_at = now()
      WHERE list_id = ${listId} AND id::text = ${subjectId}
        AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING id`;
    if (invite[0]) await tx`UPDATE happy_hour_lists SET updated_at = now() WHERE id = ${listId}`;
    return Boolean(invite[0]);
  });
}

export async function acceptHappyHourListInvite(
  identifier: string,
  user: { id: string; email: string },
  rawToken?: string | null
): Promise<{ listId: string; role: ListMemberRole } | 'not_found' | 'email_mismatch'> {
  const tokenHash = rawToken && rawToken.length <= 256 ? hashListInviteToken(rawToken) : null;
  const identifierIsId = UUID_PATTERN.test(identifier);
  return withTransaction(async (tx) => {
    const rows = await tx<{
      id: string;
      list_id: string;
      email: string | null;
      role: ListMemberRole;
      owner_user_id: string;
      token_hash: string;
    }>`
      SELECT invite.id, invite.list_id, invite.email, invite.role, invite.token_hash, l.owner_user_id
      FROM happy_hour_list_invites invite
      JOIN happy_hour_lists l ON l.id = invite.list_id
      WHERE invite.accepted_at IS NULL AND invite.revoked_at IS NULL AND invite.expires_at > now()
        AND (
          (${identifierIsId} AND invite.id::text = ${identifier})
          OR (${tokenHash} IS NOT NULL AND invite.token_hash = ${tokenHash})
        )
      FOR UPDATE`;
    if (!rows[0]) return 'not_found';
    if (rows[0].email && rows[0].email.toLowerCase() !== user.email.toLowerCase()) return 'email_mismatch';
    // Account-discovered email invitations may be accepted by ID because the
    // matching signed-in email is the proof. Generic invitations require the
    // bearer credential: either a legacy raw token or the reusable link UUID.
    if (
      !rows[0].email
      && rawToken !== rows[0].id
      && (!tokenHash || tokenHash !== rows[0].token_hash)
    ) return 'not_found';
    if (rows[0].owner_user_id !== user.id) {
      await tx`
        INSERT INTO happy_hour_list_members (list_id, user_id, role, invited_by_user_id)
        SELECT list_id, ${user.id}, role, invited_by_user_id
        FROM happy_hour_list_invites WHERE id = ${rows[0].id}
        ON CONFLICT (list_id, user_id) DO UPDATE SET
          role = CASE
            WHEN happy_hour_list_members.role = 'editor' OR EXCLUDED.role = 'editor' THEN 'editor'
            ELSE 'viewer'
          END`;
    }
    await tx`
      UPDATE happy_hour_list_invites SET accepted_at = now(), accepted_by_user_id = ${user.id}
      WHERE id = ${rows[0].id}`;
    await tx`UPDATE happy_hour_lists SET updated_at = now() WHERE id = ${rows[0].list_id}`;
    await insertActivity(tx, rows[0].list_id, user.id, 'invite_accepted', { role: rows[0].role });
    return { listId: rows[0].list_id, role: rows[0].role };
  });
}

export async function recordHappyHourListActivity(
  listId: string,
  actorUserId: string | null,
  eventType: 'share_link_copied' | 'shared_list_viewed',
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await insertActivity(sql, listId, actorUserId, eventType, metadata);
}
