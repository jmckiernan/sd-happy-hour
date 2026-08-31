import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const ROOT = process.cwd();
const venueContentPath = path.join(ROOT, 'src', 'lib', 'venueContent.ts');
const outputPath = path.join(ROOT, '.data', 'tests', 'venue-management.bundle.mjs');

await mkdir(path.dirname(outputPath), { recursive: true });

// The fixture stands in for lib/store, so every value venueContent imports
// from it has to exist here. Without the check below, adding an import over
// there surfaces as an esbuild "no matching export" failure that reads like a
// bundler misconfiguration rather than a stale fixture.
const storeFixture = `
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

              // Real one reads venue_publications and returns a Set of venue ids,
              // empty when nothing has been cleared for the public site.
              export async function listPublishedVenueIds() {
                return new Set(fixture().publishedVenueIds || []);
              }
`;

const venueContentSource = await readFile(venueContentPath, 'utf8');
const storeImportBlock = venueContentSource.match(/import\s*{([^}]*)}\s*from\s*'\.\/store'/);
if (!storeImportBlock) {
  throw new Error(`Expected a named import from './store' in ${venueContentPath}`);
}
const requiredExports = storeImportBlock[1]
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry && !entry.startsWith('type '))
  .map((entry) => entry.split(/\s+as\s+/)[0].trim());
const fixtureExports = new Set(
  [...storeFixture.matchAll(/export\s+(?:async\s+)?(?:function|const|let)\s+(\w+)/g)].map((m) => m[1])
);
const missing = requiredExports.filter((name) => !fixtureExports.has(name));
if (missing.length) {
  throw new Error(
    `venue-content-store-fixture is missing ${missing.join(', ')}, which src/lib/venueContent.ts imports from ./store. ` +
      'Add an implementation that mirrors the real one in src/lib/store.ts.'
  );
}

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
          () => ({ loader: 'js', contents: storeFixture })
        );
      },
    },
  ],
});
