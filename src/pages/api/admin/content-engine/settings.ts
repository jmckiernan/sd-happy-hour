import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../../lib/admins';
import { errorJson, json, readJsonBody } from '../../../../lib/api';
import { getContentEngineSettings, saveContentEngineSettings } from '../../../../lib/contentEngine/repo';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  if (!await getAdminUser(cookies)) return errorJson(['Admin sign-in required.'], 401);
  return json({ settings: await getContentEngineSettings() });
};

export const PUT: APIRoute = async ({ cookies, request }) => {
  if (!await getAdminUser(cookies)) return errorJson(['Admin sign-in required.'], 401);
  let body: Record<string, any>;
  try { body = await readJsonBody(request); }
  catch { return errorJson(['Invalid JSON body.'], 400); }
  const numbers = ['autoPublishMinQuality', 'minItemConfidence', 'minClusterScore'] as const;
  for (const key of numbers) {
    if (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0 || Number(body[key]) > 1) {
      return errorJson([`${key} must be between 0 and 1.`], 422);
    }
  }
  const settings = await saveContentEngineSettings({
    autoPublishEnabled: Boolean(body.autoPublishEnabled),
    autoPublishMinQuality: Number(body.autoPublishMinQuality),
    minItemConfidence: Number(body.minItemConfidence),
    minClusterScore: Number(body.minClusterScore),
    requireMultipleSources: body.requireMultipleSources !== false,
    generateImages: body.generateImages !== false,
    runSchedule: ['twice_daily', 'daily', 'manual'].includes(body.runSchedule) ? body.runSchedule : 'twice_daily',
  });
  return json({ settings });
};
