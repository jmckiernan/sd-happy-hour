import type { APIRoute } from 'astro';
import { readUsers, publicUser, verifyPassword, cleanString } from '../../../lib/kv';
import { createSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const email = cleanString(body.email).toLowerCase();
  const password = String(body.password || '');
  const users = await readUsers();
  const user = users.find((item) => item.email === email);
  if (!user || !verifyPassword(password, user)) {
    return errorJson(['Invalid email or password.'], 401);
  }

  await createSession(cookies, { role: 'user', userId: user.id });
  return json(publicUser(user), 200);
};
