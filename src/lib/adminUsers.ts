import crypto from 'node:crypto';
import { ADMIN_EMAILS } from './admins';
import { sql, withTransaction } from './db';
import {
  accountMutationDecision,
  averageSessionSeconds,
  normalizeReportingDays,
  requiresOwnershipTransfer,
  type AccountStatus,
  type AdminAccountAction,
} from './adminUserPolicy';
import type { User } from './store';
import { marketAreaLabel } from './marketAreas';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

type RoleFilter = '' | 'owner' | 'manager' | 'admin';

interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  account_status: AccountStatus;
  created_at: Date | string;
  last_activity_at: Date | string | null;
  owner_venue_count: number | string;
  manager_venue_count: number | string;
  owned_list_count: number | string;
  custom_list_count: number | string;
  shared_list_count: number | string;
  notification_rule_count: number | string;
  notification_channel_count: number | string;
  session_count: number | string;
  active_seconds: number | string;
  email_sent: number | string;
  email_delivered: number | string;
  email_failed: number | string;
  text_sent: number | string;
  text_delivered: number | string;
  text_failed: number | string;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function encodeCursor(row: Pick<AdminUserRow, 'created_at' | 'id'>): string {
  return Buffer.from(JSON.stringify({ createdAt: iso(row.created_at), id: row.id })).toString('base64url');
}

function decodeCursor(raw: string | null): { createdAt: string | null; id: string | null } {
  if (!raw) return { createdAt: null, id: null };
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const date = new Date(parsed.createdAt);
    if (!Number.isFinite(date.getTime()) || !/^[0-9a-f-]{36}$/i.test(parsed.id)) throw new Error('bad cursor');
    return { createdAt: date.toISOString(), id: parsed.id };
  } catch {
    return { createdAt: null, id: null };
  }
}

function cleanRole(value: unknown): RoleFilter {
  return value === 'owner' || value === 'manager' || value === 'admin' ? value : '';
}

function cleanStatus(value: unknown): AccountStatus | '' {
  return value === 'active' || value === 'inactive' || value === 'anonymized' ? value : '';
}

export async function listAdminUsers(input: {
  search?: string;
  status?: string;
  role?: string;
  days?: number;
  limit?: number;
  cursor?: string | null;
} = {}) {
  const search = String(input.search || '').trim().toLowerCase().slice(0, 100);
  const searchPrefix = `${search}%`;
  const status = cleanStatus(input.status);
  const role = cleanRole(input.role);
  const days = normalizeReportingDays(input.days);
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(Number(input.limit) || DEFAULT_PAGE_SIZE)));
  const cursor = decodeCursor(input.cursor || null);
  const adminEmails = ADMIN_EMAILS.map((email) => email.toLowerCase());

  const rows = await sql<AdminUserRow>`
    WITH page_users AS (
      SELECT u.*
      FROM users u
      WHERE (${search} = '' OR lower(u.name) LIKE ${searchPrefix} OR lower(u.email) LIKE ${searchPrefix})
        AND (${status} = '' OR u.account_status = ${status})
        AND (
          ${role} = ''
          OR (${role} = 'owner' AND EXISTS (
            SELECT 1 FROM venue_claims c
            WHERE c.user_id = u.id AND c.status = 'verified'
          ))
          OR (${role} = 'manager' AND EXISTS (
            SELECT 1 FROM venue_managers m WHERE m.user_id = u.id
          ))
          OR (${role} = 'admin' AND lower(u.email) = ANY(${adminEmails}::text[]))
        )
        AND (
          ${cursor.createdAt}::timestamptz IS NULL
          OR (u.created_at, u.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)
        )
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ${limit + 1}
    ),
    owner_counts AS (
      SELECT user_id, count(*) AS count FROM venue_claims
      WHERE status = 'verified' AND user_id IN (SELECT id FROM page_users)
      GROUP BY user_id
    ),
    manager_counts AS (
      SELECT user_id, count(DISTINCT venue_id) AS count FROM venue_managers
      WHERE user_id IN (SELECT id FROM page_users) GROUP BY user_id
    ),
    owned_lists AS (
      SELECT owner_user_id AS user_id, count(*) AS total,
        count(*) FILTER (WHERE system_key IS NULL) AS custom
      FROM happy_hour_lists
      WHERE owner_user_id IN (SELECT id FROM page_users)
      GROUP BY owner_user_id
    ),
    shared_lists AS (
      SELECT user_id, count(*) AS count FROM happy_hour_list_members
      WHERE user_id IN (SELECT id FROM page_users) GROUP BY user_id
    ),
    notification_settings AS (
      SELECT user_id, count(*) AS rules, sum(channels) AS channels
      FROM (
        SELECT user_id, (channel_email::int + channel_text::int) AS channels
        FROM alerts WHERE active AND user_id IN (SELECT id FROM page_users)
        UNION ALL
        SELECT user_id, (channel_email::int + channel_text::int) AS channels
        FROM venue_follows
        WHERE (happy_hour_alerts_enabled OR promotion_alerts_enabled)
          AND user_id IN (SELECT id FROM page_users)
        UNION ALL
        SELECT user_id, (channel_email::int + channel_text::int) AS channels
        FROM happy_hour_list_subscriptions
        WHERE user_id IN (SELECT id FROM page_users)
        UNION ALL
        SELECT id, 1 FROM users
        WHERE weekly_digest_opt_in AND id IN (SELECT id FROM page_users)
      ) settings GROUP BY user_id
    ),
    engagement AS (
      SELECT user_id, sum(session_count) AS sessions, sum(active_seconds) AS seconds
      FROM user_engagement_daily
      WHERE activity_date >= current_date - (${days}::integer - 1)
        AND user_id IN (SELECT id FROM page_users)
      GROUP BY user_id
    ),
    deliveries AS (
      SELECT user_id,
        sum(sent_count) FILTER (WHERE channel = 'email') AS email_sent,
        sum(delivered_count) FILTER (WHERE channel = 'email') AS email_delivered,
        sum(failed_count) FILTER (WHERE channel = 'email') AS email_failed,
        sum(sent_count) FILTER (WHERE channel = 'text') AS text_sent,
        sum(delivered_count) FILTER (WHERE channel = 'text') AS text_delivered,
        sum(failed_count) FILTER (WHERE channel = 'text') AS text_failed
      FROM user_notification_daily_metrics
      WHERE metric_date >= current_date - (${days}::integer - 1)
        AND user_id IN (SELECT id FROM page_users)
      GROUP BY user_id
    )
    SELECT
      pu.id, pu.name, pu.email, pu.account_status, pu.created_at, pu.last_activity_at,
      COALESCE(oc.count, 0) AS owner_venue_count,
      COALESCE(mc.count, 0) AS manager_venue_count,
      COALESCE(ol.total, 0) AS owned_list_count,
      COALESCE(ol.custom, 0) AS custom_list_count,
      COALESCE(sl.count, 0) AS shared_list_count,
      COALESCE(ns.rules, 0) AS notification_rule_count,
      COALESCE(ns.channels, 0) AS notification_channel_count,
      COALESCE(e.sessions, 0) AS session_count,
      COALESCE(e.seconds, 0) AS active_seconds,
      COALESCE(d.email_sent, 0) AS email_sent,
      COALESCE(d.email_delivered, 0) AS email_delivered,
      COALESCE(d.email_failed, 0) AS email_failed,
      COALESCE(d.text_sent, 0) AS text_sent,
      COALESCE(d.text_delivered, 0) AS text_delivered,
      COALESCE(d.text_failed, 0) AS text_failed
    FROM page_users pu
    LEFT JOIN owner_counts oc ON oc.user_id = pu.id
    LEFT JOIN manager_counts mc ON mc.user_id = pu.id
    LEFT JOIN owned_lists ol ON ol.user_id = pu.id
    LEFT JOIN shared_lists sl ON sl.user_id = pu.id
    LEFT JOIN notification_settings ns ON ns.user_id = pu.id
    LEFT JOIN engagement e ON e.user_id = pu.id
    LEFT JOIN deliveries d ON d.user_id = pu.id
    ORDER BY pu.created_at DESC, pu.id DESC`;

  const countRows = await sql<{ count: number | string }>`
    SELECT count(*) AS count FROM users u
    WHERE (${search} = '' OR lower(u.name) LIKE ${searchPrefix} OR lower(u.email) LIKE ${searchPrefix})
      AND (${status} = '' OR u.account_status = ${status})
      AND (
        ${role} = ''
        OR (${role} = 'owner' AND EXISTS (
          SELECT 1 FROM venue_claims c WHERE c.user_id = u.id AND c.status = 'verified'
        ))
        OR (${role} = 'manager' AND EXISTS (
          SELECT 1 FROM venue_managers m WHERE m.user_id = u.id
        ))
        OR (${role} = 'admin' AND lower(u.email) = ANY(${adminEmails}::text[]))
      )`;

  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  return {
    users: visible.map((row) => {
      const sessions = Number(row.session_count);
      const roles = [
        ...(adminEmails.includes(row.email.toLowerCase()) ? ['site_admin'] : []),
        ...(Number(row.owner_venue_count) ? ['restaurant_owner'] : []),
        ...(Number(row.manager_venue_count) ? ['restaurant_manager'] : []),
      ];
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        status: row.account_status,
        roles,
        createdAt: iso(row.created_at),
        lastActivityAt: iso(row.last_activity_at),
        restaurants: { owned: Number(row.owner_venue_count), managed: Number(row.manager_venue_count) },
        lists: {
          owned: Number(row.owned_list_count), custom: Number(row.custom_list_count), shared: Number(row.shared_list_count),
        },
        notifications: {
          rules: Number(row.notification_rule_count), enabledChannels: Number(row.notification_channel_count),
          email: { sent: Number(row.email_sent), delivered: Number(row.email_delivered), failed: Number(row.email_failed) },
          text: { sent: Number(row.text_sent), delivered: Number(row.text_delivered), failed: Number(row.text_failed) },
        },
        engagement: {
          sessions,
          averageSessionSeconds: averageSessionSeconds(Number(row.active_seconds), sessions),
        },
      };
    }),
    total: Number(countRows[0]?.count || 0),
    days,
    nextCursor: hasMore && visible.length ? encodeCursor(visible[visible.length - 1]) : null,
  };
}

export async function getAdminUserDetail(userId: string) {
  const [users, claims, managers, alerts, follows, listSubscriptions, lists, actions, deliveryTotals, dependencies] = await Promise.all([
    sql<any>`SELECT id, name, email, phone, account_status, created_at, updated_at, last_activity_at,
      deactivated_at, anonymized_at, weekly_digest_opt_in, sms_consent_at,
      location_analytics_consent_at, location_analytics_revoked_at
      FROM users WHERE id = ${userId}`,
    sql<any>`SELECT id, venue_id, status, verification_method, plan, created_at
      FROM venue_claims WHERE user_id = ${userId} ORDER BY created_at DESC`,
    sql<any>`SELECT id, venue_id, role, created_at
      FROM venue_managers WHERE user_id = ${userId} ORDER BY created_at DESC`,
    sql<any>`SELECT id, name, filters, alert_kinds, channel_email, channel_text, active, created_at
      FROM alerts WHERE user_id = ${userId} ORDER BY created_at DESC`,
    sql<any>`SELECT venue_id, happy_hour_alerts_enabled, promotion_alerts_enabled,
      channel_email, channel_text, created_at FROM venue_follows
      WHERE user_id = ${userId} ORDER BY created_at DESC`,
    sql<any>`SELECT subscription.list_id, lists.title, subscription.happy_hour_alerts_enabled,
      subscription.live_deal_alerts_enabled, subscription.channel_email, subscription.channel_text,
      subscription.created_at
      FROM happy_hour_list_subscriptions subscription
      JOIN happy_hour_lists lists ON lists.id = subscription.list_id
      WHERE subscription.user_id = ${userId} ORDER BY subscription.created_at DESC`,
    sql<any>`SELECT lists.id, lists.title, lists.system_key, lists.owner_user_id,
      CASE WHEN lists.owner_user_id = ${userId} THEN 'owner' ELSE members.role END AS role,
      (SELECT count(*) FROM happy_hour_list_items item WHERE item.list_id = lists.id) AS item_count,
      lists.created_at
      FROM happy_hour_lists lists
      LEFT JOIN happy_hour_list_members members ON members.list_id = lists.id AND members.user_id = ${userId}
      WHERE lists.owner_user_id = ${userId} OR members.user_id = ${userId}
      ORDER BY lists.created_at DESC`,
    sql<any>`SELECT action, reason, metadata, created_at FROM admin_user_actions
      WHERE target_user_id = ${userId} ORDER BY created_at DESC LIMIT 30`,
    sql<any>`SELECT channel, sum(sent_count) AS sent, sum(delivered_count) AS delivered,
      sum(failed_count) AS failed, sum(simulated_count) AS simulated
      FROM user_notification_daily_metrics WHERE user_id = ${userId} GROUP BY channel`,
    sql<any>`SELECT
      (SELECT count(*) FROM venue_claims WHERE user_id = ${userId} AND status = 'verified') AS verified_claims,
      (SELECT count(*) FROM happy_hour_lists WHERE owner_user_id = ${userId} AND system_key IS NULL) AS custom_lists`,
  ]);
  if (!users[0]) return null;
  const row = users[0];
  return {
    user: {
      id: row.id, name: row.name, email: row.email, phone: row.phone,
      status: row.account_status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      lastActivityAt: iso(row.last_activity_at), deactivatedAt: iso(row.deactivated_at),
      anonymizedAt: iso(row.anonymized_at), weeklyDigestOptIn: row.weekly_digest_opt_in,
      smsOptedIn: Boolean(row.sms_consent_at),
      locationAnalyticsOptIn: Boolean(row.location_analytics_consent_at && !row.location_analytics_revoked_at),
      isSiteAdmin: ADMIN_EMAILS.some((email) => email.toLowerCase() === row.email.toLowerCase()),
    },
    claims,
    managers,
    alerts,
    follows,
    listSubscriptions,
    lists,
    actions,
    deliveryTotals,
    dependencies: {
      verifiedVenueClaims: Number(dependencies[0]?.verified_claims || 0),
      customOwnedLists: Number(dependencies[0]?.custom_lists || 0),
    },
  };
}

export class AdminUserMutationError extends Error {
  constructor(message: string, public status = 422) {
    super(message);
  }
}

export async function mutateUserAccount(input: {
  actor: User;
  targetUserId: string;
  action: AdminAccountAction;
  reason?: string;
  transferToEmail?: string;
}) {
  return withTransaction(async (tx) => {
    const targets = await tx<any>`SELECT * FROM users WHERE id = ${input.targetUserId} FOR UPDATE`;
    const target = targets[0];
    if (!target) throw new AdminUserMutationError('User not found.', 404);
    const decision = accountMutationDecision({
      actor: { id: input.actor.id, email: input.actor.email, accountStatus: input.actor.accountStatus },
      target: { id: target.id, email: target.email, accountStatus: target.account_status },
      action: input.action,
      adminEmails: ADMIN_EMAILS,
    });
    if (decision === 'self') throw new AdminUserMutationError('You cannot change your own account status.', 403);
    if (decision === 'protected_admin') throw new AdminUserMutationError('Site administrator accounts are protected.', 403);
    if (decision === 'already_anonymized') throw new AdminUserMutationError('This account has already been anonymized.', 409);
    if (decision === 'invalid_transition') throw new AdminUserMutationError('That account status change is not valid.', 409);

    const reason = String(input.reason || '').trim().slice(0, 500);
    if (input.action === 'deactivate') {
      await tx`UPDATE users SET account_status = 'inactive', deactivated_at = now(), anonymized_at = NULL WHERE id = ${target.id}`;
      await tx`DELETE FROM sessions WHERE user_id = ${target.id}`;
      await tx`UPDATE user_activity_sessions SET ended_at = last_seen_at WHERE user_id = ${target.id} AND ended_at IS NULL`;
      await tx`INSERT INTO admin_user_actions (actor_user_id, target_user_id, action, reason)
        VALUES (${input.actor.id}, ${target.id}, 'account_deactivated', ${reason})`;
      return { status: 'inactive' as const };
    }

    if (input.action === 'reactivate') {
      await tx`UPDATE users SET account_status = 'active', deactivated_at = NULL, anonymized_at = NULL WHERE id = ${target.id}`;
      await tx`INSERT INTO admin_user_actions (actor_user_id, target_user_id, action, reason)
        VALUES (${input.actor.id}, ${target.id}, 'account_reactivated', ${reason})`;
      return { status: 'active' as const };
    }

    const dependencyRows = await tx<any>`SELECT
      (SELECT count(*) FROM venue_claims WHERE user_id = ${target.id} AND status = 'verified') AS verified_claims,
      (SELECT count(*) FROM happy_hour_lists WHERE owner_user_id = ${target.id} AND system_key IS NULL) AS custom_lists`;
    const dependencies = {
      verifiedVenueClaims: Number(dependencyRows[0]?.verified_claims || 0),
      customOwnedLists: Number(dependencyRows[0]?.custom_lists || 0),
    };
    let replacement: any = null;
    if (requiresOwnershipTransfer(dependencies)) {
      const email = String(input.transferToEmail || '').trim().toLowerCase();
      if (!email) throw new AdminUserMutationError('Choose an active user to receive owned restaurants and custom lists.');
      const replacements = await tx<any>`SELECT * FROM users WHERE lower(email) = lower(${email}) FOR UPDATE`;
      replacement = replacements[0];
      if (!replacement || replacement.account_status !== 'active' || replacement.id === target.id) {
        throw new AdminUserMutationError('The transfer recipient must be a different active user.');
      }
      const listCounts = await tx<any>`SELECT count(*) AS total,
        count(*) FILTER (WHERE system_key IS NULL) AS custom
        FROM happy_hour_lists WHERE owner_user_id = ${replacement.id}`;
      if (Number(listCounts[0].total) + dependencies.customOwnedLists > 10 || Number(listCounts[0].custom) + dependencies.customOwnedLists > 7) {
        throw new AdminUserMutationError('The transfer would put the recipient over the ten-list limit.');
      }

      await tx`DELETE FROM happy_hour_list_members member USING happy_hour_lists list
        WHERE list.owner_user_id = ${target.id} AND list.system_key IS NULL
          AND member.list_id = list.id AND member.user_id = ${replacement.id}`;
      await tx`UPDATE happy_hour_lists SET owner_user_id = ${replacement.id}
        WHERE owner_user_id = ${target.id} AND system_key IS NULL`;
      await tx`DELETE FROM venue_managers manager USING venue_claims claim
        WHERE claim.user_id = ${target.id} AND claim.status = 'verified'
          AND manager.venue_id = claim.venue_id AND manager.user_id = ${replacement.id}`;
      await tx`DELETE FROM venue_claims replacement_claim USING venue_claims target_claim
        WHERE target_claim.user_id = ${target.id} AND target_claim.status = 'verified'
          AND replacement_claim.user_id = ${replacement.id}
          AND replacement_claim.venue_id = target_claim.venue_id
          AND replacement_claim.id <> target_claim.id`;
      await tx`UPDATE venue_claims SET user_id = ${replacement.id}
        WHERE user_id = ${target.id} AND status = 'verified'`;
    }

    // Pending/denied claims are personal requests, not transferable ownership.
    await tx`DELETE FROM venue_claims WHERE user_id = ${target.id}`;
    await tx`DELETE FROM happy_hour_lists WHERE owner_user_id = ${target.id} AND system_key IS NOT NULL`;
    await tx`DELETE FROM happy_hour_list_members WHERE user_id = ${target.id}`;
    await tx`DELETE FROM happy_hour_list_subscriptions WHERE user_id = ${target.id}`;
    await tx`DELETE FROM venue_managers WHERE user_id = ${target.id}`;
    await tx`DELETE FROM alerts WHERE user_id = ${target.id}`;
    await tx`DELETE FROM venue_follows WHERE user_id = ${target.id}`;
    await tx`DELETE FROM sessions WHERE user_id = ${target.id}`;
    await tx`UPDATE user_activity_sessions SET ended_at = last_seen_at WHERE user_id = ${target.id} AND ended_at IS NULL`;
    await tx`UPDATE happy_hour_list_invites SET invited_by_user_id = NULL WHERE invited_by_user_id = ${target.id}`;
    await tx`UPDATE venue_manager_invites SET invited_by_owner_user_id = NULL WHERE invited_by_owner_user_id = ${target.id}`;

    const anonymousEmail = `deleted+${target.id}@anonymous.invalid`;
    await tx`UPDATE users SET
      name = 'Deleted user', email = ${anonymousEmail}, password_salt = NULL,
      password_hash = NULL, google_id = NULL, picture = '', share_id = ${crypto.randomBytes(16).toString('hex')},
      phone = '', sms_consent_at = NULL, weekly_digest_opt_in = false,
      default_list_id = NULL, metadata = '{}'::jsonb,
      account_status = 'anonymized', deactivated_at = COALESCE(deactivated_at, now()),
      anonymized_at = now(), location_analytics_consent_at = NULL,
      location_analytics_revoked_at = now()
      WHERE id = ${target.id}`;
    await tx`DELETE FROM user_area_activity_daily WHERE user_id = ${target.id}`;
    await tx`INSERT INTO admin_user_actions (actor_user_id, target_user_id, action, reason, metadata)
      VALUES (${input.actor.id}, ${target.id}, 'account_anonymized', ${reason}, ${JSON.stringify({
        transferredToUserId: replacement?.id || null,
        ...dependencies,
      })}::jsonb)`;
    return { status: 'anonymized' as const, transferredToUserId: replacement?.id || null };
  });
}

export async function listMarketAreaInsights(daysInput: unknown = 30) {
  const days = normalizeReportingDays(daysInput);
  const rows = await sql<any>`SELECT area_key, count(DISTINCT user_id) AS active_users,
    sum(event_count) AS uses, max(last_seen_at) AS last_activity_at
    FROM user_area_activity_daily
    WHERE activity_date >= current_date - (${days}::integer - 1)
    GROUP BY area_key ORDER BY active_users DESC, area_key`;
  return {
    days,
    merchantMinimumAudience: 20,
    areas: rows.map((row) => ({
      areaKey: row.area_key,
      label: marketAreaLabel(row.area_key),
      activeUsers: Number(row.active_users),
      uses: Number(row.uses),
      lastActivityAt: iso(row.last_activity_at),
      merchantReportable: Number(row.active_users) >= 20,
    })),
  };
}
