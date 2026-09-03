import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();

async function astroFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return astroFiles(target);
    return entry.isFile() && entry.name.endsWith('.astro') ? [target] : [];
  }));
  return nested.flat();
}

const files = await astroFiles(path.join(projectRoot, 'src'));

const retiredGenericLoaderPatterns = [
  /class=(['"])[^'"]*\bspinner\b[^'"]*\1/i,
  /@keyframes\s+[\w-]*spin\b/i,
  /animation\s*:[^;}\n]*\b[\w-]*spin\b/i,
  /border-top-color\s*:/i,
  /loading-dot/i,
];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const pattern of retiredGenericLoaderPatterns) {
    assert.doesNotMatch(source, pattern, `${path.relative(projectRoot, file)} still contains a generic loader`);
  }
}

const loaderAssets = [
  'cocktail-loader.svg',
  'beer-loader.svg',
  'wine-loader.svg',
];

const loaderSources = new Map();
for (const asset of loaderAssets) {
  const loader = await readFile(path.join(projectRoot, 'public', asset), 'utf8');
  loaderSources.set(asset, loader);
  assert.match(loader, /@keyframes\s+[\w-]*fill/i, `${asset} has no fill animation`);
  assert.match(loader, /animation\s*:/i, `${asset} does not apply its fill animation`);
  assert.match(loader, /prefers-reduced-motion:\s*reduce/i, `${asset} has no reduced-motion treatment`);
}

function gradientColors(asset) {
  return [...loaderSources.get(asset).matchAll(/<stop\b[^>]*\bstop-color=["'](#[0-9a-f]{6})["']/gi)]
    .map((match) => match[1].toLowerCase());
}

function hexHue(hex) {
  const [red, green, blue] = hex.match(/[0-9a-f]{2}/gi).map((value) => parseInt(value, 16) / 255);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const range = maximum - minimum;
  if (range === 0) return 0;
  const hue = maximum === red
    ? ((green - blue) / range) % 6
    : maximum === green
      ? (blue - red) / range + 2
      : (red - green) / range + 4;
  return (hue * 60 + 360) % 360;
}

const palettes = Object.fromEntries(loaderAssets.map((asset) => [asset, gradientColors(asset)]));
for (const [asset, colors] of Object.entries(palettes)) {
  assert.ok(colors.length >= 3, `${asset} should use a multi-stop fill gradient`);
}

assert.ok(
  palettes['beer-loader.svg'].every((color) => {
    const hue = hexHue(color);
    return hue >= 20 && hue <= 55;
  }),
  'Beer fill should stay in a realistic amber-to-gold color family',
);
assert.ok(
  palettes['wine-loader.svg'].every((color) => {
    const hue = hexHue(color);
    return hue >= 325 || hue <= 5;
  }),
  'Wine fill should stay in a realistic burgundy-to-ruby color family',
);

for (let left = 0; left < loaderAssets.length; left += 1) {
  for (let right = left + 1; right < loaderAssets.length; right += 1) {
    const leftAsset = loaderAssets[left];
    const rightAsset = loaderAssets[right];
    assert.notDeepEqual(
      palettes[leftAsset],
      palettes[rightAsset],
      `${leftAsset} and ${rightAsset} should not share the same fill palette`,
    );
  }
}

const layout = await readFile(path.join(projectRoot, 'src', 'layouts', 'Layout.astro'), 'utf8');
assert.match(layout, /\.drink-loader\s*\{/);
assert.match(layout, /\.drink-loader--sm/);
assert.match(layout, /\.drink-loader--lg/);
for (const asset of loaderAssets) {
  assert.match(layout, new RegExp(`/${asset.replace('.', '\\.')}\\b`), `Layout does not register ${asset}`);
}
assert.match(layout, /Math\.random\s*\(/, 'Layout does not randomly select a drink loader');
assert.match(layout, /new\s+MutationObserver\s*\(/, 'Layout does not initialize dynamically inserted loaders');
assert.match(layout, /addedNodes/, 'Layout does not inspect nodes added after initial render');
assert.match(layout, /\.is-loading/, 'Layout does not handle loaders activated through an is-loading class');
assert.match(layout, /observe\s*\([^)]*\{[\s\S]*?childList\s*:\s*true[\s\S]*?subtree\s*:\s*true/, 'Layout does not observe the full app for dynamic loaders');
assert.match(layout, /attributes\s*:\s*true[\s\S]*?attributeFilter\s*:\s*\[['"]class['"]\]/, 'Layout does not observe loading-class transitions');
assert.doesNotMatch(layout, /\.cocktail-loader(?:--|\s*\{)/, 'Layout still exposes the retired cocktail-only class contract');

for (const relative of [
  'src/pages/index.astro',
  'src/pages/account.astro',
  'src/pages/live-deals.astro',
  'src/pages/restaurant.astro',
  'src/pages/restaurant/reports.astro',
  'src/pages/restaurant/audience.astro',
  'src/pages/restaurant/billing.astro',
]) {
  const source = await readFile(path.join(projectRoot, relative), 'utf8');
  assert.match(source, /\bdrink-loader(?:--|\s)/, `${relative} does not use the shared drink loader`);
}

console.log(`ok - ${files.length} Astro files use randomized cocktail, beer, and wine loaders instead of generic spinners`);
