import { createRequire } from 'node:module';
import { MediaArtifactError, type NativeImageLimits, type NativeImageProcessor } from './media-artifacts.js';

/** Decoded pixel ceiling checked from the file header before any WASM allocation (RGBA costs 4 bytes per pixel). */
export const MAX_DECODE_PIXELS = 50_000_000;
const JPEG_QUALITY_STEPS = [80, 85, 70, 55, 40];

type Photon = typeof import('@silvia-odwyer/photon-node');
type PhotonImage = import('@silvia-odwyer/photon-node').PhotonImage;
const require = createRequire(import.meta.url);
let photon: Photon | undefined;
const loadPhoton = (): Photon => (photon ??= require('@silvia-odwyer/photon-node') as Photon);

type Format = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
const corrupt = (message = 'Image is corrupt or unsupported.') => new MediaArtifactError('invalid_ref', message);

function sniff(b: Uint8Array): Format | undefined {
  const ascii = (at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 'PNG\r\n') && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) return 'image/gif';
  if (b.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return undefined;
}

/** Reads width and height from the container header without decoding pixels. */
function headerSize(b: Uint8Array, format: Format): { width: number; height: number } | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const has = (n: number) => b.length >= n;
  if (format === 'image/png') return has(24) ? { width: v.getUint32(16), height: v.getUint32(20) } : undefined;
  if (format === 'image/gif') return has(10) ? { width: v.getUint16(6, true), height: v.getUint16(8, true) } : undefined;
  if (format === 'image/jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + v.getUint16(i + 2);
    }
    return undefined;
  }
  if (!has(30)) return undefined;
  const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (chunk === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  if (chunk === 'VP8L') { const bits = v.getUint32(21, true); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }; }
  if (chunk === 'VP8 ') return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
  return undefined;
}

function exifOrientation(b: Uint8Array, format: Format): number {
  let tiff = -1;
  const hasExif = (at: number) => b[at] === 0x45 && b[at + 1] === 0x78 && b[at + 2] === 0x69 && b[at + 3] === 0x66 && b[at + 4] === 0 && b[at + 5] === 0;
  if (format === 'image/jpeg') {
    for (let i = 2; i + 4 < b.length && b[i] === 0xff;) {
      const marker = b[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xe1 && hasExif(i + 4)) { tiff = i + 10; break; }
      if (marker === 0xda) break;
      i += 2 + ((b[i + 2]! << 8) | b[i + 3]!);
    }
  } else if (format === 'image/webp') {
    for (let i = 12; i + 8 <= b.length;) {
      const size = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(i + 4, true);
      if (size > b.length - i - 8) return 1;
      if (String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!) === 'EXIF') { tiff = size >= 6 && hasExif(i + 8) ? i + 14 : i + 8; break; }
      i += 8 + size + (size % 2);
    }
  }
  if (tiff < 0 || tiff + 8 > b.length) return 1;
  const le = b[tiff] === 0x49;
  const r16 = (p: number) => (le ? b[p]! | (b[p + 1]! << 8) : (b[p]! << 8) | b[p + 1]!);
  const r32 = (p: number) => (le ? (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0 : ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0);
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > b.length) return 1;
  const count = r16(ifd);
  for (let n = 0; n < count; n++) {
    const at = ifd + 2 + n * 12;
    if (at + 12 > b.length) return 1;
    if (r16(at) === 0x0112) { const value = r16(at + 8); return value >= 1 && value <= 8 ? value : 1; }
  }
  return 1;
}

function rotate90(lib: Photon, image: PhotonImage, dst: (x: number, y: number, w: number, h: number) => number): PhotonImage {
  const w = image.get_width();
  const h = image.get_height();
  const src = image.get_raw_pixels();
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(src.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), dst(x, y, w, h) * 4);
  return new lib.PhotonImage(out, h, w);
}

/** Applies EXIF orientation. Returns the same image for flips (in place) or a new image for rotations. */
function orient(lib: Photon, image: PhotonImage, orientation: number): PhotonImage {
  const cw = (x: number, y: number, _w: number, h: number) => x * h + (h - 1 - y);
  const ccw = (x: number, y: number, w: number, h: number) => (w - 1 - x) * h + y;
  switch (orientation) {
    case 2: lib.fliph(image); return image;
    case 3: lib.fliph(image); lib.flipv(image); return image;
    case 4: lib.flipv(image); return image;
    case 5: { const r = rotate90(lib, image, cw); lib.fliph(r); return r; }
    case 6: return rotate90(lib, image, cw);
    case 7: { const r = rotate90(lib, image, ccw); lib.fliph(r); return r; }
    case 8: return rotate90(lib, image, ccw);
    default: return image;
  }
}

const base64Size = (byteLength: number) => Math.ceil(byteLength / 3) * 4;

function prepareSync(bytes: Uint8Array, mimeType: string, limits: NativeImageLimits): { data: string; mimeType: string } | undefined {
  const format = sniff(bytes);
  if (!format) throw corrupt('Image format is not supported.');
  const size = headerSize(bytes, format);
  if (!size || size.width < 1 || size.height < 1) throw corrupt();
  if (size.width * size.height > MAX_DECODE_PIXELS) throw new MediaArtifactError('too_large', 'Image dimensions are too large to decode.');
  const outputType = mimeType === format ? mimeType : format;
  const lib = loadPhoton();
  const owned: PhotonImage[] = [];
  const track = (image: PhotonImage) => { owned.push(image); return image; };
  try {
    let image: PhotonImage;
    try { image = track(lib.PhotonImage.new_from_byteslice(bytes)); } catch { throw corrupt(); }
    const orientation = exifOrientation(bytes, format);
    const oriented = orient(lib, image, orientation);
    if (oriented !== image) track(oriented);
    const width = oriented.get_width();
    const height = oriented.get_height();
    if (width < 1 || height < 1) throw corrupt();
    if (width <= limits.maxWidth && height <= limits.maxHeight && base64Size(bytes.byteLength) < limits.maxBytes && orientation === 1) {
      return { data: Buffer.from(bytes).toString('base64'), mimeType: outputType };
    }
    let w = width;
    let h = height;
    if (w > limits.maxWidth) { h = Math.max(1, Math.round((h * limits.maxWidth) / w)); w = limits.maxWidth; }
    if (h > limits.maxHeight) { w = Math.max(1, Math.round((w * limits.maxHeight) / h)); h = limits.maxHeight; }
    for (;;) {
      const resized = lib.resize(oriented, w, h, lib.SamplingFilter.Lanczos3);
      try {
        const candidates: { bytes: Uint8Array; mimeType: string }[] = [{ bytes: resized.get_bytes(), mimeType: 'image/png' }];
        for (const quality of new Set(JPEG_QUALITY_STEPS)) candidates.push({ bytes: resized.get_bytes_jpeg(quality), mimeType: 'image/jpeg' });
        for (const c of candidates) if (base64Size(c.bytes.byteLength) < limits.maxBytes) return { data: Buffer.from(c.bytes).toString('base64'), mimeType: c.mimeType };
      } finally { resized.free(); }
      if (w === 1 && h === 1) return undefined;
      w = Math.max(1, Math.floor(w * 0.75));
      h = Math.max(1, Math.floor(h * 0.75));
    }
  } finally {
    for (const image of owned) image.free();
  }
}

/**
 * Production image preparation for native model input: validates the container header, bounds decoded
 * pixels, applies EXIF orientation, resizes to the limits keeping aspect ratio, and re-encodes PNG or JPEG
 * until the base64 payload is below `maxBytes`. Unsupported or corrupt input throws `MediaArtifactError`
 * (`invalid_ref`); an image that cannot fit resolves `undefined`. Every WASM image is freed.
 */
export function createNativeImageProcessor(): NativeImageProcessor {
  return { prepare: async (bytes, mimeType, limits) => prepareSync(bytes, mimeType, limits) };
}
