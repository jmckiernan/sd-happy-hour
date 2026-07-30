import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    draft: z.boolean().default(false),
    author: z.string().default('SD Happy Hours'),
    // Slugs from data/happy-hours.json this post should link to, e.g. ["ironside-fish-oyster"]
    venues: z.array(z.string()).default([]),
    heroImage: z.string().optional(),
    // Set true for posts created by the AI draft generator, so the CMS/editor knows to flag it
    aiGenerated: z.boolean().default(false),
  }),
});

export const collections = { blog };
