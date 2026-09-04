import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MODEL = process.env.GEMINI_IMAGE_MODEL?.trim() || 'gemini-2.5-flash-image';

/** Strip location suffixes so chain branches share a brand key. */
export function brandKey(name = '') {
  return String(name)
    .replace(/\s[-|@].*$/, '')
    .replace(/^the\s+/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function aiVenueImageFilename(venue) {
  const slug = String(venue.name || 'venue').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `${venue.id}-${slug}-ai.jpg`;
}

export function findChainReference(venue, venues) {
  const key = brandKey(venue.name);
  if (!key || key.split(' ').length < 2) return null;
  return venues.find((row) => (
    row.id !== venue.id
    && row.image
    && brandKey(row.name) === key
  )) || null;
}

/** Food/drink subject inferred from venue name, vibe, and deal types. */
export function subjectForVenue(venue) {
  const name = String(venue.name || '').toLowerCase();
  const vibe = String(venue.vibe || '').toLowerCase();
  const deals = (venue.dealTypes || []).join(' ').toLowerCase();
  const corpus = `${name} ${vibe}`;

  if (/board\s*&?\s*brew|board and brew/.test(corpus)) {
    return 'gourmet deli sandwiches stacked high alongside pint glasses of craft beer on a wooden table';
  }
  if (/applebee/.test(corpus)) {
    return 'appetizer platters with wings, burgers, and colorful cocktails on a bar table';
  }
  if (/black angus|outback|fleming|steakhouse|chophouse/.test(corpus)) {
    return 'a beautifully plated steak with sides and a glass of red wine';
  }
  if (/oggi/.test(corpus)) {
    return 'pizza slices and craft beer on a casual sports-bar table';
  }
  if (/islands/.test(corpus)) {
    return 'tropical burgers, fries, and island-themed cocktails on a casual table';
  }
  if (/sizzler/.test(corpus)) {
    return 'salad bar spread with grilled steak and a loaded baked potato';
  }
  if (/hodad|burger/.test(corpus)) {
    return 'gourmet double cheeseburgers with fries and a cold beer';
  }
  if (/filippi|pizza|pizzeria/.test(corpus)) {
    return 'a fresh wood-fired pizza with melted cheese and basil, close-up food photography';
  }
  if (/sushi|ramen|japanese|shogun|yamariki/.test(corpus)) {
    return 'an artfully arranged sushi platter with sashimi, nigiri, and chopsticks';
  }
  if (/taco|mexican|cantina|bracero|fidel|birria|birrieria/.test(corpus)) {
    return 'colorful Mexican small plates — tacos, guacamole, and margaritas on a rustic table';
  }
  if (/bbq|barbecue|smokehouse|grand ole/.test(corpus)) {
    return 'smoked BBQ ribs and burnt ends with sides and a craft beer';
  }
  if (/italian|pasta|luce|mona lisa/.test(corpus)) {
    return 'Italian comfort food — pasta, bread, and a glass of wine on a warm-lit table';
  }
  if (/thai/.test(corpus)) {
    return 'vibrant Thai dishes with fresh herbs, curry, and rice in colorful bowls';
  }
  if (/chinese|dim sum/.test(corpus)) {
    return 'Chinese shared plates and dumplings with tea cups on a lazy Susan';
  }
  if (/korean/.test(corpus)) {
    return 'Korean BBQ banchan and grilled meats with beer';
  }
  if (/vietnamese|pho/.test(corpus)) {
    return 'a steaming bowl of pho with fresh herbs and spring rolls';
  }
  if (/indian|curry/.test(corpus)) {
    return 'Indian curry dishes with naan bread and colorful spices';
  }
  if (/seafood|fish|oyster|mitch/.test(corpus)) {
    return 'fresh seafood — oysters on ice, grilled fish, and lemon';
  }
  if (/coffee|caf[eé]|espresso|morning glory/.test(corpus)) {
    return 'specialty coffee drinks and pastries on a cafe counter';
  }
  if (/bakery|bread|akin/.test(corpus)) {
    return 'artisan baked goods and fresh bread on a wooden board';
  }
  if (/farmer/.test(corpus)) {
    return 'farm-to-table seasonal dishes with fresh vegetables and natural light';
  }
  if (/urban plates|salad/.test(corpus)) {
    return 'colorful composed salads and grain bowls with fresh ingredients';
  }
  if (/brewery|brewpub|taproom|alehouse/.test(corpus) || (deals.includes('beer') && !deals.includes('food'))) {
    return 'craft beer flight with several pint glasses and bar snacks on a brewery table';
  }
  if (/wine/.test(corpus) || (deals.includes('wine') && !deals.includes('food'))) {
    return 'wine glasses with a charcuterie board and small plates';
  }
  if (/cocktail|speakeasy|lounge|mixology/.test(corpus) || (deals.includes('cocktails') && !deals.includes('food'))) {
    return 'artfully crafted cocktails with garnishes on a polished bar surface';
  }
  if (/sports/.test(corpus)) {
    return 'pub appetizers — wings, nachos, and draft beers on a sports bar table';
  }
  if (/rooftop/.test(corpus)) {
    return 'sunset cocktails and light appetizers on an outdoor table';
  }
  if (/pub|gastropub|neighborhood|patio/.test(corpus)) {
    return 'gastropub fare — craft beer and elevated bar food on a wooden table';
  }
  if (deals.includes('beer') && deals.includes('food')) {
    return 'appetizing bar food and craft beer on a wooden table';
  }
  if (deals.includes('cocktails') && deals.includes('food')) {
    return 'cocktails alongside shareable appetizers on a restaurant table';
  }
  if (deals.includes('food')) {
    return 'appetizing restaurant dishes and beverages styled for a neighborhood dining spot';
  }
  if (deals.includes('beer')) {
    return 'craft beer pours and bar snacks on a wooden table';
  }
  if (deals.includes('cocktails')) {
    return 'artfully crafted cocktails with garnishes on a polished bar surface';
  }
  if (deals.includes('wine')) {
    return 'wine glasses with small plates on an intimate table';
  }

  return 'appetizing restaurant food and drinks on a table — shareable plates and beverages';
}

export function buildAiVenuePrompt(venue, reference = null) {
  const neighborhood = venue.neighborhood || 'San Diego';
  const subject = subjectForVenue(venue);
  const shared = [
    'Photorealistic wide hero photograph for a restaurant directory placeholder.',
    `Venue concept: "${venue.name}" in ${neighborhood}, San Diego.`,
    `Subject: ${subject}.`,
    'Focus tightly on the food and drinks — no restaurant interior, no exterior facade, no dining room, no bar backdrop, no venue architecture.',
    'Warm, appetizing lighting. No people, no hands, no readable text, no logos, no brand names, no signage letters.',
    'Composition: wide 16:9 landscape suited to a website card hero, close enough to feel delicious and inviting.',
    'This is a synthetic food-and-drink placeholder, not a photograph of a real identifiable business.',
  ];
  if (reference) {
    shared.splice(
      4,
      0,
      `Match the food and drink style, plating aesthetic, and color palette of another location in the "${brandKey(venue.name)}" brand, but compose a distinct arrangement — different angle, different specific dishes or pours, not a pixel copy.`,
    );
  }
  return shared.join(' ');
}

async function readReferenceBytes(imagePath, rootDir) {
  const absolute = imagePath.startsWith('/images/venues/')
    ? path.join(rootDir, 'public', imagePath)
    : imagePath;
  const bytes = await fs.readFile(absolute);
  const ext = path.extname(absolute).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return { bytes, mimeType };
}

export async function generateAiVenueImage(venue, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY.');

  const parts = [{ text: buildAiVenuePrompt(venue, options.reference) }];
  if (options.reference?.image) {
    const ref = await readReferenceBytes(options.reference.image, options.rootDir);
    parts.unshift({
      inlineData: {
        mimeType: ref.mimeType,
        data: ref.bytes.toString('base64'),
      },
    });
    parts.splice(1, 0, {
      text: 'Reference image from another location in the same brand. Match its food and drink style and visual palette, but create a distinct composition.',
    });
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { imageConfig: { aspectRatio: '16:9' } },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`Gemini API error (${response.status}): ${(await response.text()).slice(0, 400)}`);
  }

  const data = await response.json();
  const responseParts = data?.candidates?.[0]?.content?.parts;
  const imagePart = Array.isArray(responseParts) ? responseParts.find((part) => part?.inlineData?.data) : null;
  if (!imagePart) {
    const textPart = Array.isArray(responseParts) ? responseParts.find((part) => part?.text)?.text : null;
    throw new Error(textPart?.slice(0, 400) || 'Gemini returned no image.');
  }

  const bytes = Buffer.from(imagePart.inlineData.data, 'base64');
  return {
    bytes,
    contentType: imagePart.inlineData.mimeType || 'image/png',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}
