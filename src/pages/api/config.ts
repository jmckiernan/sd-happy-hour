import type { APIRoute } from 'astro';

export const prerender = false;

// Public, non-secret config the browser needs. Google's client ID is meant
// to be public (it's embedded in every Google Sign-In button), so it's fine
// to hand back here. Cached for 1 hour since config rarely changes.
export const GET: APIRoute = async () => {
  return new Response(
    JSON.stringify({ googleClientId: import.meta.env.GOOGLE_CLIENT_ID || '' }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=3600',
      },
    }
  );
};
