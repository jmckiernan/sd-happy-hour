import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { readUsers, writeUsers, publicUser, hashPassword, cleanString, type User } from '../../../lib/kv';
import { createSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

// Email/password fallback for account creation, used when Google login
// isn't configured yet (see src/pages/account.astro).
export const POST: APIRoute = async ({ request, cookies }) => {
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const name = cleanString(body.name);
  const email = cleanString(body.email).toLowerCase();
  const password = String(body.password || '');
  const errors: string[] = [];
  if (!name) errors.push('Name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push('A valid email is required.');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (errors.length) return errorJson(errors, 422);

  const users = await readUsers();
  if (users.some((user) => user.email === email)) {
    return errorJson(['An account already exists for that email.'], 409);
  }

  const passwordRecord = hashPassword(password);
  const now = new Date().toISOString();
  const user: User = {
    id: `user_${Date.now()}`,
    name,
    email,
    passwordSalt: passwordRecord.salt,
    passwordHash: passwordRecord.hash,
    shareId: crypto.randomBytes(8).toString('hex'),
    savedSpots: [],
    createdAt: now,
    updatedAt: now,
  };
  users.push(user);
  await writeUsers(users);
  await createSession(cookies, { role: 'user', userId: user.id });
  return json(publicUser(user), 201);
};
