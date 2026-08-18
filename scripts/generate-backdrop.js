// Generates the site-wide backdrop illustration that sits behind every page
// except the homepage (see .sd-backdrop in src/layouts/Layout.astro).
//
// Run with: npm run generate:backdrop [variant...]
//
// Same Gemini image model the admin hero-image tools use (src/lib/aiImages.ts),
// but as a script rather than a request handler: this image is committed to
// the repo and served as a static asset, so it's generated once by hand, not
// per request.
//
// Generation and promotion are deliberately separate steps:
//
//   npm run generate:backdrop                  -> all variants to .backdrop-candidates/
//   npm run generate:backdrop line-art         -> just that variant, same place
//   npm run generate:backdrop -- --promote=line-art
//                                              -> copy that candidate to
//                                                 public/images/backdrop.webp
//
// Promotion copies an existing file and makes no API call, because image
// generation is not deterministic — regenerating "the" chosen variant to ship
// it would ship a different picture than the one that was reviewed and
// approved. The prompts live here so the committed asset stays reproducible
// in spirit and easy to tweak, rather than being a mystery binary.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

// Every prompt has to satisfy the same hard constraint: the result is shown
// at roughly 12% opacity behind body copy. That kills detail and contrast,
// so each direction below is built on large simple shapes and a limited
// palette drawn from the site's own tokens, and each one explicitly bans
// text (a generated sign or label would render as illegible garbage).
const SHARED = [
  'Wide landscape composition, generous empty space in the middle of the frame.',
  'Limited palette: warm sunset orange (#FF6B35), golden yellow (#FFD23F), ocean teal (#0891B2), deep navy (#164E63), cream (#FFFBF5).',
  'No text, no letters, no words, no logos, no signage of any kind.',
  'No people\'s faces. No borders or frames.',
].join(' ');

const VARIANTS = {
  // Flat vector: the safest read at low opacity, because every element is a
  // solid shape with a hard edge.
  'flat-vector': [
    'Flat vector illustration of a San Diego beach happy hour at golden hour.',
    'Tall palm tree silhouettes on the left and right edges, a low sun sitting just above a calm ocean horizon,',
    'a long wooden pier stretching to the right, small sailboats on the water,',
    'and in the foreground the silhouette of a bar rail with two cocktail glasses and a beer glass raised in a toast.',
    'Bold simple shapes, clean geometry, no gradients, no photographic detail.',
    SHARED,
  ].join(' '),

  // Monoline: survives the most aggressive transparency of the three, and
  // reads as a drawing/engraving rather than a washed-out photo.
  'line-art': [
    'Fine monoline pen-and-ink line drawing of a San Diego coastal happy hour scene, single consistent thin line weight, no fills, no shading.',
    'Palm trees, a lifeguard tower, a long pier on pilings, gentle wave lines, sailboats,',
    'a martini glass, a coupe cocktail glass with a citrus wedge, and a pint glass arranged along the foreground.',
    'Drawn in ocean teal line work on a cream background, sparse and airy with lots of breathing room, like a vintage engraved map illustration.',
    SHARED,
  ].join(' '),

  // Watercolour: the softest and prettiest, but the highest risk of turning
  // to mush once knocked back.
  'watercolor': [
    'Soft loose watercolour wash painting of a San Diego beach bar at sunset.',
    'Silhouetted palm fronds, a wide ocean horizon with a setting sun, a hint of a pier,',
    'and a foreground patio with string lights overhead and a few cocktail glasses on a table.',
    'Pale translucent washes, soft bleeding edges, plenty of untouched cream paper showing through, very light and airy.',
    SHARED,
  ].join(' '),
};

const FINAL_FILE = path.join(process.cwd(), 'public', 'images', 'backdrop.webp');
const OUT_CANDIDATES = path.join(process.cwd(), '.backdrop-candidates');

async function generate(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY (run via npm run generate:backdrop).');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { imageConfig: { aspectRatio: '16:9' } },
      }),
    }
  );

  if (!res.ok) throw new Error(`Gemini API error (${res.status}): ${(await res.text()).slice(0, 400)}`);

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const image = Array.isArray(parts) ? parts.find((p) => p?.inlineData?.data) : null;

  if (!image) {
    // Gemini answers a declined prompt with text instead of an image; show
    // that text rather than a generic failure.
    const text = Array.isArray(parts) ? parts.find((p) => p?.text)?.text : null;
    throw new Error(text?.slice(0, 400) || 'Gemini returned no image.');
  }

  return Buffer.from(image.inlineData.data, 'base64');
}

const candidateFile = (name) => path.join(OUT_CANDIDATES, `${name}.webp`);

async function promote(name) {
  const from = candidateFile(name);
  try {
    await fs.access(from);
  } catch {
    throw new Error(`no candidate at ${path.relative(process.cwd(), from)} — generate it first.`);
  }
  await fs.mkdir(path.dirname(FINAL_FILE), { recursive: true });
  await fs.copyFile(from, FINAL_FILE);
  const { size } = await fs.stat(FINAL_FILE);
  console.log(`  ok   ${name} -> public/images/backdrop.webp  (${(size / 1024).toFixed(0)} KB)`);
}

async function main() {
  const args = process.argv.slice(2);
  const promoteArg = args.find((a) => a.startsWith('--promote'));
  const requested = args.filter((a) => !a.startsWith('--'));

  const named = [...requested, ...(promoteArg ? [promoteArg.split('=')[1]] : [])].filter(Boolean);
  const unknown = named.filter((name) => !VARIANTS[name]);
  if (unknown.length || (promoteArg && !promoteArg.includes('='))) {
    console.error(
      `Usage: npm run generate:backdrop [variant...] | -- --promote=<variant>\n` +
        `Available variants: ${Object.keys(VARIANTS).join(', ')}`
    );
    process.exit(1);
  }

  if (promoteArg) {
    await promote(promoteArg.split('=')[1]);
    return;
  }

  await fs.mkdir(OUT_CANDIDATES, { recursive: true });

  for (const name of requested.length ? requested : Object.keys(VARIANTS)) {
    try {
      const raw = await generate(VARIANTS[name]);
      // Gemini returns a large PNG. This is a full-page background on every
      // pageview, so it's re-encoded to a 1920px-wide WebP — the whole point
      // is a decorative wash, and quality 78 is far more than that needs.
      const webp = await sharp(raw)
        .resize({ width: 1920, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();

      await fs.writeFile(candidateFile(name), webp);
      console.log(
        `  ok   ${path.relative(process.cwd(), candidateFile(name))}  ` +
          `(${(raw.length / 1024).toFixed(0)} KB png -> ${(webp.length / 1024).toFixed(0)} KB webp)`
      );
    } catch (err) {
      console.error(`  FAIL ${name}  ${err.message}`);
      process.exitCode = 1;
    }
  }
}

main();
