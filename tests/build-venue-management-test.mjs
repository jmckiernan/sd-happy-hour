import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const ROOT = process.cwd();
const venueContentPath = path.join(ROOT, 'src', 'lib', 'venueContent.ts');
const outputPath = path.join(ROOT, '.data', 'tests', 'venue-management.bundle.mjs');

await mkdir(path.dirname(outputPath), { recursive: true });

await build({
  entryPoints: [path.join(ROOT, 'tests', 'venue-management.test.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outputPath,
  define: {
    'import.meta.env.PROD': 'false',
  },
  plugins: [
    {
      name: 'venue-content-store-fixture',
      setup(buildContext) {
        buildContext.onResolve({ filter: /^\.\/store$/ }, (args) => {
          if (path.normalize(args.importer) !== path.normalize(venueContentPath)) return null;
          return { path: 'venue-content-store-fixture', namespace: 'venue-management-test' };
        });

        buildContext.onLoad(
          { filter: /^venue-content-store-fixture$/, namespace: 'venue-management-test' },
          () => ({
            loader: 'js',
            contents: `
              function fixture() {
                return globalThis.__venueManagementStoreFixture || {};
              }

              export async function getVenueOverride() {
                return fixture().override || null;
              }

              export async function getVenueOverrides() {
                return fixture().overrides || {};
              }

              export async function getVenueMenu() {
                return fixture().menu || [];
              }

              export async function listPublishedVenuePhotos() {
                return fixture().allPhotos || [];
              }

              export async function listPublishedVenueGalleryPhotos() {
                return fixture().galleryPhotos || [];
              }
            `,
          })
        );
      },
    },
  ],
});
