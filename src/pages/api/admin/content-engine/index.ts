import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../../lib/admins';
import { errorJson, json } from '../../../../lib/api';
import {
  contentEngineOverview,
  getContentEngineSettings,
  listContentSources,
  listEditorialClusters,
  listGeneratedDrafts,
  listRecentContentItems,
} from '../../../../lib/contentEngine/repo';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Admin sign-in required.'], 401);
  try {
    const [overview, settings, sources, items, clusters, drafts] = await Promise.all([
      contentEngineOverview(),
      getContentEngineSettings(),
      listContentSources(),
      listRecentContentItems({ limit: 150, includeRejected: true }),
      listEditorialClusters(80),
      listGeneratedDrafts({ limit: 150 }),
    ]);
    return json({ overview, settings, sources, items, clusters, drafts });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not load the content engine.'], 502);
  }
};
