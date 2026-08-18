import { readImageDimensions } from './imageDimensions';

// ---------------------------------------------------------------------------
// Byte-level hardening for images uploaded by people who aren't admins
// (restaurant owners, via the dashboard).
//
// Admin uploads (api/admin/upload-image.ts) trust the browser's declared
// content type and store the file as-is. That's fine for two known accounts;
// it isn't for public-facing uploads, where the file is hostile input. What
// this module does, in order:
//
//   1. Sniffs the real format from magic bytes and requires it to match what
//      was declared. A .png that is actually something else stops here.
//   2. Accepts only JPEG and PNG. Not a hedge — these are the two formats
//      whose headers we can fully parse (readImageDimensions) *and* whose
//      metadata we can strip losslessly below. Accepting WebP/AVIF/GIF would
//      mean storing containers we can't inspect or clean. Owners are told to
//      save as JPEG or PNG, which every phone and camera does.
//   3. Requires the dimensions to actually parse, which rejects truncated and
//      malformed files rather than letting a decoder somewhere else deal
//      with them.
//   4. Strips metadata: EXIF (which carries GPS coordinates and device
//      serial numbers), XMP, IPTC/Photoshop blocks and comments. This is a
//      privacy measure as much as a security one — a phone photo of a
//      restaurant patio usually has the exact location and timestamp in it.
//   5. Truncates anything after the image's own end marker, which is where
//      appended payloads in polyglot files live.
//
// The result is a re-serialized byte array built only from segments we
// recognized. On top of this, the venue page renders owner photos through
// Netlify's Image CDN, so visitors are served a re-encoded derivative rather
// than these bytes directly.
// ---------------------------------------------------------------------------

export type SanitizedType = 'image/jpeg' | 'image/png';

export interface SanitizeOptions {
  maxBytes: number;
  minWidth: number;
  minHeight: number;
  maxDimension: number;
}

export interface SanitizeResult {
  ok: true;
  bytes: Uint8Array;
  contentType: SanitizedType;
  width: number;
  height: number;
  /** Bytes removed by stripping — surfaced so the upload route can log how
   * much metadata a file was carrying. */
  strippedBytes: number;
}

export interface SanitizeFailure {
  ok: false;
  error: string;
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/** The format the bytes actually are, regardless of what the upload claimed.
 * Returns null for anything that isn't JPEG or PNG — including formats we'd
 * otherwise recognize, since those aren't accepted from owners. */
export function sniffImageType(bytes: Uint8Array): SanitizedType | null {
  if (startsWith(bytes, JPEG_MAGIC)) return 'image/jpeg';
  if (startsWith(bytes, PNG_MAGIC)) return 'image/png';
  return null;
}

// JPEG markers. Segments we drop entirely:
//   APP1  (0xE1) — EXIF and XMP; this is where GPS and device info live
//   APP2  (0xE2) — ICC profiles and FlashPix; large and not needed for
//                  display, and the CDN re-encode handles color fine
//   APP13 (0xED) — Photoshop IRB / IPTC
//   COM   (0xFE) — free-text comments
// APP0 (JFIF) and APP14 (Adobe, which signals the CMYK/YCCK color transform)
// are kept: dropping APP14 can invert colors on CMYK JPEGs.
const JPEG_DROP_MARKERS = new Set([0xe1, 0xe2, 0xed, 0xfe]);
const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;

/** Rebuilds a JPEG from its segments, dropping metadata ones and stopping at
 * the end-of-image marker. Returns null if the segment structure doesn't
 * parse, which is itself a reason to reject the file. */
function stripJpeg(bytes: Uint8Array): Uint8Array | null {
  const out: number[] = [0xff, 0xd8]; // SOI
  let offset = 2;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;

    // Fill bytes: any number of 0xff can pad before a marker.
    let markerOffset = offset;
    while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) markerOffset++;
    if (markerOffset >= bytes.length) return null;

    const marker = bytes[markerOffset];

    if (marker === JPEG_EOI) {
      out.push(0xff, JPEG_EOI);
      // Deliberately ignores everything after EOI — appended payloads.
      return new Uint8Array(out);
    }

    // Start of scan: the entropy-coded image data runs to the EOI, so copy
    // the rest verbatim, then trim at EOI. No EOI means the file is
    // truncated mid-scan — it would render as a half-drawn photo, so it's
    // rejected rather than stored.
    if (marker === JPEG_SOS) {
      const rest = bytes.subarray(markerOffset - 1);
      const merged = new Uint8Array(out.length + rest.length);
      merged.set(new Uint8Array(out), 0);
      merged.set(rest, out.length);
      return trimAfterJpegEoi(merged);
    }

    // Standalone markers (RSTn, TEM) carry no length payload.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(0xff, marker);
      offset = markerOffset + 1;
      continue;
    }

    const lengthOffset = markerOffset + 1;
    if (lengthOffset + 1 >= bytes.length) return null;
    const segmentLength = (bytes[lengthOffset] << 8) | bytes[lengthOffset + 1];
    if (segmentLength < 2) return null;
    const segmentEnd = lengthOffset + segmentLength;
    if (segmentEnd > bytes.length) return null;

    if (!JPEG_DROP_MARKERS.has(marker)) {
      out.push(0xff, marker);
      for (let i = lengthOffset; i < segmentEnd; i++) out.push(bytes[i]);
    }

    offset = segmentEnd;
  }

  return null; // Ran out of bytes without ever reaching SOS or EOI.
}

/** Cuts a JPEG off immediately after the last EOI marker, or returns null if
 * there isn't one — see the SOS branch above. */
function trimAfterJpegEoi(bytes: Uint8Array): Uint8Array | null {
  for (let i = bytes.length - 2; i >= 2; i--) {
    if (bytes[i] === 0xff && bytes[i + 1] === JPEG_EOI) return bytes.subarray(0, i + 2);
  }
  return null;
}

// PNG is a sequence of length-prefixed, individually CRC'd chunks, so
// dropping one needs no recalculation. These are the ancillary chunks that
// carry text or metadata rather than pixels.
const PNG_DROP_CHUNKS = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'iCCP', 'tIME']);

/** Rebuilds a PNG from its chunks, dropping metadata ones and stopping after
 * IEND. Returns null if the chunk structure doesn't parse. */
function stripPng(bytes: Uint8Array): Uint8Array | null {
  const kept: Uint8Array[] = [bytes.subarray(0, 8)]; // signature
  let offset = 8;
  let sawIend = false;

  while (offset + 8 <= bytes.length) {
    const dataLength =
      (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (dataLength < 0) return null;

    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const chunkEnd = offset + 12 + dataLength; // length + type + data + crc
    if (chunkEnd > bytes.length) return null;

    if (!PNG_DROP_CHUNKS.has(type)) kept.push(bytes.subarray(offset, chunkEnd));

    offset = chunkEnd;
    if (type === 'IEND') {
      sawIend = true;
      break; // Anything past IEND is appended junk.
    }
  }

  if (!sawIend) return null;

  const total = kept.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of kept) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/**
 * Runs the whole pipeline. `declaredType` is what the browser said the file
 * was; a mismatch against the sniffed type is a rejection rather than a
 * silent correction, because it means the upload isn't what it claimed.
 */
export function sanitizeUploadedImage(
  bytes: Uint8Array,
  declaredType: string,
  options: SanitizeOptions
): SanitizeResult | SanitizeFailure {
  if (bytes.length === 0) return { ok: false, error: 'That file is empty.' };
  if (bytes.length > options.maxBytes) {
    return { ok: false, error: `That image is too large (${Math.ceil(options.maxBytes / 1024 / 1024)}MB max).` };
  }

  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    return { ok: false, error: 'Photos must be JPEG or PNG files. Save or export the photo as a JPEG and try again.' };
  }

  const declared = (declaredType || '').split(';')[0].trim().toLowerCase();
  // image/jpg isn't a real media type but browsers and phones emit it.
  const normalizedDeclared = declared === 'image/jpg' ? 'image/jpeg' : declared;
  if (normalizedDeclared && normalizedDeclared !== sniffed) {
    return { ok: false, error: "That file's contents don't match its type. Re-save it as a JPEG or PNG and try again." };
  }

  const dimensions = readImageDimensions(bytes, sniffed);
  if (!dimensions) {
    return { ok: false, error: "That image's header couldn't be read — it may be corrupted. Try re-saving it." };
  }
  if (dimensions.width < options.minWidth || dimensions.height < options.minHeight) {
    return {
      ok: false,
      error: `That photo is too small (${dimensions.width}×${dimensions.height}px). Use one at least ${options.minWidth}×${options.minHeight}px so it doesn't look grainy on the page.`,
    };
  }
  if (dimensions.width > options.maxDimension || dimensions.height > options.maxDimension) {
    return {
      ok: false,
      error: `That photo is enormous (${dimensions.width}×${dimensions.height}px). Resize it to ${options.maxDimension}px or less on its longest side.`,
    };
  }

  const stripped = sniffed === 'image/jpeg' ? stripJpeg(bytes) : stripPng(bytes);
  if (!stripped) {
    return { ok: false, error: "That image's internal structure couldn't be parsed, so it wasn't accepted. Try re-saving it." };
  }

  // Re-read dimensions from the cleaned bytes: if stripping produced
  // something unreadable, that's a bug in the strippers and the upload should
  // fail loudly rather than store a broken file.
  const finalDimensions = readImageDimensions(stripped, sniffed);
  if (!finalDimensions) {
    return { ok: false, error: 'That image could not be processed. Try re-saving it as a JPEG.' };
  }

  return {
    ok: true,
    bytes: stripped,
    contentType: sniffed,
    width: finalDimensions.width,
    height: finalDimensions.height,
    strippedBytes: bytes.length - stripped.length,
  };
}
