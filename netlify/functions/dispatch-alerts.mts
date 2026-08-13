import type { Config } from '@netlify/functions';
import { runAlertDispatch } from '../../src/lib/notify';

// Runs on a schedule (see netlify.toml) to check for live happy hours and
// send matching alerts. This is a *standalone* Netlify Function rather than
// an Astro API route — Astro/Netlify's on-demand functions don't support
// Netlify's `schedule` config, only plain functions in netlify/functions/
// do (see README-NOTIFICATIONS-SETUP.md for why, and for the manual
// "send now" admin trigger at /api/admin/dispatch-alerts that exercises the
// exact same runAlertDispatch() without waiting on cron).
//
// Because this isn't built through Astro/Vite, `import.meta.env` isn't
// populated here — everything runAlertDispatch() touches reads env vars via
// env.ts's getEnv() helper, which checks `process.env` too for exactly this
// reason (including db.ts's DATABASE_URL lookup).
export default async (): Promise<Response> => {
  try {
    const summary = await runAlertDispatch();
    console.log('[dispatch-alerts]', JSON.stringify(summary));
    return new Response(JSON.stringify(summary), { status: 200 });
  } catch (err: any) {
    console.error('[dispatch-alerts] failed:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

// Every 15 minutes — frequent enough that a happy hour going live doesn't
// sit unnoticed for long, infrequent enough to keep the batching/digest
// behavior meaningful (see lib/notify.ts). Netlify cron is always UTC;
// */15 means "at :00/:15/:30/:45 past the hour" regardless of timezone, so
// no DST adjustment is needed here the way it would be for a fixed local
// time of day.
export const config: Config = {
  schedule: '*/15 * * * *',
};
