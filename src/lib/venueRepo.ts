import { getGitHubTarget, getOctokit } from './github';
import type { Listing } from './store';
import type { Venue } from './venues';

// Reading and writing public/data/happy-hours.json through the GitHub API.
//
// src/pages/venues/[slug].astro builds one static page per entry in that
// file, so a venue only exists once it's committed. Serverless functions
// can't write to the deployed filesystem, so every mutation goes to the repo
// instead — the same "git is the database" approach the AI blog draft
// feature uses (see api/generate-draft.ts). Changes go live on the next
// deploy, immediate if auto-deploy is on.
//
// Extracted here so approving a submission (api/admin/submissions/[id].ts)
// and editing an existing venue (api/admin/venues/[id].ts) share one
// read/commit path rather than each carrying its own copy.

const DATA_PATH = 'public/data/happy-hours.json';

export interface VenueFileSnapshot {
  venues: Venue[];
  sha: string;
}

/** Drops `image` when it's empty rather than writing `"image": ""` into
 * happy-hours.json. Matters for more than tidiness: updateVenue() merges the
 * incoming listing over the stored row, so an empty string has to actually
 * remove the key for "clear the featured image, go back to the vibe photo" to
 * work — and getListingImage() treats both absent and empty as no photo. */
function withoutEmptyImage<T extends { image?: string }>(row: T): T {
  if (row.image) return row;
  const { image, ...rest } = row;
  return rest as T;
}

function repoConfig() {
  const target = getGitHubTarget();
  return { ...target, octokit: getOctokit(target) };
}

/** Current contents of the venue file plus the blob sha, which
 * commitVenues() needs to make the write a conflict-checked update rather
 * than a blind overwrite. */
export async function fetchVenues(): Promise<VenueFileSnapshot> {
  const { owner, repo, branch, octokit } = repoConfig();
  const existing = await octokit.repos.getContent({ owner, repo, path: DATA_PATH, ref: branch });

  if (Array.isArray(existing.data) || existing.data.type !== 'file' || !('content' in existing.data)) {
    throw new Error(`${DATA_PATH} not found in the repo.`);
  }

  return {
    venues: JSON.parse(Buffer.from(existing.data.content, 'base64').toString('utf-8')),
    sha: existing.data.sha,
  };
}

export async function commitVenues(venues: Venue[], sha: string, message: string) {
  const { owner, repo, branch, octokit } = repoConfig();
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: DATA_PATH,
    branch,
    message,
    content: Buffer.from(`${JSON.stringify(venues, null, 2)}\n`, 'utf-8').toString('base64'),
    sha,
  });
}

/** Appends an approved submission as a new venue and returns its new id. */
export async function appendVenue(listing: Listing, now: string): Promise<number> {
  const { venues, sha } = await fetchVenues();
  const nextId = venues.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;

  venues.push(withoutEmptyImage({
    id: nextId,
    ...listing,
    verified: true,
    lastVerifiedAt: now.slice(0, 10),
  }) as Venue);

  await commitVenues(venues, sha, `Approve submission: ${listing.name}`);
  return nextId;
}

/** Replaces an existing venue's editable fields in place, keeping its id.
 * Throws if no venue has that id. */
export async function updateVenue(
  id: number,
  listing: Listing,
  snapshot?: VenueFileSnapshot
): Promise<Venue> {
  const { venues, sha } = snapshot ?? (await fetchVenues());
  const index = venues.findIndex((venue) => Number(venue.id) === id);
  if (index === -1) throw new Error(`No venue with id ${id}.`);

  // Spread over the existing row rather than replacing it, so any field the
  // form doesn't cover survives the round trip.
  const updated = withoutEmptyImage({ ...venues[index], ...listing, id }) as Venue;
  venues[index] = updated;

  await commitVenues(venues, sha, `Edit venue: ${listing.name}`);
  return updated;
}
