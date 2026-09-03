// Shared helper for the two AI image features on the admin screens
// (generate-image.ts and edit-image.ts): "generate a hero image from a
// prompt" and "edit the current hero image with a prompt". Both are the
// same underlying call — Gemini's image-capable model takes an array of
// parts (text and/or an inline image) and returns an image back — so one
// function covers both call sites, same as callGeminiImage([{text}]) for
// generation vs callGeminiImage([{inlineData}, {text}]) for editing.
import { getEnv } from './env';
import { recordAIUsage, calculateCost, type AIFeature } from './aiUsage';

const DEFAULT_MODEL = 'gemini-2.5-flash-image';

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface GeneratedImage {
  bytes: Uint8Array;
  contentType: string;
}

export interface GeminiImageOptions {
  feature?: AIFeature;
  contentRunId?: string;
  draftId?: string;
}

export async function callGeminiImage(
  parts: GeminiPart[],
  options?: GeminiImageOptions
): Promise<GeneratedImage> {
  const apiKey = getEnv('GEMINI_API_KEY');
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY env var.');
  const model = getEnv('GEMINI_IMAGE_MODEL') || DEFAULT_MODEL;
  const feature = options?.feature || 'admin_image_generation';
  const startTime = Date.now();

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts }] }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${errText.slice(0, 500)}`);
    }

    const data = await res.json();
    const responseParts = data?.candidates?.[0]?.content?.parts;

    const imagePart = Array.isArray(responseParts)
      ? responseParts.find((part: any) => part?.inlineData?.data)
      : null;

    if (!imagePart) {
      // Gemini can decline a prompt (safety filters, ambiguous edit request,
      // etc.) by returning text instead of an image — surface that text as
      // the error rather than a generic "no image" message.
      const textPart = Array.isArray(responseParts) ? responseParts.find((part: any) => part?.text) : null;
      throw new Error(textPart?.text?.slice(0, 500) || 'Gemini did not return an image for that prompt.');
    }

    const durationMs = Date.now() - startTime;
    const costCents = calculateCost({ provider: 'gemini', model, imageCount: 1 });

    // Record successful image generation
    recordAIUsage({
      provider: 'gemini',
      model,
      feature,
      contentRunId: options?.contentRunId,
      draftId: options?.draftId,
      imageCount: 1,
      costCents,
      success: true,
      durationMs,
      requestMetadata: { hasSourceImage: parts.some(p => p.inlineData) },
    }).catch(() => {});

    return {
      bytes: new Uint8Array(Buffer.from(imagePart.inlineData.data, 'base64')),
      contentType: imagePart.inlineData.mimeType || 'image/png',
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;

    // Record failed attempt
    recordAIUsage({
      provider: 'gemini',
      model,
      feature,
      contentRunId: options?.contentRunId,
      draftId: options?.draftId,
      costCents: 0,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs,
    }).catch(() => {});

    throw error;
  }
}
