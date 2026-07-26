import type { APIRoute } from 'astro';

export const prerender = false;

// Public, non-secret config the browser needs. Google's client ID is meant
// to be public (it's embedded in every Google Sign-In button), so it's fine
// to hand back here.
export const GET: APIRoute = async () => {
  return new Response(
    JSON.stringify({ googleClientId: import.meta.env.GOOGLE_CLIENT_ID || '' }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
};
