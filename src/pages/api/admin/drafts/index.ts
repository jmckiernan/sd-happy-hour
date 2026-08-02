import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson } from '../../../../lib/api';
import { getGitHubTarget, getOctokit, listBlogFiles, getBlogFile } from '../../../../lib/blogDrafts';

export const prerender = false;

// Lists every blog post file in the repo — both still-hidden drafts and
// already-published posts — fetched live from GitHub (not from Astro's
// build-time content collection, which wouldn't know about a file
// committed since the last deploy). Used by /admin/drafts/ to manage
// anything, not just what's waiting for review: each item includes
// `draft` so the page can group/label live vs. draft posts.
export const GET: APIRoute = async ({ cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email first.'], 401);

  let target;
  try {
    target = getGitHubTarget();
  } catch (err: any) {
    return errorJson([err.message], 500);
  }

  const octokit = getOctokit(target);

  try {
    const files = await listBlogFiles(octokit, target);
    const posts = (
      await Promise.all(
        files.map(async ({ slug }) => {
          const file = await getBlogFile(octokit, target, slug);
          return file ? { slug, ...file.data } : null;
        })
      )
    ).filter((d): d is NonNullable<typeof d> => d !== null);

    posts.sort((a, b) => (a.pubDate < b.pubDate ? 1 : -1));

    return json({ posts });
  } catch (err: any) {
    return errorJson([`Could not list posts: ${err.message}`], 502);
  }
};
