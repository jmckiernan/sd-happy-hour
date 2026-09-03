// Shared helpers for reading/publishing AI-generated blog drafts straight
// from the repo via the GitHub API — same "git is the database" pattern
// used everywhere else (see api/generate-draft.ts, api/admin/submissions).
// This lets the admin UI preview and publish a draft without anyone
// opening GitHub's own editor.
import type { Octokit } from '@octokit/rest';
import { readRepoFile, type GitHubTarget } from './github';

const BLOG_DIR = 'src/content/blog';

// Credential resolution lives in github.ts now, shared with venueRepo.ts and
// the content engine. Re-exported so the several routes and pages that import
// them from here keep working.
export { getGitHubTarget, getOctokit, describeGitHubError, type GitHubTarget } from './github';

export interface ParsedFrontmatter {
  title: string;
  description: string;
  pubDate: string;
  updatedDate?: string;
  author: string;
  draft: boolean;
  aiGenerated: boolean;
  venues: string[];
  heroImage?: string;
}

// Splits a .md file into its frontmatter block (raw lines, one per array
// entry, in original order/formatting) and the markdown body beneath it.
// Working with raw lines (rather than fully re-serializing) means any
// manual edits made directly on GitHub round-trip untouched.
export function splitFrontmatter(raw: string): { lines: string[]; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { lines: [], body: raw };
  return { lines: match[1].split(/\r?\n/), body: match[2] };
}

function findLine(lines: string[], key: string): number {
  return lines.findIndex((line) => line.trim().startsWith(`${key}:`));
}

// Every value our frontmatter ever writes (quoted strings, arrays of
// quoted strings, bare booleans) happens to also be valid JSON — the one
// exception is a bare date like `2026-07-24`, which JSON.parse rejects,
// so that falls through to the plain trimmed string. That covers every
// field this app writes without needing a full YAML parser.
function decodeValue(raw: string): any {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export function parseFrontmatter(lines: string[]): ParsedFrontmatter {
  const get = (key: string) => {
    const idx = findLine(lines, key);
    if (idx === -1) return undefined;
    return decodeValue(lines[idx].slice(lines[idx].indexOf(':') + 1));
  };

  const venues = get('venues');

  return {
    title: get('title') ?? '(untitled)',
    description: get('description') ?? '',
    pubDate: String(get('pubDate') ?? ''),
    updatedDate: get('updatedDate') ? String(get('updatedDate')) : undefined,
    author: get('author') ?? 'Happy Hour SD',
    draft: Boolean(get('draft')),
    aiGenerated: Boolean(get('aiGenerated')),
    venues: Array.isArray(venues) ? venues : [],
    heroImage: get('heroImage'),
  };
}

// Every value this app ever writes to frontmatter is one of these three
// shapes — mirrors the same encoding generate-draft.ts uses when it first
// creates the file, so re-saving a field looks identical to how it was
// written originally.
function encodeValue(value: string | string[] | boolean): string {
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

// Replaces a single frontmatter field's line in place (or appends it if
// missing), leaving every other line exactly as written.
export function setField(lines: string[], key: string, value: string | string[] | boolean): string[] {
  const idx = findLine(lines, key);
  const line = `${key}: ${encodeValue(value)}`;
  if (idx === -1) return [...lines, line];
  const next = [...lines];
  next[idx] = line;
  return next;
}

// Removes a field's line entirely if present (no-op if it's already
// missing). Used for heroImage: an empty value should fall back to the
// auto-picked venue image (getPostImage), not write heroImage: "".
export function removeField(lines: string[], key: string): string[] {
  const idx = findLine(lines, key);
  if (idx === -1) return lines;
  return [...lines.slice(0, idx), ...lines.slice(idx + 1)];
}

// Flips draft: true -> draft: false in place, preserving every other line
// exactly as written.
export function setDraftFalse(lines: string[]): string[] {
  return setField(lines, 'draft', false);
}

// The reverse — pulls an already-published post back to draft/hidden
// (e.g. to fix something before it's visible again), without deleting it.
export function setDraftTrue(lines: string[]): string[] {
  return setField(lines, 'draft', true);
}

export function rebuildFile(lines: string[], body: string): string {
  return ['---', ...lines, '---', body].join('\n');
}

export interface BlogFile {
  slug: string;
  path: string;
  sha: string;
  lines: string[];
  body: string;
  data: ParsedFrontmatter;
}

export async function listBlogFiles(
  octokit: Octokit,
  target: GitHubTarget
): Promise<{ slug: string; path: string }[]> {
  const res = await octokit.repos.getContent({
    owner: target.owner,
    repo: target.repo,
    path: BLOG_DIR,
    ref: target.branch,
  });
  if (!Array.isArray(res.data)) return [];
  return res.data
    .filter((item) => item.type === 'file' && item.name.endsWith('.md'))
    .map((item) => ({ slug: item.name.replace(/\.md$/, ''), path: item.path }));
}

// Returns null only when the repo genuinely has no file at that slug. It used
// to swallow every error into null, which is how an expired token turned into
// "Draft not found — it may have already been published or discarded" on
// /admin/drafts/[slug]: the post was right there, GitHub had simply answered
// 401. readRepoFile() keeps that 404-means-absent, everything-else-throws
// split, and shares one decode path with the venue file so the over-1 MB
// `encoding: "none"` case can't come back here either.
export async function getBlogFile(
  octokit: Octokit,
  target: GitHubTarget,
  slug: string
): Promise<BlogFile | null> {
  const path = `${BLOG_DIR}/${slug}.md`;
  const file = await readRepoFile(octokit, target, path);
  if (!file) return null;
  const { lines, body } = splitFrontmatter(file.text);
  return { slug, path, sha: file.sha, lines, body, data: parseFrontmatter(lines) };
}
