import type { APIRoute } from 'astro';
import { getUserById, updateUserProfile, listSavedSpots, listAlerts } from '../../../lib/store';
import { publicUser, verifyPassword, hashPassword, cleanString } from '../../../lib/validation';
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

  const user = await getUserById(session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const name = cleanString(body.name);
  if (!name) return errorJson(['Name is required.'], 422);

  let passwordSalt: string | undefined;
  let passwordHash: string | undefined;
  const newPassword = String(body.newPassword || '');
  if (newPassword) {
    if (!user.passwordHash) return errorJson(['This account signs in with Google and has no password to change.'], 422);
    if (newPassword.length < 8) return errorJson(['New password must be at least 8 characters.'], 422);
    if (!verifyPassword(String(body.currentPassword || ''), user)) {
      return errorJson(['Current password is incorrect.'], 401);
    }
    const record = hashPassword(newPassword);
    passwordSalt = record.salt;
    passwordHash = record.hash;
  }

  const updated = await updateUserProfile(user.id, { name, passwordSalt, passwordHash });
  if (!updated) return errorJson(['User not found.'], 404);
  const [savedSpots, alerts] = await Promise.all([listSavedSpots(updated.id), listAlerts(updated.id)]);
  return json(publicUser(updated, savedSpots, alerts));
};
