import type { APIRoute } from 'astro';
import { readSubmissions } from '../../../../lib/kv';
import { getSession } from '../../../../lib/session';
import { json, errorJson } from '../../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'admin') return errorJson(['Admin login required.'], 401);

  const submissions = await readSubmissions();
  return json(submissions);
};
