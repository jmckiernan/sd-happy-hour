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

  return new Response(image.bytes, {
    status: 200,
    headers: {
      'content-type': image.contentType,
      // Keys are unique per upload and never overwritten, so this is safe
      // to cache indefinitely.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
