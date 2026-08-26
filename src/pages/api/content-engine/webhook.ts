import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../lib/api';
import { getEnv } from '../../../lib/env';
import { runContentEngine, webhookSourceIsStrong } from '../../../lib/contentEngine/pipeline';
import { listContentSources } from '../../../lib/contentEngine/repo';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const secret = getEnv('CONTENT_ENGINE_WEBHOOK_SECRET');
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!secret || !token || token !== secret) return errorJson(['Unauthorized webhook.'], 401);
  let body: Record<string, any>;
  try { body = await readJsonBody(request); } catch { return errorJson(['Invalid JSON body.'], 400); }
  const source = (await listContentSources(true)).find((candidate) => candidate.id === body.sourceId);
  if (!source || !webhookSourceIsStrong(source)) {
    return errorJson(['An enabled webhook source with trust score 0.8 or higher is required.'], 422);
  }
  const items = Array.isArray(body.items) ? body.items : body.item ? [body.item] : [];
  if (!items.length || items.length > 25) return errorJson(['Provide between 1 and 25 items.'], 422);
  const summary = await runContentEngine({
    triggerType: 'event',
    sourceIds: [source.id],
    injectedItems: { [source.id]: items },
  });
  return json(summary, summary.status === 'failed' ? 502 : 200);
};
