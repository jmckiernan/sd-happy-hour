import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson } from '../../../../lib/api';
import {
  getGitHubTarget,
  getOctokit,
  getBlogFile,
  setDraftFalse,
  setDraftTrue,
  setField,
  removeField,
  rebuildFile,
} from '../../../../lib/blogDrafts';
import { describeGitHubError } from '../../../../lib/github';
import { renderMarkdown } from '../../../../lib/markdown';
import { getPostImage } from '../../../../lib/venues';

export const prerender = false;

// GET: fetch one draft (rendered to HTML) for the in-site preview page.
export const GET: APIRoute = async ({ params, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email first.'], 401);

  const slug = params.slug;
  if (!slug) return errorJson(['Missing slug.'], 400);

  let target;
  try {
    target = getGitHubTarget();
  } catch (err: any) {
    return errorJson([err.message], 500);
  }

  const octokit = getOctokit(target);

  try {
    const file = await getBlogFile(octokit, target, slug);
    if (!file) return errorJson(['Post not found.'], 404);

    return json({
      slug: file.slug,
      ...file.data,
      heroImage: getPostImage(file.data.heroImage, file.data.venues, 'hero'),
      bodyHtml: renderMarkdown(file.body),
    });
  } catch (err: any) {
    return errorJson([describeGitHubError(err, 'load this post')], 502);
  }
};

// PATCH: save edits made in the in-site editor — title, description,
// venues, and/or the raw markdown body — without touching draft/publish
// status. Lets an admin fix up the AI's draft entirely on the site,
// no GitHub editor needed.
export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email first.'], 401);

  const slug = params.slug;
  if (!slug) return errorJson(['Missing slug.'], 400);

  let body: Record<string, any>;
  try {
    body = await request.json();
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const { title, description, venues, body: markdownBody, heroImage } = body;
  if (typeof title !== 'string' || !title.trim()) return errorJson(['Title is required.'], 400);
  if (typeof description !== 'string' || !description.trim()) return errorJson(['Description is required.'], 400);
  if (typeof markdownBody !== 'string' || !markdownBody.trim()) return errorJson(['Body is required.'], 400);
  if (venues !== undefined && !Array.isArray(venues)) return errorJson(['Venues must be an array of slugs.'], 400);
  if (heroImage !== undefined && typeof heroImage !== 'string') return errorJson(['Featured image must be a URL string.'], 400);

  let target;
  try {
    target = getGitHubTarget();
  } catch (err: any) {
    return errorJson([err.message], 500);
  }

  const octokit = getOctokit(target);

  try {
    const file = await getBlogFile(octokit, target, slug);
    if (!file) return errorJson(['Post not found.'], 404);

    let lines = setField(file.lines, 'title', title.trim());
    lines = setField(lines, 'description', description.trim());
    lines = setField(lines, 'updatedDate', new Date().toISOString().slice(0, 10));
    if (Array.isArray(venues)) {
      lines = setField(lines, 'venues', venues.map((v: string) => String(v).trim()).filter(Boolean));
    }
    if (typeof heroImage === 'string') {
      const trimmedImage = heroImage.trim();
      lines = trimmedImage ? setField(lines, 'heroImage', trimmedImage) : removeField(lines, 'heroImage');
    }

    const content = rebuildFile(lines, `${markdownBody.trim()}\n`);

    await octokit.repos.createOrUpdateFileContents({
      owner: target.owner,
      repo: target.repo,
      path: file.path,
      branch: target.branch,
      // Same file either way, but the history should say which one it was —
      // matching how DELETE distinguishes discarding a draft from deleting a
      // live post. `draft` itself is untouched here, so editing a published
      // post updates it in place and it stays published.
      message: `${file.data.draft ? 'Edit draft' : 'Edit post'}: ${title.trim()}`,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      sha: file.sha,
    });

    return json({ success: true, slug });
  } catch (err: any) {
    return errorJson([describeGitHubError(err, 'save your edits')], 502);
  }
};

// POST: publish (default) or unpublish — flips draft: true/false and
// commits, so the post goes live (or comes back down) on the next deploy
// (same commit-to-repo mechanism the draft itself was created with).
// Body is optional: {"action": "unpublish"} to pull an already-live post
// back to draft; omitted or {"action": "publish"} to publish it.
export const POST: APIRoute = async ({ params, request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email first.'], 401);

  const slug = params.slug;
  if (!slug) return errorJson(['Missing slug.'], 400);

  let action: 'publish' | 'unpublish' = 'publish';
  try {
    const text = await request.text();
    if (text.trim()) {
      const parsed = JSON.parse(text);
      if (parsed.action === 'unpublish') action = 'unpublish';
    }
  } catch {
    // No/invalid body just means "publish", the original default behavior.
  }

  let target;
  try {
    target = getGitHubTarget();
  } catch (err: any) {
    return errorJson([err.message], 500);
  }

  const octokit = getOctokit(target);

  try {
    const file = await getBlogFile(octokit, target, slug);
    if (!file) return errorJson(['Post not found.'], 404);

    const nextLines = action === 'unpublish' ? setDraftTrue(file.lines) : setDraftFalse(file.lines);
    const content = rebuildFile(nextLines, file.body);

    await octokit.repos.createOrUpdateFileContents({
      owner: target.owner,
      repo: target.repo,
      path: file.path,
      branch: target.branch,
      message: action === 'unpublish' ? `Unpublish: ${file.data.title}` : `Publish: ${file.data.title}`,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      sha: file.sha,
    });

    return json({ success: true, slug, action });
  } catch (err: any) {
    return errorJson([describeGitHubError(err, `${action} this post`)], 502);
  }
};

// DELETE: remove a post entirely (draft or already-published).
export const DELETE: APIRoute = async ({ params, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email first.'], 401);

  const slug = params.slug;
  if (!slug) return errorJson(['Missing slug.'], 400);

  let target;
  try {
    target = getGitHubTarget();
  } catch (err: any) {
    return errorJson([err.message], 500);
  }

  const octokit = getOctokit(target);

  try {
    const file = await getBlogFile(octokit, target, slug);
    if (!file) return errorJson(['Post not found.'], 404);

    await octokit.repos.deleteFile({
      owner: target.owner,
      repo: target.repo,
      path: file.path,
      branch: target.branch,
      message: `${file.data.draft ? 'Discard draft' : 'Delete post'}: ${file.data.title}`,
      sha: file.sha,
    });

    return json({ success: true, slug });
  } catch (err: any) {
    return errorJson([describeGitHubError(err, 'delete this post')], 502);
  }
};
