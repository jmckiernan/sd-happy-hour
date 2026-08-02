// Reads image pixel dimensions straight from the file header — no new
// dependency needed, and this only covers the formats where doing that is
// simple and reliable (JPEG, PNG, GIF). WebP/AVIF header parsing is more
// involved (nested RIFF/ISOBMFF chunks with bit-packed fields); rather than
// risk getting that subtly wrong, those two formats just skip the
// minimum-size check in upload-image.ts instead of being parsed here.
export interface ImageDimensions {
  width: number;
  height: number;
}

function readPng(buf: Buffer): ImageDimensions | null {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return null;
  // IHDR is always the first chunk, immediately after the 8-byte
  // signature + 4-byte chunk length + 4-byte "IHDR" type: width and
  // height are the first two 4-byte big-endian fields in it.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readGif(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10) return null;
  const header = buf.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function readJpeg(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    // Markers with no following length field (SOI, TEM, RST0-RST7).
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || offset + 4 > buf.length) break; // EOI, or truncated file
    const segLength = buf.readUInt16BE(offset + 2);
    // Any SOFn marker except DHT (C4), JPG (C8), and DAC (CC).
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (offset + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + segLength;
  }
  return null;
}

// Returns null (rather than throwing) for anything unparseable — callers
// should treat that as "couldn't determine, don't block the upload over
// it" rather than a hard failure.
export function readImageDimensions(bytes: Uint8Array, contentType: string): ImageDimensions | null {
  try {
    const buf = Buffer.from(bytes);
    if (contentType === 'image/png') return readPng(buf);
    if (contentType === 'image/gif') return readGif(buf);
    if (contentType === 'image/jpeg') return readJpeg(buf);
    return null;
  } catch {
    return null;
  }
}
