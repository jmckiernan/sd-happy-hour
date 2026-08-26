import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../../../lib/admins';
import { errorJson, json, readJsonBody } from '../../../../../lib/api';
import { linkAndEmphasizeDates } from '../../../../../lib/contentEngine/dateLinks';
import {
  approveDraft,
  regenerateClusterDrafts,
  regenerateDraftImage,
  rejectDraft,
  scheduleDraft,
} from '../../../../../lib/contentEngine/pipeline';
import { evaluateDraftQuality } from '../../../../../lib/contentEngine/quality';
import {
  getEditorialCluster,
  getGeneratedDraft,
  updateGeneratedDraft,
} from '../../../../../lib/contentEngine/repo';
import { slugifyContent } from '../../../../../lib/contentEngine/normalize';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params }) => {
  if (!await getAdminUser(cookies)) return errorJson(['Admin sign-in required.'], 401);
  const draft = await getGeneratedDraft(params.id || '');
  if (!draft) return errorJson(['Draft not found.'], 404);
  const cluster = await getEditorialCluster(draft.clusterId!);
  return json({ draft, cluster });
};

export const PATCH: APIRoute = async ({ cookies, request, params }) => {
  if (!await getAdminUser(cookies)) return errorJson(['Admin sign-in required.'], 401);
  const current = await getGeneratedDraft(params.id || '');
  if (!current) return errorJson(['Draft not found.'], 404);
  let body: Record<string, any>;
  try { body = await readJsonBody(request); } catch { return errorJson(['Invalid JSON body.'], 400); }
  const arrayField = (key: string, fallback: string[]) => Array.isArray(body[key])
    ? [...new Set(body[key].map(String).map((value: string) => value.trim()).filter(Boolean))]
    : fallback;
  const next = {
    ...current,
    id: current.id!,
    title: String(body.title ?? current.title).trim(),
    slug: slugifyContent(String(body.slug ?? current.slug ?? current.title)),
    description: String(body.description ?? current.description).trim(),
    bodyMarkdown: String(body.bodyMarkdown ?? current.bodyMarkdown).trim(),
    tags: arrayField('tags', current.tags),
    dates: arrayField('dates', current.dates),
    locations: arrayField('locations', current.locations),
    brands: arrayField('brands', current.brands),
    eventTypes: arrayField('eventTypes', current.eventTypes),
    heroImageUrl: body.heroImageUrl === undefined ? current.heroImageUrl : String(body.heroImageUrl || '').trim() || null,
    seoMetadata: {
      ...current.seoMetadata,
      ...(typeof body.seoMetadata === 'object' && body.seoMetadata ? body.seoMetadata : {}),
    },
  };
  if (!next.title || !next.description || !next.bodyMarkdown) {
    return errorJson(['Title, description, and body are required.'], 422);
  }
  next.bodyMarkdown = linkAndEmphasizeDates(next.bodyMarkdown, next.dates);
  const cluster = await getEditorialCluster(current.clusterId!);
  if (!cluster) return errorJson(['Source cluster not found.'], 404);
  const quality = evaluateDraftQuality(next, cluster);
  next.qualityScore = quality.score;
  next.qualityFlags = quality.flags;
  const draft = await updateGeneratedDraft(next);
  return json({ draft, cluster });
};

export const POST: APIRoute = async ({ cookies, request, params }) => {
  if (!await getAdminUser(cookies)) return errorJson(['Admin sign-in required.'], 401);
  let body: Record<string, any>;
  try { body = await readJsonBody(request); } catch { return errorJson(['Invalid JSON body.'], 400); }
  const id = params.id || '';
  try {
    switch (body.action) {
      case 'approve': return json({ draft: await approveDraft(id, false) });
      case 'publish': return json({ draft: await approveDraft(id, true) });
      case 'schedule': return json({ draft: await scheduleDraft(id, String(body.scheduledFor || '')) });
      case 'reject': return json({ draft: await rejectDraft(id) });
      case 'image': return json({ draft: await regenerateDraftImage(id) });
      case 'regenerate': {
        const current = await getGeneratedDraft(id);
        if (!current) return errorJson(['Draft not found.'], 404);
        return json({ drafts: await regenerateClusterDrafts(current.clusterId!) });
      }
      default: return errorJson(['Unsupported draft action.'], 422);
    }
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Draft action failed.'], 422);
  }
};
