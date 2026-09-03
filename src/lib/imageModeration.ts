// ---------------------------------------------------------------------------
// Automated screening for owner-uploaded photos.
//
// imageSanitize.ts answers "is this a well-formed, metadata-free image file?"
// This answers the other question: "is what's *in* the picture something we
// can put on a public restaurant page?" It's the gate between an owner's
// upload and `status = 'published'` (see venue_photos in migrations/0004).
//
// Design decisions worth knowing:
//
// - Fail closed. Anything other than a clear pass leaves the photo in
//   'in_review' for a human: a flagged verdict, an unparseable response, a
//   network error, a missing API key. A photo nobody has vouched for — model
//   or admin — is never public. This is why a missing GEMINI_API_KEY doesn't
//   break uploads; it just means every photo waits for you.
//
// - Reject only on an unambiguous fail. The model's "this is pornographic"
//   goes straight to 'rejected'; its "this doesn't look like a restaurant"
//   does not — that's a judgement call an owner can reasonably disagree with
//   (a bar's mural, a staff portrait), so it becomes review rather than a
//   refusal.
//
// - The verdict is stored verbatim on the photo row, so a decision can always
//   be traced back to what the model actually said.
// ---------------------------------------------------------------------------

import { recordAIUsage, calculateCost } from './aiUsage';

// Verified against this project's key rather than picked from memory:
// gemini-2.5-flash returns 404 "no longer available to new users" and the API's
// own error names this as the replacement. Pinned rather than using the
// `gemini-flash-latest` alias, so a moderation decision made today can be
// explained by the same model tomorrow. Override with GEMINI_MODERATION_MODEL.
const DEFAULT_MODEL = 'gemini-3.6-flash';

/** 'publish' — cleared automatically. 'review' — a human decides.
 *  'reject' — refused outright. */
export type ModerationDecision = 'publish' | 'review' | 'reject';

export interface ModerationVerdict {
  decision: ModerationDecision;
  /** Short, owner-facing explanation. Safe to show in the dashboard. */
  reason: string;
  /** Machine-readable categories the screen objected to, if any. */
  categories: string[];
  /** Whether the photo plausibly depicts a restaurant/bar/food/drink scene. */
  relevant: boolean;
  model: string;
  /** Raw model text, kept for the audit trail on the photo row. */
  raw?: string;
  /** Set when screening could not run at all, as opposed to running and
   * flagging something. */
  screeningUnavailable?: boolean;
}

const PROMPT = `You are screening a photo submitted by a restaurant or bar owner for publication on a public happy-hour guide. The photo will appear in the venue's photo album or next to a menu item.

Reply with ONLY a JSON object, no markdown fence, in exactly this shape:
{"unsafe": boolean, "categories": string[], "relevant": boolean, "reason": string}

Set "unsafe" to true if the image contains any of: nudity or sexual content; graphic violence, injury or gore; hate symbols; illegal drug use; weapons brandished at people; images of identity documents, credit cards or other personal data; content that is clearly an advertisement for something other than this venue; or anything a general audience would find shocking. List what you found in "categories" using short lowercase slugs.

Set "relevant" to true if the image plausibly belongs on a restaurant or bar page: food, drinks, the interior or exterior of a venue, staff at work, guests dining, a menu, or the surrounding neighbourhood. Set it to false for unrelated content such as memes, screenshots, random personal photos, or stock graphics.

"reason" must be one short sentence, written so it can be shown to the owner.

Alcohol, cocktails, beer, wine, and people drinking socially in a bar are all normal for this context and are NOT unsafe.`;

interface ScreenInput {
  bytes: Uint8Array;
  contentType: string;
}

/** Pulls the first JSON object out of a model reply, tolerating a stray
 * markdown fence or a sentence before it. */
function parseVerdictJson(text: string): { unsafe?: boolean; categories?: unknown; relevant?: boolean; reason?: unknown } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean).slice(0, 12);
}

/**
 * Screens one image. Never throws — every failure path resolves to a
 * 'review' verdict, because the caller's job (accept the upload, decide
 * whether it's public) has to succeed either way.
 */
export async function screenImage({ bytes, contentType }: ScreenInput): Promise<ModerationVerdict> {
  const apiKey = import.meta.env.GEMINI_API_KEY;
  const model = import.meta.env.GEMINI_MODERATION_MODEL || DEFAULT_MODEL;

  if (!apiKey) {
    return {
      decision: 'review',
      reason: 'Automated screening is not configured, so this photo is waiting on manual review.',
      categories: [],
      relevant: false,
      model,
      screeningUnavailable: true,
    };
  }

  const startTime = Date.now();
  let text: string;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inlineData: { mimeType: contentType, data: Buffer.from(bytes).toString('base64') } },
              { text: PROMPT },
            ],
          },
        ],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      const durationMs = Date.now() - startTime;
      recordAIUsage({
        provider: 'gemini',
        model,
        feature: 'photo_moderation',
        costCents: 0,
        success: false,
        errorMessage: `HTTP ${res.status}: ${detail}`,
        durationMs,
      }).catch(() => {});
      return {
        decision: 'review',
        reason: 'Automated screening could not run, so this photo is waiting on manual review.',
        categories: [],
        relevant: false,
        model,
        raw: `HTTP ${res.status}: ${detail}`,
        screeningUnavailable: true,
      };
    }

    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    text = Array.isArray(parts)
      ? parts.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('').trim()
      : '';

    // Extract token usage if available
    inputTokens = data?.usageMetadata?.promptTokenCount;
    outputTokens = data?.usageMetadata?.candidatesTokenCount;

    const durationMs = Date.now() - startTime;
    const costCents = calculateCost({ provider: 'gemini', model, inputTokens, outputTokens });
    recordAIUsage({
      provider: 'gemini',
      model,
      feature: 'photo_moderation',
      inputTokens,
      outputTokens,
      costCents,
      success: true,
      durationMs,
    }).catch(() => {});
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    recordAIUsage({
      provider: 'gemini',
      model,
      feature: 'photo_moderation',
      costCents: 0,
      success: false,
      errorMessage: String(err?.message || err).slice(0, 300),
      durationMs,
    }).catch(() => {});
    return {
      decision: 'review',
      reason: 'Automated screening could not run, so this photo is waiting on manual review.',
      categories: [],
      relevant: false,
      model,
      raw: String(err?.message || err).slice(0, 300),
      screeningUnavailable: true,
    };
  }

  const parsed = parseVerdictJson(text);
  if (!parsed || typeof parsed.unsafe !== 'boolean') {
    // A reply we can't read is not a pass.
    return {
      decision: 'review',
      reason: 'Automated screening was inconclusive, so this photo is waiting on manual review.',
      categories: [],
      relevant: false,
      model,
      raw: text.slice(0, 500),
    };
  }

  const categories = stringList(parsed.categories);
  const relevant = parsed.relevant === true;
  const reason = String(parsed.reason ?? '').trim().slice(0, 300);

  if (parsed.unsafe) {
    return {
      decision: 'reject',
      reason: reason || 'This photo was rejected by automated screening.',
      categories,
      relevant,
      model,
      raw: text.slice(0, 500),
    };
  }

  if (!relevant) {
    return {
      decision: 'review',
      // Deliberately not a rejection: "doesn't look like a restaurant" is a
      // judgement an owner can reasonably disagree with.
      reason: reason || "This photo didn't obviously look like a venue photo, so an admin will take a look.",
      categories,
      relevant,
      model,
      raw: text.slice(0, 500),
    };
  }

  return {
    decision: 'publish',
    reason: reason || 'Cleared by automated screening.',
    categories,
    relevant,
    model,
    raw: text.slice(0, 500),
  };
}

/** The shape stored in venue_photos.moderation. */
export function moderationRecord(verdict: ModerationVerdict): Record<string, unknown> {
  return {
    decision: verdict.decision,
    reason: verdict.reason,
    categories: verdict.categories,
    relevant: verdict.relevant,
    model: verdict.model,
    screeningUnavailable: Boolean(verdict.screeningUnavailable),
    raw: verdict.raw ?? null,
  };
}
