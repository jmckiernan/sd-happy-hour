import type { APIRoute } from 'astro';
import { getSession } from '../../lib/session';
import { getUserById } from '../../lib/store';
import { createBugReport } from '../../lib/feedbackStore';
import { cleanString } from '../../lib/validation';
import { errorJson, json, readJsonBody } from '../../lib/api';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  let body: Record<string, any>;
  try { body = await readJsonBody(request); }
  catch { return errorJson(['Invalid JSON body.'], 400); }

  const session = await getSession(cookies);
  const user = session ? await getUserById(session.userId) : null;
  const title = cleanString(body.title).slice(0, 120);
  const details = cleanString(body.details).slice(0, 2000);
  const email = (user?.email || cleanString(body.email)).trim().toLowerCase().slice(0, 254);
  const pageUrl = cleanString(body.pageUrl).slice(0, 2000);
  const userAgent = request.headers.get('user-agent')?.slice(0, 1000) || '';

  const errors: string[] = [];
  if (title.length < 5) errors.push('Please add a short title (at least 5 characters).');
  if (details.length < 20) errors.push('Please describe the bug in at least 20 characters.');
  if (!user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('A valid email is required so we can follow up.');
  if (errors.length) return errorJson(errors, 422);

  const id = await createBugReport({
    reporterUserId: user?.id || null,
    email,
    title,
    details,
    pageUrl,
    userAgent,
  });
  return json({ id, stored: true }, 201);
};
