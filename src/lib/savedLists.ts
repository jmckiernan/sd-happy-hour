import { sql, withTransaction, type QueryExecutor } from './db';
import {
  cleanListDescription,
  cleanListTitle,
  mutuallyExclusiveSystemKey,
  requiredRatingsSetting,
  type ListAccessRole,
  type ListSystemKey,
} from './sharedListPermissions';

export const MAX_OWNED_LISTS_PER_USER = 10;
export const MAX_CUSTOM_LISTS_PER_USER = 7;
export const MAX_VENUES_PER_SAVED_LIST = 250;

export interface ListAlertSubscription {
  happyHour: boolean;
  liveDeals: boolean;
  email: boolean;
  text: boolean;
}

export interface SavedListOption {
  id: string;
  title: string;
  description: string;
  systemKey: ListSystemKey | null;
  ownerUserId: string;
  ownerName: string;
  role: ListAccessRole;
  canEdit: boolean;
  ratingsEnabled: boolean;
  commentsEnabled: boolean;
  isDefault: boolean;
  itemCount: number;
  subscription: ListAlertSubscription | null;
  updatedAt: string;
}

export interface VenueFeedback {
  userId: string;
  userName: string;
  rating: number | null;
  comment: string;
  updatedAt: string;
  isMine: boolean;
}

export interface SavedVenueMembership {
  listId: string;
  title: string;
  systemKey: ListSystemKey | null;
  role: ListAccessRole;
  canEdit: boolean;
  ratingsEnabled: boolean;
  commentsEnabled: boolean;
  createdAt: string;
  feedback: VenueFeedback[];
  myFeedback: VenueFeedback | null;
}

export interface SavedVenueRecord {
  venueId: number;
  lists: SavedVenueMembership[];
}

export interface UnifiedSavedState {
  defaultListId: string;
  lists: SavedListOption[];
  venues: SavedVenueRecord[];
}

export interface LegacySavedSpotProjection {
  spotId: number;
  status: 'favorite' | 'want-to-try' | 'been-to';
  note: string;
  rating?: number;
  createdAt: string;
  updatedAt: string;
}

interface ListOptionRow {
  id: string;
  title: string;
  description: string;
  system_key: ListSystemKey | null;
  owner_user_id: string;
  owner_name: string;
  access_role: ListAccessRole;
  can_edit: boolean;
  ratings_enabled: boolean;
  comments_enabled: boolean;
  is_default: boolean;
  item_count: number | string;
  happy_hour_alerts_enabled: boolean | null;
  live_deal_alerts_enabled: boolean | null;
  channel_email: boolean | null;
  channel_text: boolean | null;
  updated_at: string;
}

interface ItemRow {
  list_id: string;
  venue_id: number;
  created_at: string;
}

interface FeedbackRow {
  list_id: string;
  venue_id: number;
  user_id: string;
  user_name: string;
  rating: number | null;
  comment: string;
  updated_at: string;
}

const BUILT_INS: Array<{
  systemKey: ListSystemKey;
  title: string;
  ratingsEnabled: boolean;
}> = [
  { systemKey: 'favorites', title: 'Favorites', ratingsEnabled: true },
  { systemKey: 'want_to_try', title: 'Want to Try', ratingsEnabled: false },
  { systemKey: 'been_to', title: 'Been To', ratingsEnabled: true },
];

async function insertActivity(
  executor: QueryExecutor,
  listId: string,
  userId: string | null,
  eventType: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await executor`
    INSERT INTO happy_hour_list_activity (list_id, actor_user_id, event_type, metadata)
    VALUES (${listId}, ${userId}, ${eventType}, ${JSON.stringify(metadata)}::jsonb)`;
}

export async function ensureBuiltInListsForUser(userId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const users = await tx<{ id: string }>`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!users[0]) return;

    for (const builtIn of BUILT_INS) {
      await tx`
        INSERT INTO happy_hour_lists (
          owner_user_id, title, description, system_key,
          ratings_enabled, comments_enabled
        ) VALUES (
          ${userId}, ${builtIn.title}, '', ${builtIn.systemKey},
          ${builtIn.ratingsEnabled}, true
        )
        ON CONFLICT (owner_user_id, system_key) WHERE system_key IS NOT NULL DO NOTHING`;
    }

    await tx`
      UPDATE users SET default_list_id = favorites.id
      FROM happy_hour_lists favorites
      WHERE users.id = ${userId}
        AND users.default_list_id IS NULL
        AND favorites.owner_user_id = users.id
        AND favorites.system_key = 'favorites'`;
  });
}

function mapListOption(row: ListOptionRow): SavedListOption {
  const hasSubscription = row.happy_hour_alerts_enabled !== null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    systemKey: row.system_key,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    role: row.access_role,
    canEdit: Boolean(row.can_edit),
    ratingsEnabled: row.ratings_enabled,
    commentsEnabled: row.comments_enabled,
    isDefault: row.is_default,
    itemCount: Number(row.item_count),
    subscription: hasSubscription
      ? {
          happyHour: Boolean(row.happy_hour_alerts_enabled),
          liveDeals: Boolean(row.live_deal_alerts_enabled),
          email: Boolean(row.channel_email),
          text: Boolean(row.channel_text),
        }
      : null,
    updatedAt: row.updated_at,
  };
}

export async function listAccessibleSavedLists(userId: string): Promise<SavedListOption[]> {
  await ensureBuiltInListsForUser(userId);
  const rows = await sql<ListOptionRow>`
    SELECT
      lists.id, lists.title, lists.description, lists.system_key,
      lists.owner_user_id, owner.name AS owner_name,
      CASE WHEN lists.owner_user_id = ${userId} THEN 'owner' ELSE member.role END AS access_role,
      (lists.owner_user_id = ${userId} OR member.role = 'editor') AS can_edit,
      lists.ratings_enabled, lists.comments_enabled,
      (users.default_list_id = lists.id) AS is_default,
      (SELECT count(*) FROM happy_hour_list_items item WHERE item.list_id = lists.id) AS item_count,
      subscription.happy_hour_alerts_enabled,
      subscription.live_deal_alerts_enabled,
      subscription.channel_email,
      subscription.channel_text,
      lists.updated_at
    FROM happy_hour_lists lists
    JOIN users owner ON owner.id = lists.owner_user_id
    JOIN users ON users.id = ${userId}
    LEFT JOIN happy_hour_list_members member
      ON member.list_id = lists.id AND member.user_id = ${userId}
    LEFT JOIN happy_hour_list_subscriptions subscription
      ON subscription.list_id = lists.id AND subscription.user_id = ${userId}
    WHERE lists.owner_user_id = ${userId} OR member.user_id = ${userId}
    ORDER BY
      CASE lists.system_key
        WHEN 'favorites' THEN 0
        WHEN 'want_to_try' THEN 1
        WHEN 'been_to' THEN 2
        ELSE 3
      END,
      lists.updated_at DESC`;
  return rows.map(mapListOption);
}

export async function getUnifiedSavedState(userId: string): Promise<UnifiedSavedState> {
  const lists = await listAccessibleSavedLists(userId);
  const defaultListId = await resolveDefaultListId(userId, lists);
  const [itemRows, feedbackRows] = await Promise.all([
    sql<ItemRow>`
      SELECT item.list_id, item.venue_id, item.created_at
      FROM happy_hour_list_items item
      JOIN happy_hour_lists lists ON lists.id = item.list_id
      LEFT JOIN happy_hour_list_members member
        ON member.list_id = lists.id AND member.user_id = ${userId}
      WHERE lists.owner_user_id = ${userId} OR member.user_id = ${userId}
      -- Keep a venue in the position established by its first membership.
      -- Adding it to another list must not make the All Saved Spots grid jump.
      ORDER BY
        min(item.created_at) OVER (PARTITION BY item.venue_id) DESC,
        item.created_at DESC`,
    sql<FeedbackRow>`
      SELECT feedback.list_id, feedback.venue_id, feedback.user_id,
             users.name AS user_name, feedback.rating, feedback.comment,
             feedback.updated_at
      FROM happy_hour_list_item_feedback feedback
      JOIN users ON users.id = feedback.user_id
      JOIN happy_hour_lists lists ON lists.id = feedback.list_id
      LEFT JOIN happy_hour_list_members member
        ON member.list_id = lists.id AND member.user_id = ${userId}
      WHERE lists.owner_user_id = ${userId} OR member.user_id = ${userId}
      ORDER BY feedback.updated_at DESC`,
  ]);

  const listById = new Map(lists.map((list) => [list.id, list]));
  const feedbackByItem = new Map<string, VenueFeedback[]>();
  for (const row of feedbackRows) {
    const list = listById.get(row.list_id);
    if (!list) continue;
    const rating = list.ratingsEnabled && row.rating !== null ? Number(row.rating) : null;
    const comment = list.commentsEnabled ? row.comment : '';
    if (rating === null && !comment) continue;
    const key = `${row.list_id}:${row.venue_id}`;
    const entries = feedbackByItem.get(key) ?? [];
    entries.push({
      userId: row.user_id,
      userName: row.user_name,
      rating,
      comment,
      updatedAt: row.updated_at,
      isMine: row.user_id === userId,
    });
    feedbackByItem.set(key, entries);
  }

  const venuesById = new Map<number, SavedVenueRecord>();
  for (const row of itemRows) {
    const list = listById.get(row.list_id);
    if (!list) continue;
    const feedback = feedbackByItem.get(`${row.list_id}:${row.venue_id}`) ?? [];
    const venue = venuesById.get(row.venue_id) ?? { venueId: row.venue_id, lists: [] };
    venue.lists.push({
      listId: list.id,
      title: list.title,
      systemKey: list.systemKey,
      role: list.role,
      canEdit: list.canEdit,
      ratingsEnabled: list.ratingsEnabled,
      commentsEnabled: list.commentsEnabled,
      createdAt: row.created_at,
      feedback,
      myFeedback: feedback.find((entry) => entry.isMine) ?? null,
    });
    venuesById.set(row.venue_id, venue);
  }

  return { defaultListId, lists, venues: [...venuesById.values()] };
}

/** Temporary response compatibility while every consumer moves from the old
 * one-status shape to multi-list memberships. It never reads saved_spots. */
export function projectLegacySavedSpots(state: UnifiedSavedState): LegacySavedSpotProjection[] {
  const priority: Record<ListSystemKey, number> = {
    favorites: 1,
    want_to_try: 2,
    been_to: 3,
  };
  return state.venues.flatMap((venue) => {
    const membership = venue.lists
      .filter((list): list is SavedVenueMembership & { systemKey: ListSystemKey } => Boolean(list.systemKey))
      .sort((a, b) => priority[b.systemKey] - priority[a.systemKey])[0];
    if (!membership) return [];
    const status = membership.systemKey === 'favorites'
      ? 'favorite'
      : membership.systemKey === 'want_to_try'
        ? 'want-to-try'
        : 'been-to';
    return [{
      spotId: venue.venueId,
      status,
      note: membership.myFeedback?.comment ?? '',
      rating: membership.myFeedback?.rating ?? undefined,
      createdAt: membership.createdAt,
      updatedAt: membership.myFeedback?.updatedAt ?? membership.createdAt,
    }];
  });
}

async function resolveDefaultListId(
  userId: string,
  knownLists?: SavedListOption[]
): Promise<string> {
  const lists = knownLists ?? await listAccessibleSavedLists(userId);
  const configured = lists.find((list) => list.isDefault && list.canEdit);
  if (configured) return configured.id;
  const fallback = lists.find((list) => list.systemKey === 'favorites' && list.role === 'owner');
  if (!fallback) throw new Error('Favorites list is unavailable.');
  await sql`UPDATE users SET default_list_id = ${fallback.id} WHERE id = ${userId}`;
  return fallback.id;
}

export async function getDefaultListId(userId: string): Promise<string> {
  await ensureBuiltInListsForUser(userId);
  return resolveDefaultListId(userId);
}

export async function setDefaultListId(userId: string, listId: string): Promise<boolean> {
  return withTransaction(async (tx) => {
    const rows = await tx<{ id: string }>`
      SELECT lists.id
      FROM happy_hour_lists lists
      LEFT JOIN happy_hour_list_members member
        ON member.list_id = lists.id AND member.user_id = ${userId}
      WHERE lists.id = ${listId}
        AND (lists.owner_user_id = ${userId} OR member.role = 'editor')
      FOR UPDATE OF lists`;
    if (!rows[0]) return false;
    await tx`UPDATE users SET default_list_id = ${listId} WHERE id = ${userId}`;
    await insertActivity(tx, listId, userId, 'default_list_changed');
    return true;
  });
}

export interface CreateSavedListInput {
  title: unknown;
  description?: unknown;
  ratingsEnabled?: unknown;
  commentsEnabled?: unknown;
  venueId?: number | null;
}

export async function createSavedList(
  userId: string,
  input: CreateSavedListInput
): Promise<SavedListOption | null> {
  await ensureBuiltInListsForUser(userId);
  const title = cleanListTitle(input.title);
  const description = cleanListDescription(input.description);
  if (!title) throw new Error('List title is required.');
  const ratingsEnabled = requiredRatingsSetting(null, input.ratingsEnabled);
  const commentsEnabled = input.commentsEnabled === true;

  const listId = await withTransaction(async (tx) => {
    const owner = await tx<{ id: string }>`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!owner[0]) return null;
    const rows = await tx<{ id: string }>`
      INSERT INTO happy_hour_lists (
        owner_user_id, title, description, ratings_enabled, comments_enabled
      )
      SELECT ${userId}, ${title}, ${description}, ${ratingsEnabled}, ${commentsEnabled}
      WHERE (SELECT count(*) FROM happy_hour_lists WHERE owner_user_id = ${userId}) < ${MAX_OWNED_LISTS_PER_USER}
      RETURNING id`;
    if (!rows[0]) return null;
    await insertActivity(tx, rows[0].id, userId, 'list_created', { title });
    if (input.venueId) {
      await tx`
        INSERT INTO happy_hour_list_items (list_id, venue_id, added_by_user_id)
        VALUES (${rows[0].id}, ${input.venueId}, ${userId})`;
      await insertActivity(tx, rows[0].id, userId, 'venue_added_to_list', { venueId: input.venueId });
    }
    return rows[0].id;
  });
  if (!listId) return null;
  return (await listAccessibleSavedLists(userId)).find((list) => list.id === listId) ?? null;
}

export async function replaceVenueFeedback(
  listId: string,
  venueId: number,
  userId: string,
  input: { rating?: unknown; comment?: unknown; clear?: boolean }
): Promise<'updated' | 'removed' | 'forbidden' | 'missing'> {
  const rawComment = String(input.comment ?? '').trim().slice(0, 500);
  let rating: number | null = null;
  if (input.rating !== undefined && input.rating !== null && input.rating !== '') {
    const parsed = Number(input.rating);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
      throw new Error('Rating must be a whole number from 1 to 5.');
    }
    rating = parsed;
  }

  return withTransaction(async (tx) => {
    const rows = await tx<{
      can_edit: boolean;
      item_exists: boolean;
      ratings_enabled: boolean;
      comments_enabled: boolean;
      existing_rating: number | null;
      existing_comment: string | null;
    }>`
      SELECT
        (lists.owner_user_id = ${userId} OR member.role = 'editor') AS can_edit,
        EXISTS(
          SELECT 1 FROM happy_hour_list_items item
          WHERE item.list_id = lists.id AND item.venue_id = ${venueId}
        ) AS item_exists,
        lists.ratings_enabled, lists.comments_enabled,
        existing.rating AS existing_rating,
        existing.comment AS existing_comment
      FROM happy_hour_lists lists
      LEFT JOIN happy_hour_list_members member
        ON member.list_id = lists.id AND member.user_id = ${userId}
      LEFT JOIN happy_hour_list_item_feedback existing
        ON existing.list_id = lists.id
       AND existing.venue_id = ${venueId}
       AND existing.user_id = ${userId}
      WHERE lists.id = ${listId}
      FOR UPDATE OF lists`;
    if (!rows[0]?.can_edit) return 'forbidden';
    if (!rows[0].item_exists) return 'missing';
    if (rating !== null && !rows[0].ratings_enabled) {
      throw new Error('Ratings are not enabled for this list.');
    }
    if (rawComment && !rows[0].comments_enabled) {
      throw new Error('Comments are not enabled for this list.');
    }

    const nextRating = input.clear
      ? null
      : rows[0].ratings_enabled
        ? rating
        : rows[0].existing_rating;
    const nextComment = input.clear
      ? ''
      : rows[0].comments_enabled
        ? rawComment
        : rows[0].existing_comment ?? '';

    if (nextRating === null && !nextComment) {
      const deleted = await tx<{ user_id: string }>`
        DELETE FROM happy_hour_list_item_feedback
        WHERE list_id = ${listId} AND venue_id = ${venueId} AND user_id = ${userId}
        RETURNING user_id`;
      if (deleted[0]) {
        await tx`UPDATE happy_hour_lists SET updated_at = now() WHERE id = ${listId}`;
        await insertActivity(tx, listId, userId, 'venue_feedback_updated', { venueId, cleared: true });
      }
      return 'removed';
    }

    await tx`
      INSERT INTO happy_hour_list_item_feedback (
        list_id, venue_id, user_id, rating, comment
      ) VALUES (${listId}, ${venueId}, ${userId}, ${nextRating}, ${nextComment})
      ON CONFLICT (list_id, venue_id, user_id) DO UPDATE SET
        rating = EXCLUDED.rating,
        comment = EXCLUDED.comment`;
    await tx`UPDATE happy_hour_lists SET updated_at = now() WHERE id = ${listId}`;
    await insertActivity(tx, listId, userId, 'venue_feedback_updated', { venueId });
    return 'updated';
  });
}

export async function replaceListSubscription(
  listId: string,
  userId: string,
  input: ListAlertSubscription | null
): Promise<ListAlertSubscription | null | 'forbidden'> {
  return withTransaction(async (tx) => {
    const access = await tx<{ allowed: boolean }>`
      SELECT true AS allowed
      FROM happy_hour_lists lists
      LEFT JOIN happy_hour_list_members member
        ON member.list_id = lists.id AND member.user_id = ${userId}
      WHERE lists.id = ${listId}
        AND (lists.owner_user_id = ${userId} OR member.user_id IS NOT NULL)
      FOR UPDATE OF lists`;
    if (!access[0]) return 'forbidden';

    if (!input) {
      await tx`
        DELETE FROM happy_hour_list_subscriptions
        WHERE list_id = ${listId} AND user_id = ${userId}`;
      await insertActivity(tx, listId, userId, 'list_alerts_updated', { enabled: false });
      return null;
    }
    if (!input.happyHour && !input.liveDeals) {
      throw new Error('Choose happy-hour alerts, live-deal alerts, or both.');
    }
    if (!input.email && !input.text) {
      throw new Error('Choose email, text, or both.');
    }

    await tx`
      INSERT INTO happy_hour_list_subscriptions (
        list_id, user_id, happy_hour_alerts_enabled,
        live_deal_alerts_enabled, channel_email, channel_text
      ) VALUES (
        ${listId}, ${userId}, ${input.happyHour},
        ${input.liveDeals}, ${input.email}, ${input.text}
      )
      ON CONFLICT (list_id, user_id) DO UPDATE SET
        happy_hour_alerts_enabled = EXCLUDED.happy_hour_alerts_enabled,
        live_deal_alerts_enabled = EXCLUDED.live_deal_alerts_enabled,
        channel_email = EXCLUDED.channel_email,
        channel_text = EXCLUDED.channel_text`;
    await insertActivity(tx, listId, userId, 'list_alerts_updated', {
      enabled: true,
      happyHour: input.happyHour,
      liveDeals: input.liveDeals,
      email: input.email,
      text: input.text,
    });
    return input;
  });
}

export async function addVenueToDefaultList(
  userId: string,
  venueId: number
): Promise<{ listId: string; status: 'added' | 'exists' | 'full' }> {
  const listId = await getDefaultListId(userId);
  const result = await addVenueToEditableList(listId, userId, venueId);
  if (result === 'forbidden') {
    // Access may have changed between resolving and inserting. Reset to the
    // protected fallback and try once more.
    const lists = await listAccessibleSavedLists(userId);
    const favorites = lists.find((list) => list.systemKey === 'favorites' && list.role === 'owner');
    if (!favorites) throw new Error('Favorites list is unavailable.');
    await setDefaultListId(userId, favorites.id);
    const fallbackResult = await addVenueToEditableList(favorites.id, userId, venueId);
    if (fallbackResult === 'forbidden') throw new Error('Could not save this venue.');
    return { listId: favorites.id, status: fallbackResult };
  }
  return { listId, status: result };
}

export async function addVenueToEditableList(
  listId: string,
  userId: string,
  venueId: number
): Promise<'added' | 'exists' | 'forbidden' | 'full'> {
  return withTransaction(async (tx) => {
    const rows = await tx<{
      owner_user_id: string;
      system_key: ListSystemKey | null;
      can_edit: boolean;
      item_exists: boolean;
      item_count: number | string;
    }>`
      SELECT lists.owner_user_id, lists.system_key,
        (lists.owner_user_id = ${userId} OR member.role = 'editor') AS can_edit,
        EXISTS(
          SELECT 1 FROM happy_hour_list_items item
          WHERE item.list_id = lists.id AND item.venue_id = ${venueId}
        ) AS item_exists,
        (SELECT count(*) FROM happy_hour_list_items item WHERE item.list_id = lists.id) AS item_count
      FROM happy_hour_lists lists
      LEFT JOIN happy_hour_list_members member
        ON member.list_id = lists.id AND member.user_id = ${userId}
      WHERE lists.id = ${listId}
      FOR UPDATE OF lists`;
    if (!rows[0]?.can_edit) return 'forbidden';
    if (rows[0].item_exists) return 'exists';
    if (Number(rows[0].item_count) >= MAX_VENUES_PER_SAVED_LIST) return 'full';

    const opposite = mutuallyExclusiveSystemKey(rows[0].system_key);
    if (opposite) {
      const oppositeItems = await tx<{ list_id: string; can_edit: boolean }>`
        SELECT opposite_list.id AS list_id,
               (opposite_list.owner_user_id = ${userId} OR opposite_member.role = 'editor') AS can_edit
        FROM happy_hour_lists opposite_list
        JOIN happy_hour_list_items item
          ON item.list_id = opposite_list.id AND item.venue_id = ${venueId}
        LEFT JOIN happy_hour_list_members opposite_member
          ON opposite_member.list_id = opposite_list.id AND opposite_member.user_id = ${userId}
        WHERE opposite_list.owner_user_id = ${rows[0].owner_user_id}
          AND opposite_list.system_key = ${opposite}`;
      // Editing one shared built-in must never grant implicit write access to
      // the owner's other, potentially private, built-in list.
      if (oppositeItems[0] && !oppositeItems[0].can_edit) return 'forbidden';
      const removed = await tx<{ list_id: string }>`
        DELETE FROM happy_hour_list_items item
        USING happy_hour_lists opposite_list
        WHERE item.list_id = opposite_list.id
          AND opposite_list.owner_user_id = ${rows[0].owner_user_id}
          AND opposite_list.system_key = ${opposite}
          AND item.venue_id = ${venueId}
          AND (opposite_list.owner_user_id = ${userId} OR EXISTS (
            SELECT 1 FROM happy_hour_list_members opposite_member
            WHERE opposite_member.list_id = opposite_list.id
              AND opposite_member.user_id = ${userId}
              AND opposite_member.role = 'editor'
          ))
        RETURNING item.list_id`;
      if (removed[0]) {
        await insertActivity(tx, removed[0].list_id, userId, 'venue_removed_from_list', {
          venueId,
          reason: 'system_list_transition',
        });
      }
    }

    await tx`
      INSERT INTO happy_hour_list_items (list_id, venue_id, added_by_user_id)
      VALUES (${listId}, ${venueId}, ${userId})`;
    await tx`UPDATE happy_hour_lists SET updated_at = now() WHERE id = ${listId}`;
    await insertActivity(tx, listId, userId, 'venue_added_to_list', { venueId });
    return 'added';
  });
}

export interface ActiveListSubscriptionVenue {
  listId: string;
  venueId: number;
  userId: string;
  userName: string;
  userEmail: string;
  userPhone: string;
  userSmsConsentAt: string | null;
  happyHour: boolean;
  liveDeals: boolean;
  email: boolean;
  text: boolean;
}

export async function listActiveListSubscriptionVenues(): Promise<ActiveListSubscriptionVenue[]> {
  const rows = await sql<{
    list_id: string;
    venue_id: number;
    user_id: string;
    user_name: string;
    user_email: string;
    user_phone: string;
    user_sms_consent_at: string | null;
    happy_hour_alerts_enabled: boolean;
    live_deal_alerts_enabled: boolean;
    channel_email: boolean;
    channel_text: boolean;
  }>`
    SELECT subscription.list_id, item.venue_id, subscription.user_id,
           users.name AS user_name, users.email AS user_email,
           users.phone AS user_phone, users.sms_consent_at AS user_sms_consent_at,
           subscription.happy_hour_alerts_enabled,
           subscription.live_deal_alerts_enabled,
           subscription.channel_email, subscription.channel_text
    FROM happy_hour_list_subscriptions subscription
    JOIN happy_hour_lists lists ON lists.id = subscription.list_id
    JOIN users ON users.id = subscription.user_id
    JOIN happy_hour_list_items item ON item.list_id = subscription.list_id
    LEFT JOIN happy_hour_list_members member
      ON member.list_id = subscription.list_id AND member.user_id = subscription.user_id
    WHERE lists.owner_user_id = subscription.user_id OR member.user_id IS NOT NULL`;
  return rows.map((row) => ({
    listId: row.list_id,
    venueId: row.venue_id,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    userPhone: row.user_phone,
    userSmsConsentAt: row.user_sms_consent_at,
    happyHour: row.happy_hour_alerts_enabled,
    liveDeals: row.live_deal_alerts_enabled,
    email: row.channel_email,
    text: row.channel_text,
  }));
}
