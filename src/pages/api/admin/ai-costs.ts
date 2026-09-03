import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../lib/admins';
import { errorJson, json } from '../../../lib/api';
import { getCostSummary, getDailyCosts } from '../../../lib/aiUsage';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, url }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Admin sign-in required.'], 401);

  const startDate = url.searchParams.get('start') || undefined;
  const endDate = url.searchParams.get('end') || undefined;
  const days = url.searchParams.has('days') ? parseInt(url.searchParams.get('days')!, 10) : 30;

  try {
    const [summary, dailyCosts] = await Promise.all([
      getCostSummary({ startDate, endDate }),
      getDailyCosts({ days }),
    ]);

    return json({
      summary,
      dailyCosts,
    });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not load AI costs.'], 502);
  }
};
