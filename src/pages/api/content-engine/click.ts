import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../lib/api';
import { recordContentEngineEvent } from '../../../lib/contentEngine/repo';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, any>;
  try { body = await readJsonBody(request); } catch { return errorJson(['Invalid JSON body.'], 400); }
  if (!['article_view', 'article_link_click'].includes(body.event)) return errorJson(['Unsupported event.'], 422);
  const slug = String(body.slug || '').slice(0, 120);
  if (!/^[a-z0-9-]+$/.test(slug)) return errorJson(['Invalid article slug.'], 422);
  const properties: Record<string, unknown> = { slug };
  if (body.event === 'article_link_click') {
    try {
      const destination = new URL(String(body.destination || ''), 'https://happyhoursd.com');
      if (!['http:', 'https:'].includes(destination.protocol)) throw new Error('protocol');
      properties.destination_host = destination.hostname.slice(0, 120);
      properties.destination_path = destination.pathname.slice(0, 240);
      properties.link_type = String(body.linkType || 'unknown').slice(0, 40);
    } catch { return errorJson(['Invalid destination.'], 422); }
  }
  await recordContentEngineEvent({
    eventName: body.event,
    draftId: /^[0-9a-f-]{36}$/i.test(body.draftId || '') ? body.draftId : null,
    properties,
  }).catch(() => {});
  return json({ tracked: true });
};
