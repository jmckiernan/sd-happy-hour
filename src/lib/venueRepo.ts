import {
  getGitHubTarget,
  getOctokit,
  parseRepoJson,
  readRepoFile,
  RepoContentError,
} from './github';
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
 * happy-hours.json, and `imageCrop` when there is no framing to record.
 * Matters for more than tidiness: updateVenue() merges the incoming listing
 * over the stored row, so an empty value has to actually remove the key for
 * "clear the featured image, go back to the vibe photo" — and for "put the
 * framing back to centered" — to work. getListingImage() treats both absent
 * and empty as no photo. */
function withoutEmptyImage<T extends { image?: string; imageCrop?: unknown }>(row: T): T {
  const next = { ...row };
  if (!next.image) delete next.image;
  if (!next.imageCrop) delete next.imageCrop;
  return next;
}

function repoConfig() {
  const target = getGitHubTarget();
  return { ...target, octokit: getOctokit(target) };
}

/** Current contents of the venue file plus the blob sha, which
 * commitVenues() needs to make the write a conflict-checked update rather
 * than a blind overwrite. */
export async function fetchVenues(): Promise<VenueFileSnapshot> {
  const { octokit, ...target } = repoConfig();
  const file = await readRepoFile(octokit, target, DATA_PATH);

  // Absent is a different problem from present-but-unreadable: the catalog
  // every venue page is built from has never been committed, or the path/branch
  // is wrong. Nothing to merge an edit into, so it can't be a legitimate state
  // here the way a missing blog draft is.
  if (!file) {
    throw new RepoContentError(
      `${DATA_PATH} does not exist in ${target.owner}/${target.repo}@${target.branch}. ` +
        'Check GITHUB_OWNER, GITHUB_REPO, and GITHUB_BRANCH point at the repo the site deploys from.'
    );
  }

  const venues = parseRepoJson<Venue[]>(file.text, target, DATA_PATH);
  if (!Array.isArray(venues)) {
    throw new RepoContentError(
      `${DATA_PATH} in ${target.owner}/${target.repo}@${target.branch} is valid JSON but not an array of venues.`
    );
  }

  return { venues, sha: file.sha };
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
