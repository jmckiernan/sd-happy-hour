import type { APIRoute } from 'astro';
import { readImage } from '../../../lib/imageStore';

export const prerender = false;

// Public, unauthenticated — these are blog featured images meant to be seen
// by every site visitor, unlike the admin-only /api/admin/** routes.
export const GET: APIRoute = async ({ params }) => {
  const key = params.key;
  if (!key) return new Response('Not found', { status: 404 });

  const image = await readImage(key);
  if (!image) return new Response('Not found', { status: 404 });

  // Response's DOM type accepts an ArrayBuffer, not a Uint8Array whose
  // backing buffer could theoretically be shared.
  const body = new ArrayBuffer(image.bytes.byteLength);
  new Uint8Array(body).set(image.bytes);

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': image.contentType,
      // Keys are unique per upload and never overwritten, so this is safe
      // to cache indefinitely.
      'cache-control': 'public, max-age=31536000, immutable',
      // Netlify doesn't cache function responses by default, and a plain
      // `cache-control` only gets each edge node to cache its own copy —
      // so every node still invokes this function once per key, and again
      // after any eviction. The `durable` directive additionally stores the
      // response in Netlify's shared durable cache, which edge nodes check
      // before invoking; that turns the steady state into ~zero invocations
      // for an image that's already been served once anywhere.
      'netlify-cdn-cache-control': 'public, durable, max-age=31536000, immutable',
    },
  });
};
