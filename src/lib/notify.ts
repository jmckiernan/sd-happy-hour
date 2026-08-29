import {
  deleteExpiredSessions,
  getLiveOverrides,
  insertNotifications,
  listActiveAlertsForDispatch,
  listNotificationsForEventKeys,
  listNotificationsSince,
  pruneNotificationLog,
  type AlertFilters,
  type NotificationLogEntry,
} from './store';
import { listActiveListSubscriptionVenues } from './savedLists';
import { getEnv } from './env';
import { isVenueLive, alertMatchesVenue, formatTime, type Venue } from './venues';
import { getPublicMergedVenues } from './venueContent';
import { listLivePromotionCampaigns, type PromotionCampaign } from './promotionRepo';
import { getPromotionEventKey } from './notificationEvents';
import { sendEmail } from './email';
import { sendSms } from './sms';
import { pruneProductAnalyticsData, recordNotificationMetric } from './productAnalytics';

const RENOTIFY_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const DEFAULT_SMS_DAILY_CAP = 2;

async function safelyRecordNotificationMetric(input: {
  userId: string;
  channel: 'email' | 'text';
  status: 'sent' | 'delivered' | 'failed' | 'simulated';
}) {
  try {
    await recordNotificationMetric(input);
  } catch (error) {
    console.error('[notification metric failed]', input.userId, input.channel, error);
  }
}

function smsDailyCap(): number {
  const raw = Number(getEnv('SMS_DAILY_CAP_PER_USER'));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SMS_DAILY_CAP;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[char]);
}

interface PromotionMatch {
  eventKey: string;
  promotion: PromotionCampaign;
  venue: Venue;
}

function buildEmailHtml(userName: string, happyHours: Venue[], promotions: PromotionMatch[]): string {
  const happyHourSection = happyHours.length
    ? `<h2>Happy hours live now</h2><ul>${happyHours.map((venue) =>
        `<li><strong>${escapeHtml(venue.name)}</strong> — ${escapeHtml(venue.neighborhood)} — ${formatTime(venue.startTime)}–${formatTime(venue.endTime)}. ${escapeHtml(venue.deals.slice(0, 2).join(', '))}</li>`
      ).join('')}</ul>`
    : '';
  const promotionSection = promotions.length
    ? `<h2>Live deals</h2><ul>${promotions.map(({ venue, promotion }) =>
        `<li><strong>${escapeHtml(venue.name)}</strong> — ${escapeHtml(promotion.title || promotion.description || 'A new deal is live')}</li>`
      ).join('')}</ul>`
    : '';
  return `<p>Hi ${escapeHtml(userName)},</p>${happyHourSection}${promotionSection}<p><a href="https://happyhoursd.com/account/#section-lists">Manage your list alerts</a></p>`;
}

function buildSmsBody(happyHours: Venue[], promotions: PromotionMatch[]): string {
  const names = [...happyHours.map((venue) => venue.name), ...promotions.map(({ venue }) => venue.name)]
    .filter((name, index, values) => values.indexOf(name) === index);
  const shown = names.slice(0, 3).join(', ');
  const extra = names.length > 3 ? ` +${names.length - 3} more` : '';
  const prefix = promotions.length && !happyHours.length ? 'Live deals' : 'Live now';
  return `${prefix}: ${shown}${extra}. happyhoursd.com`;
}

export interface DispatchSummary {
  liveVenueCount: number;
  liveDealCount: number;
  usersNotified: number;
  emailsSent: number;
  textsSent: number;
  simulated: boolean;
}

interface UserAlertGroup {
  userId: string;
  userName: string;
  userEmail: string;
  userPhone: string;
  userSmsConsentAt: string | null;
  filters: Array<{ filters: AlertFilters; email: boolean; text: boolean }>;
  listSubscriptions: Map<number, {
    happyHourEmail: boolean;
    happyHourText: boolean;
    liveDealsEmail: boolean;
    liveDealsText: boolean;
  }>;
}

function ensureUserGroup(
  groups: Map<string, UserAlertGroup>,
  identity: {
    userId: string;
    userName: string;
    userEmail: string;
    userPhone: string;
    userSmsConsentAt: string | null;
  }
): UserAlertGroup {
  let group = groups.get(identity.userId);
  if (!group) {
    group = { ...identity, filters: [], listSubscriptions: new Map() };
    groups.set(identity.userId, group);
  }
  return group;
}

export async function runAlertDispatch(): Promise<DispatchSummary> {
  const now = new Date();
  const nowIso = now.toISOString();
  const [activeAlerts, listSubscriptions, overrides, venues, livePromotions] = await Promise.all([
    listActiveAlertsForDispatch(),
    listActiveListSubscriptionVenues(),
    getLiveOverrides(),
    // Public-only: never alert someone about a venue they can't find on the site.
    getPublicMergedVenues(),
    listLivePromotionCampaigns(nowIso),
  ]);
  const liveVenues = venues.filter((venue) => isVenueLive(venue, overrides, now));
  const venueById = new Map(venues.map((venue) => [venue.id, venue]));
  const promotionMatches = livePromotions.flatMap((promotion) => {
    const venue = venueById.get(promotion.venueId);
    return venue ? [{ eventKey: getPromotionEventKey(promotion), promotion, venue }] : [];
  });

  const summary: DispatchSummary = {
    liveVenueCount: liveVenues.length,
    liveDealCount: promotionMatches.length,
    usersNotified: 0,
    emailsSent: 0,
    textsSent: 0,
    simulated: false,
  };

  await Promise.all([deleteExpiredSessions(), pruneNotificationLog(7), pruneProductAnalyticsData(90)]);
  if (!liveVenues.length && !promotionMatches.length) return summary;

  const usersById = new Map<string, UserAlertGroup>();
  for (const row of activeAlerts) {
    ensureUserGroup(usersById, row).filters.push({
      filters: row.filters,
      email: row.channelEmail,
      text: row.channelText,
    });
  }
  for (const row of listSubscriptions) {
    const group = ensureUserGroup(usersById, row);
    const current = group.listSubscriptions.get(row.venueId);
    group.listSubscriptions.set(row.venueId, {
      happyHourEmail: Boolean(current?.happyHourEmail || (row.happyHour && row.email)),
      happyHourText: Boolean(current?.happyHourText || (row.happyHour && row.text)),
      liveDealsEmail: Boolean(current?.liveDealsEmail || (row.liveDeals && row.email)),
      liveDealsText: Boolean(current?.liveDealsText || (row.liveDeals && row.text)),
    });
  }

  const cooldownCutoff = now.getTime() - RENOTIFY_COOLDOWN_MS;
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const sinceMs = Math.min(cooldownCutoff, dayStart.getTime());
  const [recentLog, promotionLog] = await Promise.all([
    listNotificationsSince(new Date(sinceMs).toISOString()),
    listNotificationsForEventKeys(promotionMatches.map((match) => match.eventKey)),
  ]);
  const recentlyNotified = new Set(
    recentLog
      .filter((entry) => entry.notificationKind === 'happy_hour' && new Date(entry.sentAt).getTime() >= cooldownCutoff)
      .map((entry) => `${entry.userId}:${entry.venueId}:${entry.channel}`)
  );
  const deliveredPromotions = new Set(
    promotionLog.map((entry) => `${entry.userId}:${entry.eventKey}:${entry.channel}`)
  );

  const textSendTimestampsByUser = new Map<string, Set<string>>();
  for (const entry of recentLog) {
    if (entry.channel !== 'text' || new Date(entry.sentAt).getTime() < dayStart.getTime()) continue;
    if (!textSendTimestampsByUser.has(entry.userId)) textSendTimestampsByUser.set(entry.userId, new Set());
    textSendTimestampsByUser.get(entry.userId)!.add(entry.sentAt);
  }

  const cap = smsDailyCap();
  const newLogEntries: NotificationLogEntry[] = [];
  let anySimulated = false;

  for (const user of usersById.values()) {
    const emailHappy = new Map<number, Venue>();
    const textHappy = new Map<number, Venue>();
    const emailPromotions = new Map<string, PromotionMatch>();
    const textPromotions = new Map<string, PromotionMatch>();

    for (const alert of user.filters) {
      for (const venue of liveVenues.filter((candidate) => alertMatchesVenue(alert.filters, candidate))) {
        if (alert.email) emailHappy.set(venue.id, venue);
        if (alert.text) textHappy.set(venue.id, venue);
      }
    }
    for (const [venueId, subscription] of user.listSubscriptions) {
      if (subscription.happyHourEmail || subscription.happyHourText) {
        const venue = liveVenues.find((candidate) => candidate.id === venueId);
        if (venue && subscription.happyHourEmail) emailHappy.set(venue.id, venue);
        if (venue && subscription.happyHourText) textHappy.set(venue.id, venue);
      }
      if (subscription.liveDealsEmail || subscription.liveDealsText) {
        for (const promotion of promotionMatches.filter((match) => match.venue.id === venueId)) {
          if (subscription.liveDealsEmail) emailPromotions.set(promotion.eventKey, promotion);
          if (subscription.liveDealsText) textPromotions.set(promotion.eventKey, promotion);
        }
      }
    }

    const emailHappyValues = [...emailHappy.values()].filter(
      (venue) => !recentlyNotified.has(`${user.userId}:${venue.id}:email`)
    );
    const textHappyValues = [...textHappy.values()].filter(
      (venue) => !recentlyNotified.has(`${user.userId}:${venue.id}:text`)
    );
    const emailPromotionValues = [...emailPromotions.values()].filter(
      (match) => !deliveredPromotions.has(`${user.userId}:${match.eventKey}:email`)
    );
    const textPromotionValues = [...textPromotions.values()].filter(
      (match) => !deliveredPromotions.has(`${user.userId}:${match.eventKey}:text`)
    );

    let notifiedThisUser = false;
    if (emailHappyValues.length || emailPromotionValues.length) {
      const total = emailHappyValues.length + emailPromotionValues.length;
      const subject = total === 1
        ? `${emailHappyValues[0]?.name || emailPromotionValues[0]?.venue.name} is live now`
        : `${total} spots from your alerts are live now`;
      try {
        const result = await sendEmail(
          user.userEmail,
          subject,
          buildEmailHtml(user.userName, emailHappyValues, emailPromotionValues)
        );
        if (result.simulated) anySimulated = true;
        await safelyRecordNotificationMetric({
          userId: user.userId, channel: 'email', status: result.simulated ? 'simulated' : 'sent',
        });
        summary.emailsSent += 1;
        notifiedThisUser = true;
        for (const venue of emailHappyValues) {
          newLogEntries.push({ userId: user.userId, venueId: venue.id, channel: 'email', notificationKind: 'happy_hour', eventKey: null, sentAt: nowIso });
        }
        for (const match of emailPromotionValues) {
          newLogEntries.push({ userId: user.userId, venueId: match.venue.id, channel: 'email', notificationKind: 'promotion', eventKey: match.eventKey, sentAt: nowIso });
        }
      } catch (error) {
        await safelyRecordNotificationMetric({ userId: user.userId, channel: 'email', status: 'failed' });
        console.error('[alert email failed]', user.userId, error);
      }
    }

    const canText = Boolean(user.userPhone) && Boolean(user.userSmsConsentAt);
    const alreadySentToday = textSendTimestampsByUser.get(user.userId)?.size || 0;
    if (canText && alreadySentToday < cap && (textHappyValues.length || textPromotionValues.length)) {
      try {
        const result = await sendSms(user.userPhone, buildSmsBody(textHappyValues, textPromotionValues));
        if (result.simulated) anySimulated = true;
        await safelyRecordNotificationMetric({
          userId: user.userId, channel: 'text', status: result.simulated ? 'simulated' : 'sent',
        });
        summary.textsSent += 1;
        notifiedThisUser = true;
        for (const venue of textHappyValues) {
          newLogEntries.push({ userId: user.userId, venueId: venue.id, channel: 'text', notificationKind: 'happy_hour', eventKey: null, sentAt: nowIso });
        }
        for (const match of textPromotionValues) {
          newLogEntries.push({ userId: user.userId, venueId: match.venue.id, channel: 'text', notificationKind: 'promotion', eventKey: match.eventKey, sentAt: nowIso });
        }
      } catch (error) {
        await safelyRecordNotificationMetric({ userId: user.userId, channel: 'text', status: 'failed' });
        console.error('[alert text failed]', user.userId, error);
      }
    }
    if (notifiedThisUser) summary.usersNotified += 1;
  }

  await insertNotifications(newLogEntries);
  summary.simulated = anySimulated;
  return summary;
}
