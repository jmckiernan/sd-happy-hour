import { defineMiddleware } from 'astro:middleware';

// Safety net for the account/submissions API routes (src/pages/api/**):
// several of them genuinely need Vercel KV connected (see
// README-ACCOUNTS-SETUP.md) and will throw if it isn't. Without this,
// an uncaught error there renders as Astro/Vite's full-page dev error
// overlay — which is jarring and, worse, looks like the whole site is
// broken rather than "one feature needs setup." This converts any
// uncaught error from an /api/ route into a clean JSON response instead.
export const onRequest = defineMiddleware(async (context, next) => {
  try {
    return await next();
  } catch (err) {
    if (!context.url.pathname.startsWith('/api/')) throw err;

    const message = err instanceof Error ? err.message : 'Something went wrong.';
    const isKvError = message.includes('@vercel/kv') || message.includes('KV_REST_API');
    console.error('[api error]', context.url.pathname, message);

    return new Response(
      JSON.stringify({
        errors: [
          isKvError
            ? 'This feature needs a data store connected — see README-ACCOUNTS-SETUP.md.'
            : 'Something went wrong. Please try again.',
        ],
      }),
      { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } }
    );
  }
});
