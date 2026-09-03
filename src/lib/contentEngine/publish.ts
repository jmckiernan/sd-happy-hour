import { getGitHubTarget, getOctokit } from '../github';
import { slugifyContent } from './normalize';
import type { EditorialCluster, GeneratedDraft } from './types';

function yamlValue(value: string | string[] | boolean): string {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function frontmatterLine(key: string, value: string | string[] | boolean | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return `${key}: ${yamlValue(value)}`;
}

export function buildPublishedMarkdown(input: {
  draft: GeneratedDraft;
  cluster: EditorialCluster;
  publishDate?: string;
}): string {
  const sourceUrls = [...new Set(input.cluster.items.flatMap((item) =>
    item.provenance.map((source) => source.sourceUrl)
  ))];
  const lines = [
    '---',
    frontmatterLine('title', input.draft.title),
    frontmatterLine('description', input.draft.description),
    frontmatterLine('metaDescription', input.draft.seoMetadata.metaDescription),
    frontmatterLine('ogTitle', input.draft.seoMetadata.ogTitle),
    frontmatterLine('ogDescription', input.draft.seoMetadata.ogDescription),
    frontmatterLine('pubDate', input.publishDate || new Date().toISOString().slice(0, 10)),
    frontmatterLine('author', 'Happy Hour SD'),
    frontmatterLine('draft', false),
    frontmatterLine('aiGenerated', true),
    frontmatterLine('venues', []),
    frontmatterLine('heroImage', input.draft.heroImageUrl),
    frontmatterLine('tags', input.draft.tags),
    frontmatterLine('dates', input.draft.dates),
    frontmatterLine('locations', input.draft.locations),
    frontmatterLine('brands', input.draft.brands),
    frontmatterLine('eventTypes', input.draft.eventTypes),
    frontmatterLine('hashtags', input.draft.seoMetadata.hashtags),
    frontmatterLine('sourceUrls', sourceUrls),
    frontmatterLine('contentEngineId', input.draft.id || ''),
    '---',
    '',
    input.draft.bodyMarkdown.trim(),
    '',
  ].filter((line): line is string => line !== null);
  return lines.join('\n');
}

export async function publishContentDraft(input: {
  draft: GeneratedDraft;
  cluster: EditorialCluster;
}): Promise<{ slug: string; path: string }> {
  if (input.draft.contentType !== 'blog') throw new Error('Only blog drafts publish to the site.');
  const target = getGitHubTarget();
  const octokit = getOctokit(target);
  let slug = slugifyContent(input.draft.slug || input.draft.title) || `story-${Date.now()}`;
  let path = `src/content/blog/${slug}.md`;
  let sha: string | undefined;
  try {
    const existing = await octokit.repos.getContent({
      owner: target.owner, repo: target.repo, path, ref: target.branch,
    });
    if (!Array.isArray(existing.data) && existing.data.type === 'file' && 'content' in existing.data) {
      const current = Buffer.from(existing.data.content, 'base64').toString('utf8');
      if (input.draft.id && current.includes(`contentEngineId: ${JSON.stringify(input.draft.id)}`)) {
        sha = existing.data.sha;
      } else {
        slug = `${slug}-${String(input.draft.id || Date.now()).slice(0, 8)}`;
        path = `src/content/blog/${slug}.md`;
      }
    }
  } catch (error: any) {
    if (error?.status !== 404) throw error;
  }
  const content = buildPublishedMarkdown({ draft: { ...input.draft, slug }, cluster: input.cluster });
  await octokit.repos.createOrUpdateFileContents({
    owner: target.owner,
    repo: target.repo,
    path,
    branch: target.branch,
    message: `${sha ? 'Update' : 'Publish'} content-engine post: ${input.draft.title}`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha,
  });
  return { slug, path };
}
