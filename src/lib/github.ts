// One place to resolve the GitHub credentials every "git is the database"
// path needs (blog drafts, the venue file, the content engine), and one place
// to turn a failed GitHub call into something an admin can act on.
//
// This used to be four near-identical copies of the same env read — two of
// them going straight to `import.meta.env`, which is empty inside standalone
// Netlify Functions (see env.ts). They also let GitHub's own response text
// through to the admin UI, so an expired token surfaced as the bare string
// "Bad credentials - https://docs.github.com/rest": no indication of which
// env var was at fault, and a needless peek at our upstream.
import { Octokit } from '@octokit/rest';
import { getEnv } from './env';

export interface GitHubTarget {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

// Thrown when the repo credentials aren't configured at all, as opposed to
// configured-but-rejected. Callers surface this as a 500 (our deployment is
// misconfigured) rather than a 502 (GitHub said no).
export class GitHubConfigError extends Error {}

export function getGitHubTarget(): GitHubTarget {
  const owner = getEnv('GITHUB_OWNER');
  const repo = getEnv('GITHUB_REPO');
  const branch = getEnv('GITHUB_BRANCH') || 'main';
  // A token pasted through a shell or a Netlify env field picks up stray
  // whitespace and newlines surprisingly often, and GitHub answers a header
  // containing one with the same opaque 401 as a revoked token. Trimming here
  // means that failure mode can never be the explanation.
  const token = getEnv('GITHUB_TOKEN')?.trim();

  const missing = [
    !owner && 'GITHUB_OWNER',
    !repo && 'GITHUB_REPO',
    !token && 'GITHUB_TOKEN',
  ].filter((name): name is string => Boolean(name));

  if (missing.length) {
    throw new GitHubConfigError(
      `GitHub is not configured for this deployment: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
        'Set them in .env.local for local development, or under Site configuration → Environment variables on Netlify.'
    );
  }

  return { owner: owner!, repo: repo!, branch, token: token! };
}

export function getOctokit(target: GitHubTarget): Octokit {
  return new Octokit({ auth: target.token });
}

function statusOf(err: any): number | undefined {
  const status = err?.status ?? err?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/** True for an error that came back from the GitHub API rather than from our
 * own code or the database. Octokit attaches both a numeric `status` and the
 * originating `request`, which together are specific enough to tell its
 * rejections apart from a `new Error('No venue with id 4.')` of ours. Callers
 * that can fail either way use this to decide whether describeGitHubError()
 * is the right explanation, instead of flattening a database problem into a
 * message about tokens. */
export function isGitHubError(err: any): boolean {
  return statusOf(err) !== undefined && Boolean(err?.request || err?.response);
}

/** True only for a genuine "this path isn't in the repo" answer. GitHub also
 * returns 404 for a repo a token can't see, so callers that use this to mean
 * "absent" have to be reading a repo the token demonstrably reaches. */
export function isGitHubNotFound(err: any): boolean {
  return statusOf(err) === 404;
}

/** An admin-facing sentence for a failed GitHub call. Deliberately never
 * includes GitHub's response body — every status we can name maps to the
 * specific thing the owner has to go fix, and an unrecognized one says so
 * without quoting upstream. `action` completes "Could not <action>". */
export function describeGitHubError(err: any, action: string): string {
  if (err instanceof GitHubConfigError) return err.message;

  const status = statusOf(err);
  // The detail stops here rather than travelling to the browser, so it has to
  // land somewhere the owner can still read it. Logged at the one boundary
  // every caller funnels through.
  console.error(`[github] ${action} failed`, { status, message: err?.message });
  const prefix = `Could not ${action}.`;

  if (status === 401) {
    return `${prefix} GitHub rejected the GITHUB_TOKEN — it has expired, been revoked, or been mistyped. ` +
      'Generate a new token and update GITHUB_TOKEN (locally in .env.local, in production under Netlify environment variables).';
  }

  if (status === 403) {
    // GitHub uses 403 both for "your token can't do this" and for rate
    // limiting, and the two need opposite responses from the reader.
    const rateLimited = err?.response?.headers?.['x-ratelimit-remaining'] === '0';
    return rateLimited
      ? `${prefix} This deployment has hit GitHub's API rate limit. Wait for the limit to reset and try again.`
      : `${prefix} The GITHUB_TOKEN is valid but not allowed to do this. A fine-grained token needs Read and write access to Contents on this repository.`;
  }

  if (status === 404) {
    return `${prefix} GitHub could not find that path. Check GITHUB_OWNER, GITHUB_REPO, and GITHUB_BRANCH — ` +
      'and note a fine-grained token without Contents access to the repository also answers 404 rather than admitting the repo exists.';
  }

  if (status === 409) {
    return `${prefix} Someone else changed this file first. Reload the page and try again.`;
  }

  if (status !== undefined && status >= 500) {
    return `${prefix} GitHub returned a server error. This is usually temporary — try again shortly.`;
  }

  return `${prefix} The request to GitHub failed unexpectedly. Check the server logs for details.`;
}

/** describeGitHubError() for anything GitHub raised, the error's own message
 * otherwise. For the handful of paths that touch the repo and the database in
 * the same try block. */
export function describeRepoError(err: any, action: string): string {
  if (err instanceof GitHubConfigError || isGitHubError(err)) return describeGitHubError(err, action);
  return `Could not ${action}: ${err?.message || String(err)}`;
}
