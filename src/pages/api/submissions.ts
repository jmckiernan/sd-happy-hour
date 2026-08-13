import type { APIRoute } from 'astro';
import { createSubmission } from '../../lib/store';
import { validateSubmission } from '../../lib/validation';
import { json, errorJson, readJsonBody } from '../../lib/api';

export const prerender = false;

// Public endpoint — anyone can submit a venue for review (src/pages/submit.astro).
// Submissions land in the pending queue; an admin approves or denies them
// from /admin (see api/admin/submissions/[id].ts).
export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const { listing, contact, errors } = validateSubmission(body);
  if (errors.length) return errorJson(errors, 422);

  const submission = await createSubmission({ contact, listing });
  return json({ id: submission.id, status: submission.status }, 201);
};
