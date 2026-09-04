// Live blog fields that can change in GitHub after the static HTML was
// built. The public blog pages stay prerendered for CDN performance; a
// small runtime fetch overlays whatever differs from the last deploy.
import type { Octokit } from '@octokit/rest';
import { getGitHubTarget, getOctokit, listBlogFiles, getBlogFile } from './blogDrafts';
import { getPostImage, getPostImageFallback } from './venues';

export interface LiveBlogHero {
  heroImage: string;
  heroFallback: string;
}

function resolveHero(heroImage: string | undefined, venues: string[], size: 'hero' | 'card'): LiveBlogHero {
  return {
    heroImage: getPostImage(heroImage, venues, size),
    heroFallback: getPostImageFallback(heroImage, venues, size),
  };
}

async function withGitHub<T>(run: (octokit: Octokit, target: ReturnType<typeof getGitHubTarget>) => Promise<T>): Promise<T | null> {
  try {
    const target = getGitHubTarget();
    const octokit = getOctokit(target);
    return await run(octokit, target);
  } catch {
    return null;
  }
}

export async function getLiveBlogHero(slug: string, size: 'hero' | 'card' = 'hero'): Promise<LiveBlogHero | null> {
  return withGitHub(async (octokit, target) => {
    const file = await getBlogFile(octokit, target, slug);
    if (!file || file.data.draft) return null;
    return resolveHero(file.data.heroImage, file.data.venues, size);
  });
}

export async function getLiveBlogHeroes(size: 'hero' | 'card' = 'card'): Promise<Record<string, LiveBlogHero>> {
  const result = await withGitHub(async (octokit, target) => {
    const files = await listBlogFiles(octokit, target);
    const entries = await Promise.all(
      files.map(async ({ slug }) => {
        const file = await getBlogFile(octokit, target, slug);
        if (!file || file.data.draft) return null;
        return [slug, resolveHero(file.data.heroImage, file.data.venues, size)] as const;
      }),
    );
    return Object.fromEntries(entries.filter((entry): entry is [string, LiveBlogHero] => entry !== null));
  });
  return result ?? {};
}
