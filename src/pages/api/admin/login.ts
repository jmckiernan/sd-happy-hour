import type { APIRoute } from 'astro';
import { cleanString } from '../../../lib/kv';
import { createSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

const ADMIN_USERNAME = import.meta.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = import.meta.env.ADMIN_PASSWORD || 'password';

export const POST: APIRoute = async ({ request, cookies }) => {
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const username = cleanString(body.username);
  const password = String(body.password || '');
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return errorJson(['Invalid username or password.'], 401);
  }

  await createSession(cookies, { role: 'admin', username });
  return json({ username });
};
