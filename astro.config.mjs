import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';
import sitemap from '@astrojs/sitemap';
import venues from './public/data/happy-hours.json' with { type: 'json' };
import { buildVenueSlugMap } from './src/lib/venueSlug.ts';

// Venues we can't back with real happy-hour data still get a page so owners can
// find and claim them, but they stay out of the sitemap. Slugs come from
// venueSlug.ts (not venues.ts) so this config doesn't pull the JSON twice
// through TypeScript.
const venueSlugs = buildVenueSlugMap(venues);
const unlistedVenuePaths = new Set(
  venues
    .filter((venue) => venue.listingStatus === 'unlisted')
    .map((venue) => `/venues/${venueSlugs.get(venue.id)}/`),
);

export default defineConfig({
  site: 'https://happyhoursd.com',
  output: 'server',
  adapter: netlify(),
  integrations: [sitemap({
    filter: (page) => {
      const pathname = new URL(page).pathname;
      const privatePrefixes = ['/account', '/admin', '/alerts', '/lists', '/restaurant', '/submit'];
      return !privatePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
        && pathname !== '/venues/your-mother-s-house/'
        && !unlistedVenuePaths.has(pathname);
    },
  })],
  vite: {
    ssr: {
      // pdfkit reads built-in AFM font metrics from disk at runtime; bundling
      // it into the SSR function breaks PDF exports on Netlify.
      external: ['pdfkit'],
    },
    server: {
      watch: {
        // Running `npm run build` while `astro dev` is up drops a couple
        // thousand files into .netlify/ (the bundled SSR function) and
        // dist/. The dev watcher picks all of them up and exhausts the
        // Windows file-handle limit, after which every route fails with
        // "EMFILE: too many open files". None of it is source. Vite merges
        // this with its own defaults rather than replacing them.
        ignored: ['**/dist/**', '**/.netlify/**'],
      },
    },
  },
});
