import { defineMiddleware } from 'astro:middleware';
import { isDbConnectionError } from './lib/db';

// Safety net for the account/submissions API routes (src/pages/api/**):
// several of them genuinely need Postgres connected (see
// README-NEON-MIGRATION.md) and will throw if DATABASE_URL is missing or
// unreachable. Without this, an uncaught error there renders as
// Astro/Vite's full-page dev error overlay — which is jarring and, worse,
// looks like the whole site is broken rather than "one feature needs
// setup." This converts any uncaught error from an /api/ route into a
// clean JSON response instead.
export const onRequest = defineMiddleware(async (context, next) => {
  try {
    return await next();
  } catch (err) {
    if (!context.url.pathname.startsWith('/api/')) throw err;

    const message = err instanceof Error ? err.message : 'Something went wrong.';
    const isDbError = isDbConnectionError(message);
    // Log the real message server-side regardless (README-NEON-MIGRATION.md
    // §6 step 17) — the diagnosable detail shouldn't only exist in whichever
    // branch matched isDbConnectionError.
    console.error('[api error]', context.url.pathname, message);

    return new Response(
      JSON.stringify({
        errors: [
          isDbError
            ? 'This feature needs a database connected — see README-NEON-MIGRATION.md.'
            : 'Something went wrong. Please try again.',
        ],
      }),
      { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } }
    );
  }
});
