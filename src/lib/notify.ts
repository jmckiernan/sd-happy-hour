import { readUsers, readLiveOverrides, readNotificationLog, appendNotificationLog, getEnv, type NotificationLogEntry } from './kv';
import { getVenues, isVenueLive, alertMatchesVenue, formatTime, type Venue } from './venues';
import { sendEmail } from './email';
import { sendSms } from './sms';

// ---------------------------------------------------------------------------
// The alert matching + digest dispatch engine (see the alerts spec,
// "Notifications"). Called from two places with identical behavior:
//   - netlify/functions/dispatch-alerts.mts, on a schedule (the real thing)
//   - POST /api/admin/dispatch-alerts, an admin-only manual trigger for
//     testing without waiting on cron (see README-NOTIFICATIONS-SETUP.md)
//
// One call = one "batch window". Every currently-live venue is matched
// against every active alert; each user gets at most one consolidated
// email and one consolidated text per call, covering everything that
// matched — never one message per alert or per venue. That batching is
// what keeps SMS cost bounded (see the spec's "SMS cost control" math).
// ---------------------------------------------------------------------------

// Don't re-notify the same user about the same still-live venue more often
// than this — otherwise a happy hour that's live for 3 hours straight would
// re-trigger a message on every dispatch run for its whole duration.
const RENOTIFY_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 hours

const DEFAULT_SMS_DAILY_CAP = 2;

function smsDailyCap(): number {
  const raw = Number(getEnv('SMS_DAILY_CAP_PER_USER'));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SMS_DAILY_CAP;
}

function logId(): string {
  return `log_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[char]);
}

function buildEmailHtml(userName: string, venues: Venue[]): string {
  const items = venues
    .map((v) => `<li><strong>${escapeHtml(v.name)}</strong> — ${escapeHtml(v.neighborhood)} — ${formatTime(v.startTime)}–${formatTime(v.endTime)}. ${escapeHtml(v.deals.slice(0, 2).join(', '))}</li>`)
    .join('');
  return `<p>Hi ${escapeHtml(userName)},</p><p>These happy hours from your alerts are live right now:</p><ul>${items}</ul><p><a href="https://sdhappyhours.com/account/#section-alerts">Manage your alerts</a></p>`;
}

// Kept to a single SMS segment (~160 chars) — see the spec's SMS cost
// control section on why multi-segment messages are worth avoiding.
function buildSmsBody(venues: Venue[]): string {
  const names = venues.slice(0, 3).map((v) => v.name).join(', ');
  const extra = venues.length > 3 ? ` +${venues.length - 3} more` : '';
  return `Live now: ${names}${extra}. sdhappyhours.com`;
}

export interface DispatchSummary {
  liveVenueCount: number;
  usersNotified: number;
  emailsSent: number;
  textsSent: number;
  // true if either provider isn't configured yet, so at least one send in
  // this run was logged/counted but not actually delivered — see
  // email.ts/sms.ts's local-fallback behavior.
  simulated: boolean;
}

export async function runAlertDispatch(): Promise<DispatchSummary> {
  const now = new Date();
  const nowIso = now.toISOString();
  const [users, overrides, log] = await Promise.all([readUsers(), readLiveOverrides(), readNotificationLog()]);
  const liveVenues = getVenues().filter((v) => isVenueLive(v, overrides, now));

  const summary: DispatchSummary = { liveVenueCount: liveVenues.length, usersNotified: 0, emailsSent: 0, textsSent: 0, simulated: false };
  if (!liveVenues.length) return summary;

  const cooldownCutoff = now.getTime() - RENOTIFY_COOLDOWN_MS;
  const recentlyNotified = new Set(
    log.filter((entry) => new Date(entry.sentAt).getTime() >= cooldownCutoff).map((entry) => `${entry.userId}:${entry.venueId}:${entry.channel}`)
  );

  // Counts *distinct sends* today per user, not venues-per-send — a
  // 3-venue digest is one text, not three, against the daily cap. Every
  // entry from one dispatch run shares the same sentAt (computed once,
  // above), so grouping by sentAt is a cheap way to count sends without a
  // separate log shape just for this.
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const textSendTimestampsByUser = new Map<string, Set<string>>();
  for (const entry of log) {
    if (entry.channel !== 'text' || new Date(entry.sentAt).getTime() < dayStart.getTime()) continue;
    if (!textSendTimestampsByUser.has(entry.userId)) textSendTimestampsByUser.set(entry.userId, new Set());
    textSendTimestampsByUser.get(entry.userId)!.add(entry.sentAt);
  }

  const cap = smsDailyCap();
  const newLogEntries: NotificationLogEntry[] = [];
  let anySimulated = false;

  for (const user of users) {
    const alerts = (user.alerts || []).filter((alert) => alert.active);
    if (!alerts.length) continue;

    const matchedVenues = new Map<number, Venue>();
    let wantsEmail = false;
    let wantsText = false;
    for (const alert of alerts) {
      const matches = liveVenues.filter((venue) => alertMatchesVenue(alert.filters, venue));
      if (!matches.length) continue;
      for (const venue of matches) matchedVenues.set(venue.id, venue);
      if (alert.channels.email) wantsEmail = true;
      if (alert.channels.text) wantsText = true;
    }
    if (!matchedVenues.size) continue;

    const emailVenues = wantsEmail
      ? [...matchedVenues.values()].filter((venue) => !recentlyNotified.has(`${user.id}:${venue.id}:email`))
      : [];

    const canText = wantsText && Boolean(user.phone) && Boolean(user.smsConsentAt);
    const alreadySentToday = textSendTimestampsByUser.get(user.id)?.size || 0;
    const textVenues = canText && alreadySentToday < cap
      ? [...matchedVenues.values()].filter((venue) => !recentlyNotified.has(`${user.id}:${venue.id}:text`))
      : [];

    let notifiedThisUser = false;

    if (emailVenues.length) {
      const subject = emailVenues.length === 1 ? `${emailVenues[0].name} is live now` : `${emailVenues.length} happy hours are live now`;
      const result = await sendEmail(user.email, subject, buildEmailHtml(user.name, emailVenues));
      if (result.simulated) anySimulated = true;
      summary.emailsSent += 1;
      notifiedThisUser = true;
      for (const venue of emailVenues) newLogEntries.push({ id: logId(), userId: user.id, venueId: venue.id, channel: 'email', sentAt: nowIso });
    }

    if (textVenues.length) {
      const result = await sendSms(user.phone!, buildSmsBody(textVenues));
      if (result.simulated) anySimulated = true;
      summary.textsSent += 1;
      notifiedThisUser = true;
      for (const venue of textVenues) newLogEntries.push({ id: logId(), userId: user.id, venueId: venue.id, channel: 'text', sentAt: nowIso });
    }

    if (notifiedThisUser) summary.usersNotified += 1;
  }

  await appendNotificationLog(newLogEntries);
  summary.simulated = anySimulated;
  return summary;
}
