import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../../../lib/admins';
import { errorJson, json, readJsonBody } from '../../../../../lib/api';
import { createContentSource, listContentSources } from '../../../../../lib/contentEngine/repo';
import type { ContentSourceKind, ImagePolicy } from '../../../../../lib/contentEngine/types';
import { isSafePublicSourceUrl } from '../../../../../lib/contentEngine/sourceAdapters';

export const prerender = false;
const KINDS: ContentSourceKind[] = ['rss', 'atom', 'google_alert', 'reddit_rss', 'json_ld', 'webhook'];
const IMAGE_POLICIES: ImagePolicy[] = ['none', 'first_party', 'attributed'];

export const GET: APIRoute = async ({ cookies }) => {
  if (!await getAdminUser(cookies)) return errorJson(['Admin sign-in required.'], 401);
  return json({ sources: await listContentSources() });
};

export const POST: APIRoute = async ({ cookies, request }) => {
  if (!await getAdminUser(cookies)) return errorJson(['Admin sign-in required.'], 401);
  let body: Record<string, any>;
  try { body = await readJsonBody(request); } catch { return errorJson(['Invalid JSON body.'], 400); }
  const name = String(body.name || '').trim();
  const kind = String(body.kind || '') as ContentSourceKind;
  const imagePolicy = String(body.imagePolicy || 'none') as ImagePolicy;
  let url: URL;
  try { url = new URL(String(body.url || '')); }
  catch { return errorJson(['A valid source URL is required.'], 422); }
  if (!name || !KINDS.includes(kind) || !isSafePublicSourceUrl(url.toString())) {
    return errorJson(['Name, supported source type, and an HTTP(S) URL are required.'], 422);
  }
  if (!IMAGE_POLICIES.includes(imagePolicy)) return errorJson(['Unsupported image policy.'], 422);
  const trustScore = Number(body.trustScore ?? 0.6);
  if (!Number.isFinite(trustScore) || trustScore < 0 || trustScore > 1) {
    return errorJson(['Trust score must be between 0 and 1.'], 422);
  }
  try {
    const source = await createContentSource({
      name,
      kind,
      url: url.toString(),
      enabled: body.enabled !== false,
      trustScore,
      countyScoped: Boolean(body.countyScoped),
      imagePolicy,
      config: typeof body.config === 'object' && body.config ? body.config : {},
    });
    return json({ source }, 201);
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not create source.'], 422);
  }
};
