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

function sceneForVenue(venue) {
  const vibe = String(venue.vibe || '').toLowerCase();
  const deals = (venue.dealTypes || []).join(' ').toLowerCase();
  if (/brewery|brewpub|taproom/.test(vibe)) return 'craft brewery taproom with polished concrete, wooden tables, and a long beer bar';
  if (/sports/.test(vibe)) return 'lively sports bar with multiple screens, booths, and a long bar';
  if (/rooftop|sky lounge/.test(vibe)) return 'rooftop lounge with open-air seating, city views, and sunset light';
  if (/steakhouse|chophouse|prime/.test(vibe)) return 'upscale steakhouse dining room with dark wood, leather booths, and warm lighting';
  if (/sushi|ramen|japanese|thai|chinese|korean|vietnamese|mexican|italian|pizza|taco/.test(`${vibe} ${venue.name}`)) {
    return 'restaurant dining room styled for its cuisine, with an inviting bar area and natural light';
  }
  if (/coffee|caf[eé]/.test(vibe)) return 'neighborhood cafe with espresso bar, pastry case, and comfortable seating';
  if (/wine/.test(vibe) || deals.includes('wine')) return 'wine bar with bottle shelves, small plates, and intimate lighting';
  if (/cocktail|speakeasy|lounge|nightlife/.test(vibe)) return 'cocktail lounge with a polished bar, moody lighting, and booth seating';
  return 'neighborhood restaurant and bar with a welcoming dining room and active bar';
}

export function buildAiVenuePrompt(venue, reference = null) {
  const neighborhood = venue.neighborhood || 'San Diego';
  const scene = sceneForVenue(venue);
  const shared = [
    'Photorealistic wide hero photograph for a restaurant directory placeholder.',
    `Venue concept: "${venue.name}" in ${neighborhood}, San Diego.`,
    `Setting: ${scene}.`,
    'Golden-hour or warm interior lighting, no people, no readable text, no logos, no brand names, no signage letters.',
    'Composition: wide 16:9 landscape suited to a website card hero, atmospheric and inviting.',
    'This is a synthetic placeholder image, not a photograph of a real identifiable business facade.',
  ];
  if (reference) {
    shared.splice(3, 0, `Match the visual style, palette, and hospitality feel of another location in the "${brandKey(venue.name)}" brand, but show a distinct interior or patio that could plausibly belong to a different branch in ${neighborhood}.`);
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
      text: 'Reference image from another location in the same brand. Use it only for style and atmosphere, not as a pixel copy.',
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
