import type { APIRoute } from 'astro';
import { clearSession } from '../../../lib/session';
import { json } from '../../../lib/api';

export const prerender = false;

export const POST: APIRoute = async ({ cookies }) => {
  await clearSession(cookies, 'restaurant');
  return json({ ok: true });
};
