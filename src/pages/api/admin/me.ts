import type { APIRoute } from 'astro';
import { getSession } from '../../../lib/session';
import { json } from '../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies);
  const authenticated = Boolean(session && session.role === 'admin');
  return json({ authenticated, username: authenticated ? (session as any).username : null });
};
