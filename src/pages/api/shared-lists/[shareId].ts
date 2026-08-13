import type { APIRoute } from 'astro';
import { getUserByShareId, listSavedSpots } from '../../../lib/store';
import { json, errorJson } from '../../../lib/api';
import happyHours from '../../../../public/data/happy-hours.json';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  // Indexed lookup by share_id instead of scanning every user (README-NEON-
  // MIGRATION.md §5, "Shared list by shareId").
  const user = await getUserByShareId(params.shareId!);
  if (!user) return errorJson(['Shared list not found.'], 404);

  const savedSpots = await listSavedSpots(user.id);
  const spots = savedSpots
    .map((saved) => ({
      ...saved,
      spot: (happyHours as any[]).find((spot) => spot.id === saved.spotId) || null,
    }))
    .filter((item) => item.spot);

  return json({ name: user.name, shareId: user.shareId, spots });
};
