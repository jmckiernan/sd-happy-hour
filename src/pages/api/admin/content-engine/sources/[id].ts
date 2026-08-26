import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../../../lib/admins';
import { errorJson, json, readJsonBody } from '../../../../../lib/api';
import { listContentSources, updateContentSource } from '../../../../../lib/contentEngine/repo';
import { isSafePublicSourceUrl } from '../../../../../lib/contentEngine/sourceAdapters';

export const prerender = false;

export const PATCH: APIRoute = async ({ cookies, request, params }) => {
  if (!await getAdminUser(cookies)) return errorJson(['Admin sign-in required.'], 401);
  const current = (await listContentSources()).find((source) => source.id === params.id);
  if (!current) return errorJson(['Source not found.'], 404);
  let body: Record<string, any>;
  try { body = await readJsonBody(request); } catch { return errorJson(['Invalid JSON body.'], 400); }
  let parsedUrl: URL;
  try { parsedUrl = new URL(String(body.url ?? current.url)); }
  catch { return errorJson(['A valid source URL is required.'], 422); }
  if (!isSafePublicSourceUrl(parsedUrl.toString())) return errorJson(['Source URL must use a public HTTP(S) host.'], 422);
  const trustScore = Number(body.trustScore ?? current.trustScore);
  if (!Number.isFinite(trustScore) || trustScore < 0 || trustScore > 1) {
    return errorJson(['Trust score must be between 0 and 1.'], 422);
  }
  const source = await updateContentSource({
    ...current,
    name: String(body.name ?? current.name).trim(),
    url: parsedUrl.toString(),
    enabled: body.enabled === undefined ? current.enabled : Boolean(body.enabled),
    trustScore,
    countyScoped: body.countyScoped === undefined ? current.countyScoped : Boolean(body.countyScoped),
    imagePolicy: body.imagePolicy || current.imagePolicy,
    config: typeof body.config === 'object' && body.config ? body.config : current.config,
  });
  return source ? json({ source }) : errorJson(['Source not found.'], 404);
};
