import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://sdhappyhours.com',
  output: 'server',
  adapter: netlify(),
  integrations: [sitemap()],
});
