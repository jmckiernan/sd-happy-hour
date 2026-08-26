import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../lib/api';
import { authorizeMerchantReport } from '../../../../lib/merchantEntitlements';
import {
  deleteMerchantReportSchedule,
  getMerchantReportSchedule,
  saveMerchantReportSchedule,
} from '../../../../lib/merchantReportSchedules';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies }) => {
  const venueId = Number(url.searchParams.get('venueId'));
  const authorization = await authorizeMerchantReport(cookies, venueId);
  if (!authorization) return errorJson(['Paid owner or admin reporting access is required.'], 403);
  return json({ schedule: await getMerchantReportSchedule(venueId, authorization.userId) });
};

export const PUT: APIRoute = async ({ request, cookies }) => {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  const venueId = Number(body.venueId);
  const authorization = await authorizeMerchantReport(cookies, venueId);
  if (!authorization) return errorJson(['Paid owner or admin reporting access is required.'], 403);
  try {
    const schedule = await saveMerchantReportSchedule({
      venueId,
      userId: authorization.userId,
      recipientEmail: authorization.email,
      frequency: body.frequency === 'monthly' ? 'monthly' : 'weekly',
      dayOfWeek: Number(body.dayOfWeek ?? 1),
      dayOfMonth: Number(body.dayOfMonth ?? 1),
      sendHourLocal: Number(body.sendHourLocal ?? 8),
      enabled: body.enabled !== false,
    });
    return json({ schedule });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not save report schedule.'], 422);
  }
};

export const DELETE: APIRoute = async ({ url, cookies }) => {
  const venueId = Number(url.searchParams.get('venueId'));
  const authorization = await authorizeMerchantReport(cookies, venueId);
  if (!authorization) return errorJson(['Paid owner or admin reporting access is required.'], 403);
  return json({ removed: await deleteMerchantReportSchedule(venueId, authorization.userId) });
};
