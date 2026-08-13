import type { APIRoute } from 'astro';
import { createRestaurant, getRestaurantByEmail } from '../../../lib/store';
import { publicRestaurant, hashPassword, cleanString, extractDomain } from '../../../lib/validation';
import { createSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

// Restaurant sign-up. Two-tier verification (see the alerts spec, "Restaurant
// Verification"): if the signup email's domain matches the claimed
// website's domain, the account is verified instantly. Otherwise — very
// common for small restaurants running email off Gmail/Yahoo rather than
// their own domain — it lands in `pending`, and the restaurant supplies
// supporting info via /api/restaurant/claim for an admin to review at
// /admin/restaurants/.
export const POST: APIRoute = async ({ request, cookies }) => {
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const name = cleanString(body.name);
  const email = cleanString(body.email).toLowerCase();
  const website = cleanString(body.website);
  const password = String(body.password || '');

  const errors: string[] = [];
  if (!name) errors.push('Restaurant name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push('A valid email is required.');
  if (!website || !/^https?:\/\//i.test(website)) errors.push('Website must start with http:// or https://.');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (errors.length) return errorJson(errors, 422);

  if (await getRestaurantByEmail(email)) {
    return errorJson(['An account already exists for that email.'], 409);
  }

  const emailDomain = extractDomain(email);
  const websiteDomain = extractDomain(website);
  const domainMatches = Boolean(emailDomain) && emailDomain === websiteDomain;

  const passwordRecord = hashPassword(password);

  let restaurant;
  try {
    restaurant = await createRestaurant({
      name,
      email,
      passwordSalt: passwordRecord.salt,
      passwordHash: passwordRecord.hash,
      website,
      verified: domainMatches,
      verificationMethod: domainMatches ? 'domain' : null,
      verificationStatus: domainMatches ? 'verified' : 'pending',
    });
  } catch (err: any) {
    if (err?.code === '23505') return errorJson(['An account already exists for that email.'], 409);
    throw err;
  }

  await createSession(cookies, { role: 'restaurant', restaurantId: restaurant.id });
  return json(publicRestaurant(restaurant), 201);
};
