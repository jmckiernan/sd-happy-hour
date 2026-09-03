import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';
import sitemap from '@astrojs/sitemap';
import venues from './public/data/happy-hours.json' with { type: 'json' };
import { buildVenueSlugMap } from './src/lib/venueSlug.ts';
import { isSitemapEligible } from './src/lib/listingVisibility.ts';

// Venues we can't back with real happy-hour data still get a page so owners can
// find and claim them, but they stay out of the sitemap. Slugs come from
// venueSlug.ts (not venues.ts) so this config doesn't pull the JSON twice
// through TypeScript.
//
// Which venues belong in the sitemap is decided by isSitemapEligible, so this
// file and the `noindex` on the venue page cannot disagree about it again — they
// did, and `seoHidden` pages were being advertised to Google while telling it
// not to index them.
const venueSlugs = buildVenueSlugMap(venues);
const hiddenVenuePaths = new Set(
  venues
    .filter((venue) => !isSitemapEligible(venue))
    .map((venue) => `/venues/${venueSlugs.get(venue.id)}/`),
);

export default defineConfig({
  site: 'https://happyhoursd.com',
  // The toolbar's audit re-scans every on-screen image each time the card grid
  // re-renders, and each scan leaks a file handle server-side. On the homepage
  // that burns through thousands of descriptors a minute until the dev server
  // dies with "EMFILE: too many open files".
  devToolbar: { enabled: false },
  output: 'server',
  adapter: netlify(),
  // Explicit hover prefetch for merchant tab links (and any other
  // data-astro-prefetch markers). ClientRouter on /restaurant/* also enables
  // prefetch; this keeps non-router pages from prefetching every link.
  prefetch: {
    prefetchAll: false,
    defaultStrategy: 'hover',
  },
  integrations: [sitemap({
    filter: (page) => {
      const pathname = new URL(page).pathname;
      const privatePrefixes = ['/account', '/admin', '/alerts', '/lists', '/restaurant', '/submit'];
      return !privatePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
        && pathname !== '/venues/your-mother-s-house/'
        && !hiddenVenuePaths.has(pathname);
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
