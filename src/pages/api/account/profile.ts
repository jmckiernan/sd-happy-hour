import type { APIRoute } from 'astro';
import { readUsers, writeUsers, publicUser, verifyPassword, hashPassword, cleanString } from '../../../lib/kv';
import { getSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

// Profile section of /account/ — display name, and a password change for
// accounts that have one (Google-only accounts have no password to change;
// the frontend hides that form entirely when publicUser().hasPassword is
// false, and this still double-checks server-side).
export const PUT: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return errorJson(['User login required.'], 401);

  const users = await readUsers();
  const user = users.find((item) => item.id === session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const name = cleanString(body.name);
  if (!name) return errorJson(['Name is required.'], 422);
  user.name = name;

  const newPassword = String(body.newPassword || '');
  if (newPassword) {
    if (!user.passwordHash) return errorJson(['This account signs in with Google and has no password to change.'], 422);
    if (newPassword.length < 8) return errorJson(['New password must be at least 8 characters.'], 422);
    if (!verifyPassword(String(body.currentPassword || ''), user)) {
      return errorJson(['Current password is incorrect.'], 401);
    }
    const record = hashPassword(newPassword);
    user.passwordSalt = record.salt;
    user.passwordHash = record.hash;
  }

  user.updatedAt = new Date().toISOString();
  await writeUsers(users);
  return json(publicUser(user));
};
