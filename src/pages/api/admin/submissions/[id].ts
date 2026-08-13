import type { APIRoute } from 'astro';
import { Octokit } from '@octokit/rest';
import { getSubmission, updateSubmission } from '../../../../lib/store';
import { validateListing, cleanString } from '../../../../lib/validation';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson, readJsonBody } from '../../../../lib/api';

export const prerender = false;

const DATA_PATH = 'public/data/happy-hours.json';

// Approving a submission needs to turn it into a real, statically-generated
// venue page (src/pages/venues/[slug].astro builds one page per entry in
// public/data/happy-hours.json at build time). Since serverless functions
// can't write to that file directly, this commits the update straight to
// the repo via the GitHub API — the same "git is the database" approach the
// AI blog draft feature already uses (see api/generate-draft.ts). The new
// venue goes live on the next deploy (immediate if auto-deploy is on).
async function commitApprovedVenue(listing: ReturnType<typeof validateListing>['listing'], now: string) {
  const owner = import.meta.env.GITHUB_OWNER;
  const repo = import.meta.env.GITHUB_REPO;
  const branch = import.meta.env.GITHUB_BRANCH || 'main';

  if (!owner || !repo || !import.meta.env.GITHUB_TOKEN) {
    throw new Error('Missing GITHUB_OWNER, GITHUB_REPO, or GITHUB_TOKEN env vars.');
  }

  const octokit = new Octokit({ auth: import.meta.env.GITHUB_TOKEN });

  const existing = await octokit.repos.getContent({ owner, repo, path: DATA_PATH, ref: branch });
  if (Array.isArray(existing.data) || existing.data.type !== 'file' || !('content' in existing.data)) {
    throw new Error(`${DATA_PATH} not found in the repo.`);
  }

  const happyHours = JSON.parse(Buffer.from(existing.data.content, 'base64').toString('utf-8'));
  const nextId = happyHours.reduce((max: number, item: any) => Math.max(max, Number(item.id) || 0), 0) + 1;
  const approvedListing = {
    id: nextId,
    ...listing,
    verified: true,
    lastVerifiedAt: now.slice(0, 10),
  };
  happyHours.push(approvedListing);

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: DATA_PATH,
    branch,
    message: `Approve submission: ${listing.name}`,
    content: Buffer.from(`${JSON.stringify(happyHours, null, 2)}\n`, 'utf-8').toString('base64'),
    sha: existing.data.sha,
  });

  return nextId;
}

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const submission = await getSubmission(params.id!);
  if (!submission) return errorJson(['Submission not found.'], 404);

  const now = new Date().toISOString();
  const action = cleanString(body.action);

  if (action === 'deny') {
    const updated = await updateSubmission(submission.id, {
      status: 'denied',
      denialReason: cleanString(body.denialReason),
    });
    return json(updated);
  }

  if (action === 'edit' || action === 'approve') {
    const { listing, errors } = validateListing(body.listing || submission.listing, { requireCoordinates: action === 'approve' });
    if (errors.length) return errorJson(errors, 422);

    if (action === 'approve') {
      try {
        const nextId = await commitApprovedVenue(listing, now);
        const updated = await updateSubmission(submission.id, { listing, status: 'approved', approvedListingId: nextId });
        return json(updated);
      } catch (err: any) {
        return errorJson([`Could not publish venue: ${err.message}`], 502);
      }
    }

    const updated = await updateSubmission(submission.id, { listing });
    return json(updated);
  }

  return errorJson(['Action must be edit, approve, or deny.'], 400);
};
