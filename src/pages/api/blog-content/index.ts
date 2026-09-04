import type { APIRoute } from 'astro';
import { getLiveBlogHeroes } from '../../../lib/blogLiveContent';

export const prerender = false;

// Public, unauthenticated: card-sized hero images for every published post,
// read from GitHub at request time. The blog index is prerendered, so
// thumbnails would otherwise stay stale until the next deploy.
export const GET: APIRoute = async () => {
  const posts = await getLiveBlogHeroes('card');

  return new Response(JSON.stringify({ posts }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'netlify-cdn-cache-control': 'no-store',
    },
  });
};
