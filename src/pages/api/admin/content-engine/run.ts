import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../../lib/admins';
import { errorJson, json, readJsonBody } from '../../../../lib/api';
import { runContentEngine } from '../../../../lib/contentEngine/pipeline';

export const prerender = false;

export const POST: APIRoute = async ({ cookies, request }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Admin sign-in required.'], 401);
  let body: Record<string, any> = {};
  try { body = await readJsonBody(request); } catch { /* empty body runs all sources */ }
  const sourceIds = Array.isArray(body.sourceIds)
    ? body.sourceIds.map(String).filter((value: string) => /^[0-9a-f-]{36}$/i.test(value))
    : undefined;
  try {
    return json(await runContentEngine({ triggerType: 'manual', sourceIds }));
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Content-engine run failed.'], 502);
  }
};
