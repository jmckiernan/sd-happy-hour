import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const ROOT = process.cwd();
const routePath = path.join(ROOT, 'src', 'pages', 'api', 'admin', 'users', '[id].ts');
const outputPath = path.join(ROOT, '.data', 'tests', 'admin-user-intelligence.bundle.mjs');

await mkdir(path.dirname(outputPath), { recursive: true });

await build({
  entryPoints: [path.join(ROOT, 'tests', 'admin-user-intelligence.test.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outputPath,
  define: { 'import.meta.env.PROD': 'false' },
  plugins: [{
    name: 'admin-user-api-fixture',
    setup(buildContext) {
      const routeImport = (args) => path.normalize(args.importer) === path.normalize(routePath);
      buildContext.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/\.\.\/lib\/admins$/ }, (args) =>
        routeImport(args) ? { path: 'admins-fixture', namespace: 'admin-user-test' } : null);
      buildContext.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/\.\.\/lib\/adminUsers$/ }, (args) =>
        routeImport(args) ? { path: 'admin-users-fixture', namespace: 'admin-user-test' } : null);
      buildContext.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/\.\.\/lib\/venues$/ }, (args) =>
        routeImport(args) ? { path: 'venues-fixture', namespace: 'admin-user-test' } : null);

      buildContext.onLoad({ filter: /^admins-fixture$/, namespace: 'admin-user-test' }, () => ({
        loader: 'js',
        contents: `export async function getAdminUser() {
          const fixture = globalThis.__adminUserApiFixture || {};
          return fixture.authenticated ? { id: 'admin-1', email: 'admin@example.test', accountStatus: 'active' } : null;
        }`,
      }));
      buildContext.onLoad({ filter: /^admin-users-fixture$/, namespace: 'admin-user-test' }, () => ({
        loader: 'js',
        contents: `
          export class AdminUserMutationError extends Error { constructor(message, status=422){ super(message); this.status=status; } }
          export async function getAdminUserDetail(){ return (globalThis.__adminUserApiFixture || {}).detail || null; }
          export async function mutateUserAccount(input){
            const fixture = globalThis.__adminUserApiFixture || {};
            fixture.calls.push(input);
            return { status: input.action === 'anonymize' ? 'anonymized' : 'inactive' };
          }
        `,
      }));
      buildContext.onLoad({ filter: /^venues-fixture$/, namespace: 'admin-user-test' }, () => ({
        loader: 'js', contents: `export function getVenues(){ return [{ id:2, name:'Test Venue Two' }]; }`,
      }));
    },
  }],
});

