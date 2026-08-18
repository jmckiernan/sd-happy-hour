import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://sdhappyhours.com',
  output: 'server',
  adapter: netlify(),
  integrations: [sitemap()],
  vite: {
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
