import type { APIRoute } from 'astro';
import { errorJson } from '../../../lib/api';
import { getLiveBlogHero } from '../../../lib/blogLiveContent';

export const prerender = false;

// Public, unauthenticated: the featured image for one live blog post, read
// from GitHub at request time. Blog post pages are prerendered from the
// content collection at build time, so an admin image swap would otherwise
// wait for a redeploy even though the blob is already served live.
export const GET: APIRoute = async ({ params }) => {
  const slug = params.slug;
  if (!slug) return errorJson(['Missing slug.'], 400);

  const hero = await getLiveBlogHero(slug, 'hero');
  if (!hero) return errorJson(['Post not found.'], 404);

  return new Response(JSON.stringify({ slug, ...hero }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'netlify-cdn-cache-control': 'no-store',
    },
  });
};
