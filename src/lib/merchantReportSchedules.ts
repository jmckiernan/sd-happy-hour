import { sql, type QueryExecutor } from './db';
import { sendEmail } from './email';
import { captureMerchantEvent } from './merchantAnalytics';
import { getMerchantReportData, resolveMerchantReportRange } from './merchantReporting';
import { hasMerchantReportingAccess } from './merchantEntitlements';
import { getSanDiegoParts, parseSanDiegoLocalDateTime } from './sanDiegoTime';
import { getVenueAccess, getVenueOwner } from './venueUsers';
import { getUserById } from './store';
import { isAdminEmail } from './adminIdentity';

export type MerchantReportFrequency = 'weekly' | 'monthly';

export interface MerchantReportSchedule {
  id: string;
  venueId: number;
  userId: string;
  recipientEmail: string;
  frequency: MerchantReportFrequency;
  dayOfWeek: number;
  dayOfMonth: number;
  sendHourLocal: number;
  enabled: boolean;
  nextSendAt: string;
  lastSentAt: string | null;
}

interface ScheduleRow {
  id: string; venue_id: number; user_id: string; recipient_email: string;
  frequency: MerchantReportFrequency; day_of_week: number; day_of_month: number;
  send_hour_local: number; enabled: boolean; next_send_at: Date | string;
  last_sent_at: Date | string | null;
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function mapSchedule(row: ScheduleRow): MerchantReportSchedule {
  return {
    id: row.id,
    venueId: row.venue_id,
    userId: row.user_id,
    recipientEmail: row.recipient_email,
    frequency: row.frequency,
    dayOfWeek: row.day_of_week,
    dayOfMonth: row.day_of_month,
    sendHourLocal: row.send_hour_local,
    enabled: row.enabled,
    nextSendAt: iso(row.next_send_at)!,
    lastSentAt: iso(row.last_sent_at),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function calendarKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function addCalendarDays(parts: { year: number; month: number; day: number }, amount: number) {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
};

export function nextMerchantReportSendAt(input: {
  frequency: MerchantReportFrequency;
  dayOfWeek?: number;
  dayOfMonth?: number;
  sendHourLocal?: number;
  after?: Date;
}): Date {
  const after = input.after ?? new Date();
  const hour = Math.floor(input.sendHourLocal ?? 8);
  if (hour < 0 || hour > 23) throw new RangeError('Send hour must be between 0 and 23.');
  const parts = getSanDiegoParts(after);
  let target: { year: number; month: number; day: number };
  if (input.frequency === 'weekly') {
    const weekday = Math.floor(input.dayOfWeek ?? 1);
    if (weekday < 0 || weekday > 6) throw new RangeError('Weekly report day must be between Sunday and Saturday.');
    const offset = (weekday - WEEKDAY_INDEX[parts.weekday] + 7) % 7;
    target = addCalendarDays(parts, offset);
    let instant = parseSanDiegoLocalDateTime(`${calendarKey(target.year, target.month, target.day)}T${pad(hour)}:00`, { disambiguation: 'earlier' });
    if (!instant || instant.getTime() <= after.getTime()) {
      target = addCalendarDays(target, 7);
      instant = parseSanDiegoLocalDateTime(`${calendarKey(target.year, target.month, target.day)}T${pad(hour)}:00`, { disambiguation: 'earlier' });
    }
    if (!instant) throw new RangeError('Could not resolve the next weekly report time.');
    return instant;
  }
  const day = Math.floor(input.dayOfMonth ?? 1);
  if (day < 1 || day > 28) throw new RangeError('Monthly report day must be between 1 and 28.');
  target = { year: parts.year, month: parts.month, day };
  let instant = parseSanDiegoLocalDateTime(`${calendarKey(target.year, target.month, day)}T${pad(hour)}:00`, { disambiguation: 'earlier' });
  if (!instant || instant.getTime() <= after.getTime()) {
    const nextMonth = new Date(Date.UTC(parts.year, parts.month, 1));
    target = { year: nextMonth.getUTCFullYear(), month: nextMonth.getUTCMonth() + 1, day };
    instant = parseSanDiegoLocalDateTime(`${calendarKey(target.year, target.month, day)}T${pad(hour)}:00`, { disambiguation: 'earlier' });
  }
  if (!instant) throw new RangeError('Could not resolve the next monthly report time.');
  return instant;
}

export async function getMerchantReportSchedule(
  venueId: number,
  userId: string,
  executor: QueryExecutor = sql
): Promise<MerchantReportSchedule | null> {
  const rows = await executor<ScheduleRow>`
    SELECT * FROM merchant_report_schedules WHERE venue_id = ${venueId} AND user_id = ${userId}`;
  return rows[0] ? mapSchedule(rows[0]) : null;
}

export async function saveMerchantReportSchedule(input: {
  venueId: number;
  userId: string;
  recipientEmail: string;
  frequency: MerchantReportFrequency;
  dayOfWeek?: number;
  dayOfMonth?: number;
  sendHourLocal?: number;
  enabled?: boolean;
}, executor: QueryExecutor = sql): Promise<MerchantReportSchedule> {
  if (input.frequency !== 'weekly' && input.frequency !== 'monthly') throw new RangeError('Choose weekly or monthly reports.');
  const dayOfWeek = Math.floor(input.dayOfWeek ?? 1);
  const dayOfMonth = Math.floor(input.dayOfMonth ?? 1);
  const sendHourLocal = Math.floor(input.sendHourLocal ?? 8);
  const nextSendAt = nextMerchantReportSendAt({
    frequency: input.frequency, dayOfWeek, dayOfMonth, sendHourLocal,
  }).toISOString();
  const rows = await executor<ScheduleRow>`
    INSERT INTO merchant_report_schedules (
      venue_id, user_id, recipient_email, frequency, day_of_week, day_of_month,
      send_hour_local, enabled, next_send_at
    ) VALUES (
      ${input.venueId}, ${input.userId}, ${input.recipientEmail.trim().toLowerCase()},
      ${input.frequency}, ${dayOfWeek}, ${dayOfMonth}, ${sendHourLocal},
      ${input.enabled ?? true}, ${nextSendAt}
    )
    ON CONFLICT (venue_id, user_id) DO UPDATE SET
      recipient_email = EXCLUDED.recipient_email, frequency = EXCLUDED.frequency,
      day_of_week = EXCLUDED.day_of_week, day_of_month = EXCLUDED.day_of_month,
      send_hour_local = EXCLUDED.send_hour_local, enabled = EXCLUDED.enabled,
      next_send_at = EXCLUDED.next_send_at
    RETURNING *`;
  return mapSchedule(rows[0]);
}

export async function deleteMerchantReportSchedule(
  venueId: number,
  userId: string,
  executor: QueryExecutor = sql
): Promise<boolean> {
  const rows = await executor<{ id: string }>`
    DELETE FROM merchant_report_schedules WHERE venue_id = ${venueId} AND user_id = ${userId} RETURNING id`;
  return Boolean(rows[0]);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[character]);
}

export function merchantReportEmailHtml(report: Awaited<ReturnType<typeof getMerchantReportData>>): string {
  const metric = (label: string, value: string, detail: string) => `
    <td style="padding:8px;width:50%;vertical-align:top">
      <div style="background:#fff;border:1px solid #eadff0;border-radius:12px;padding:16px">
        <div style="color:#6b5f75;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">${escapeHtml(label)}</div>
        <div style="color:#201238;font-size:28px;font-weight:800;margin:5px 0">${escapeHtml(value)}</div>
        <div style="color:#6b5f75;font-size:12px">${escapeHtml(detail)}</div>
      </div>
    </td>`;
  return `<!doctype html><html><body style="background:#fff7ed;margin:0;padding:0;font-family:Arial,sans-serif;color:#201238">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%">
        <tr><td style="background:#201238;border-radius:18px 18px 0 0;padding:28px">
          <div style="color:#f4c05c;font-size:11px;font-weight:800;letter-spacing:.14em">SD HAPPY HOURS</div>
          <h1 style="color:#fff;font-size:27px;line-height:1.15;margin:8px 0">${escapeHtml(report.venue.name)}</h1>
          <div style="color:#ddd4e7;font-size:13px">Merchant performance - ${escapeHtml(report.range.label)}</div>
        </td></tr>
        <tr><td style="background:#fff7ed;padding:12px 0"><table role="presentation" width="100%"><tr>
          ${metric('Unique visits', String(report.summary.uniqueVisits), `${report.summary.totalViews} total views`)}
          ${metric('Website CTR', `${report.summary.websiteRate}%`, `${report.summary.websiteClicks} website clicks`)}
        </tr><tr>
          ${metric('Directions rate', `${report.summary.directionsRate}%`, `${report.summary.directionsClicks} map opens`)}
          ${metric('Campaign engagement', `${report.summary.campaignEngagementRate}%`, `${report.summary.promotionClicks} promotion clicks`)}
        </tr></table></td></tr>
        <tr><td style="background:#fff;border-radius:14px;padding:24px">
          <h2 style="font-size:17px;margin:0 0 12px">Audience now</h2>
          <p style="color:#6b5f75;font-size:14px;line-height:1.6;margin:0">${report.audience.currentSavers} savers &nbsp;|&nbsp; ${report.audience.currentFollowers} followers &nbsp;|&nbsp; ${report.audience.currentAlertSubscribers} alert subscribers</p>
          <a href="https://happyhoursd.com/restaurant/reports/?venueId=${report.venue.id}" style="background:#ff6b35;border-radius:999px;color:#fff;display:inline-block;font-size:14px;font-weight:800;margin-top:20px;padding:12px 20px;text-decoration:none">Open full report</a>
        </td></tr>
        <tr><td style="color:#6b5f75;font-size:11px;line-height:1.5;padding:18px 12px;text-align:center">${escapeHtml(report.definitions.revenueProxy)} You can update report delivery from the merchant reports page.</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

export interface MerchantReportDispatchSummary {
  due: number;
  sent: number;
  simulated: number;
  failed: number;
  disabled: number;
}

export async function runMerchantReportDispatch(now = new Date()): Promise<MerchantReportDispatchSummary> {
  const due = await sql<ScheduleRow>`
    SELECT * FROM merchant_report_schedules
    WHERE enabled AND next_send_at <= ${now.toISOString()}
    ORDER BY next_send_at, id LIMIT 50`;
  const summary: MerchantReportDispatchSummary = { due: due.length, sent: 0, simulated: 0, failed: 0, disabled: 0 };
  for (const row of due) {
    const schedule = mapSchedule(row);
    const nextSendAt = nextMerchantReportSendAt({
      frequency: schedule.frequency,
      dayOfWeek: schedule.dayOfWeek,
      dayOfMonth: schedule.dayOfMonth,
      sendHourLocal: schedule.sendHourLocal,
      after: now,
    }).toISOString();
    const [access, scheduleUser, venueOwner] = await Promise.all([
      getVenueAccess(schedule.userId, schedule.venueId).catch(() => null),
      getUserById(schedule.userId).catch(() => null),
      getVenueOwner(schedule.venueId).catch(() => null),
    ]);
    const siteAdmin = isAdminEmail(scheduleUser?.email);
    const paid = await hasMerchantReportingAccess(schedule.venueId).catch(() => false);
    if (!venueOwner || (!siteAdmin && (!access || (access.role !== 'owner' && access.role !== 'full_admin'))) || (!siteAdmin && !paid)) {
      await sql`UPDATE merchant_report_schedules SET enabled = false WHERE id = ${schedule.id}`;
      summary.disabled += 1;
      continue;
    }
    const range = resolveMerchantReportRange({ preset: schedule.frequency === 'weekly' ? '7d' : '30d', now });
    try {
      const report = await getMerchantReportData({
        venueId: schedule.venueId,
        ownerUserId: venueOwner.user_id,
        accessibleVenues: [{ venueId: schedule.venueId, ownerUserId: venueOwner.user_id }],
        range,
      });
      const result = await sendEmail(
        schedule.recipientEmail,
        `${report.venue.name}: ${report.range.label} performance report`,
        merchantReportEmailHtml(report)
      );
      const status = result.simulated ? 'simulated' : 'sent';
      await sql`
        INSERT INTO merchant_report_deliveries (
          schedule_id, venue_id, recipient_email, range_starts_at, range_ends_at, status
        ) VALUES (
          ${schedule.id}, ${schedule.venueId}, ${schedule.recipientEmail}, ${range.start}, ${range.end}, ${status}
        )`;
      await sql`
        UPDATE merchant_report_schedules SET last_sent_at = ${now.toISOString()}, next_send_at = ${nextSendAt}
        WHERE id = ${schedule.id}`;
      await captureMerchantEvent({
        eventName: 'report_email_sent', venueId: schedule.venueId, userId: schedule.userId,
        authenticated: true, source: 'scheduled_report', properties: { frequency: schedule.frequency, simulated: result.simulated },
      });
      if (result.simulated) summary.simulated += 1; else summary.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      await sql`
        INSERT INTO merchant_report_deliveries (
          schedule_id, venue_id, recipient_email, range_starts_at, range_ends_at, status, provider_error
        ) VALUES (
          ${schedule.id}, ${schedule.venueId}, ${schedule.recipientEmail}, ${range.start}, ${range.end}, 'failed', ${message}
        )`;
      await sql`UPDATE merchant_report_schedules SET next_send_at = ${new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString()} WHERE id = ${schedule.id}`;
      summary.failed += 1;
    }
  }
  return summary;
}
