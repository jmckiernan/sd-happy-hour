import type { APIRoute } from 'astro';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'node:crypto';
import { readUsers, writeUsers, publicUser, cleanString, type User } from '../../../lib/kv';
import { createSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

const GOOGLE_CLIENT_ID = import.meta.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!googleClient || !GOOGLE_CLIENT_ID) {
    return errorJson(['Google login is not configured. Set GOOGLE_CLIENT_ID.'], 503);
  }

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: cleanString(body.credential),
      audience: GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    return errorJson(['Google sign-in could not be verified.'], 401);
  }

  if (!payload?.email || !payload?.sub || payload.email_verified !== true) {
    return errorJson(['Google account email must be verified.'], 401);
  }

  const users = await readUsers();
  const email = payload.email.toLowerCase();
  const now = new Date().toISOString();
  let user = users.find((item) => item.googleId === payload!.sub || item.email === email);

  if (user) {
    user.googleId = payload.sub;
    user.name = cleanString(payload.name) || user.name;
    user.picture = cleanString(payload.picture);
    user.updatedAt = now;
  } else {
    user = {
      id: `user_${Date.now()}`,
      name: cleanString(payload.name) || email.split('@')[0],
      email,
      googleId: payload.sub,
      picture: cleanString(payload.picture),
      passwordSalt: null,
      passwordHash: null,
      shareId: crypto.randomBytes(8).toString('hex'),
      savedSpots: [],
      createdAt: now,
      updatedAt: now,
    } satisfies User;
    users.push(user);
  }

  await writeUsers(users);
  await createSession(cookies, { role: 'user', userId: user.id });
  return json(publicUser(user), 200);
};
