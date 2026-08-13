// Reads an env var from whichever mechanism is available. Astro API routes
// (built through Vite) populate `import.meta.env` from the real process env
// at runtime, so that's normally enough — but the scheduled alert-dispatch
// job (netlify/functions/dispatch-alerts.mts, see README-NOTIFICATIONS-SETUP.md)
// is a *standalone* Netlify Function, not built through Astro/Vite, so
// `import.meta.env` isn't populated there at all. Checking `process.env` too
// means every module that needs config (db.ts, email.ts, sms.ts) works from
// both places without each reimplementing this.
export function getEnv(name: string): string | undefined {
  return (import.meta as any).env?.[name] ?? process.env[name];
}
