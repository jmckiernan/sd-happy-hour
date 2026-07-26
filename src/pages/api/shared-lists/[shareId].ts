import type { APIRoute } from 'astro';
import { readUsers } from '../../../lib/kv';
import { json, errorJson } from '../../../lib/api';
import happyHours from '../../../../public/data/happy-hours.json';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const users = await readUsers();
  const user = users.find((item) => item.shareId === params.shareId);
  if (!user) return errorJson(['Shared list not found.'], 404);

  const spots = (user.savedSpots || [])
    .map((saved) => ({
      ...saved,
      spot: (happyHours as any[]).find((spot) => spot.id === saved.spotId) || null,
    }))
    .filter((item) => item.spot);

  return json({ name: user.name, shareId: user.shareId, spots });
};
