import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../lib/admins';
import { json, errorJson } from '../../../lib/api';
import { runAlertDispatch } from '../../../lib/notify';

export const prerender = false;

// Manual "send now" trigger for testing the alert dispatch pipeline
// without waiting on the scheduled function's 15-minute cadence (see
// netlify/functions/dispatch-alerts.mts, which calls the exact same
// runAlertDispatch()). Admin-only since it can trigger real emails/texts
// once providers are configured.
export const POST: APIRoute = async ({ cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  try {
    const summary = await runAlertDispatch();
    return json(summary);
  } catch (err: any) {
    return errorJson([`Dispatch failed: ${err.message}`], 500);
  }
};
