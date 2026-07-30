import type { APIRoute } from 'astro';
import { Octokit } from '@octokit/rest';
import { readSubmissions, writeSubmissions, validateListing, cleanString } from '../../../../lib/kv';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson, readJsonBody } from '../../../../lib/api';

export const prerender = false;

const DATA_PATH = 'public/data/happy-hours.json';

// Approving a submission needs to turn it into a real, statically-generated
// venue page (src/pages/venues/[slug].astro builds one page per entry in
// public/data/happy-hours.json at build time). Since Vercel's serverless
// functions can't write to that file directly, this commits the update
// straight to the repo via the GitHub API — the same "git is the database"
// approach the AI blog draft feature already uses (see api/generate-draft.ts).
// The new venue goes live on the next deploy (immediate if auto-deploy is on).
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

  const submissions = await readSubmissions();
  const index = submissions.findIndex((item) => item.id === params.id);
  if (index === -1) return errorJson(['Submission not found.'], 404);

  const submission = submissions[index];
  const now = new Date().toISOString();
  const action = cleanString(body.action);

  if (action === 'deny') {
    submission.status = 'denied';
    submission.denialReason = cleanString(body.denialReason);
    submission.updatedAt = now;
    await writeSubmissions(submissions);
    return json(submission);
  }

  if (action === 'edit' || action === 'approve') {
    const { listing, errors } = validateListing(body.listing || submission.listing, { requireCoordinates: action === 'approve' });
    if (errors.length) return errorJson(errors, 422);

    submission.listing = listing;
    submission.updatedAt = now;

    if (action === 'approve') {
      try {
        const nextId = await commitApprovedVenue(listing, now);
        submission.status = 'approved';
        submission.approvedListingId = nextId;
      } catch (err: any) {
        return errorJson([`Could not publish venue: ${err.message}`], 502);
      }
    }

    await writeSubmissions(submissions);
    return json(submission);
  }

  return errorJson(['Action must be edit, approve, or deny.'], 400);
};
