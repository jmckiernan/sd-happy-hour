import { recordImage, type RecordImageInput } from './store';
import { readImageDimensions } from './imageDimensions';

// ---------------------------------------------------------------------------
// Bridges the two halves of image storage: imageStore.ts owns the bytes (in
// Netlify Blobs), migrations/0003_images.sql owns the record of what exists.
// Kept separate from imageStore.ts on purpose — that module is imported by the
// public, unauthenticated /api/images/[key] read path, which has no business
// pulling in the Postgres driver just to serve a cached image.
// ---------------------------------------------------------------------------

export interface DescribeImageInput {
  key: string;
  bytes: Uint8Array;
  contentType: string;
  origin: RecordImageInput['origin'];
  slugHint?: string;
  createdBy?: string;
  sourceUrl?: string | null;
  prompt?: string | null;
}

/**
 * Records an image's metadata, and never throws.
 *
 * By the time this runs the blob write has already succeeded and the caller is
 * about to hand back a working URL, so a database problem must not turn that
 * into a failed upload — the image genuinely exists either way. A miss costs a
 * row in a bookkeeping table, which is worth strictly less than the image.
 *
 * Failures are logged rather than swallowed: a metadata row missing for an
 * image that exists is exactly the kind of quiet drift this table was added to
 * make visible, so it should be greppable in the function logs.
 */
export async function describeStoredImage(input: DescribeImageInput): Promise<void> {
  try {
    // Only JPEG/PNG/GIF parse here; WebP/AVIF come back null and are stored as
    // null rather than guessed at.
    const dimensions = readImageDimensions(input.bytes, input.contentType);

    await recordImage({
      key: input.key,
      contentType: input.contentType,
      byteSize: input.bytes.byteLength,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      origin: input.origin,
      sourceUrl: input.sourceUrl ?? null,
      prompt: input.prompt ?? null,
      slugHint: input.slugHint ?? '',
      createdBy: input.createdBy ?? '',
    });
  } catch (err: any) {
    console.error('[imageMetadata] Could not record image', input.key, err?.message ?? err);
  }
}
