import { getEnv } from '../env';
import { callGeminiImage } from '../aiImages';
import { saveImage, makeImageKey } from '../imageStore';
import { describeStoredImage } from '../imageMetadata';
import type { EditorialCluster, GeneratedDraft } from './types';

export interface DraftImageResult {
  url: string | null;
  metadata: Record<string, unknown>;
  outcome: 'attached' | 'generated' | 'unavailable';
}

function permittedSourceImage(cluster: EditorialCluster) {
  for (const item of cluster.items) {
    for (const source of item.provenance) {
      if (source.imagePolicy === 'none') continue;
      const url = source.imageUrls[0] || item.imageUrls[0];
      if (!url) continue;
      return {
        url,
        sourceUrl: source.sourceUrl,
        attribution: source.attribution || source.sourceName,
        policy: source.imagePolicy,
      };
    }
  }
  return null;
}

export async function resolveDraftImage(input: {
  cluster: EditorialCluster;
  draft: GeneratedDraft;
  allowGeneration: boolean;
  forceGenerate?: boolean;
  contentRunId?: string;
}): Promise<DraftImageResult> {
  const reusable = input.forceGenerate ? null : permittedSourceImage(input.cluster);
  if (reusable) {
    return {
      url: reusable.url,
      outcome: 'attached',
      metadata: {
        origin: 'source',
        sourceUrl: reusable.sourceUrl,
        attribution: reusable.attribution,
        imagePolicy: reusable.policy,
      },
    };
  }
  if (!input.allowGeneration || !getEnv('GEMINI_API_KEY')) {
    return {
      url: null,
      outcome: 'unavailable',
      metadata: { origin: 'fallback', reason: 'no_permitted_source_image_or_generation_key' },
    };
  }

  const locations = input.draft.locations.slice(0, 3).join(', ');
  const prompt = [
    `Create an original editorial hero image for an Happy Hour SD article titled "${input.draft.title}".`,
    locations ? `San Diego County setting cues: ${locations}.` : 'The setting should feel unmistakably San Diego County.',
    `Story angle: ${input.cluster.angle}`,
    'Photorealistic candid editorial atmosphere, warm natural light, diverse adults enjoying a local night out.',
    'Landscape 16:9 composition with room for headline cropping. Do not show readable text, brand logos, venue names, or watermarks.',
  ].join(' ');
  const generated = await callGeminiImage([{ text: prompt }], {
    feature: 'content_engine_image',
    contentRunId: input.contentRunId,
    draftId: input.draft.id,
  });
  const key = makeImageKey(input.draft.slug || 'content-engine', generated.contentType);
  await saveImage(key, generated.bytes, generated.contentType);
  await describeStoredImage({
    key,
    bytes: generated.bytes,
    contentType: generated.contentType,
    origin: 'generated',
    prompt,
    slugHint: input.draft.slug || 'content-engine',
    createdBy: 'content-engine',
  });
  return {
    url: `/api/images/${key}`,
    outcome: 'generated',
    metadata: { origin: 'generated', prompt, model: getEnv('GEMINI_IMAGE_MODEL') || 'gemini-2.5-flash-image' },
  };
}
