import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildNativeUserInput, MediaArtifactError, NATIVE_IMAGE_LIMITS } from '../../src/durable/media-artifacts.js';
import { createNativeImageProcessor } from '../../src/durable/media-images.js';

const photon = createRequire(import.meta.url)('@silvia-odwyer/photon-node') as typeof import('@silvia-odwyer/photon-node');
const processor = createNativeImageProcessor();

function synthetic(width: number, height: number, noise = false): { png: Buffer; jpeg: Buffer } {
  const pixels = noise ? new Uint8Array(randomBytes(width * height * 4)) : new Uint8Array(width * height * 4).fill(200);
  if (noise) for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const image = new photon.PhotonImage(pixels, width, height);
  try { return { png: Buffer.from(image.get_bytes()), jpeg: Buffer.from(image.get_bytes_jpeg(90)) }; } finally { image.free(); }
}
function dims(data: string): { width: number; height: number } {
  const image = photon.PhotonImage.new_from_byteslice(Buffer.from(data, 'base64'));
  try { return { width: image.get_width(), height: image.get_height() }; } finally { image.free(); }
}
const reject = (p: Promise<unknown>) => p.then(() => 'ok', (e: MediaArtifactError) => e.code);

it('passes through an image already within limits', async () => {
  const { png } = synthetic(40, 20);
  const out = await processor.prepare(png, 'image/png', NATIVE_IMAGE_LIMITS);
  expect(out).toEqual({ data: png.toString('base64'), mimeType: 'image/png' });
});

it('resizes oversized dimensions keeping aspect ratio', async () => {
  const { png, jpeg } = synthetic(3000, 1500);
  for (const [bytes, type] of [[png, 'image/png'], [jpeg, 'image/jpeg']] as const) {
    const out = (await processor.prepare(bytes, type, NATIVE_IMAGE_LIMITS))!;
    expect(dims(out.data)).toEqual({ width: 2000, height: 1000 });
  }
  const tall = synthetic(1000, 4000);
  expect(dims((await processor.prepare(tall.png, 'image/png', NATIVE_IMAGE_LIMITS))!.data)).toEqual({ width: 500, height: 2000 });
});

it('recompresses until the encoded payload is below the byte limit', async () => {
  const { png } = synthetic(600, 600, true);
  expect(base64Length(png)).toBeGreaterThan(200_000);
  const limits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 60_000 };
  const out = (await processor.prepare(png, 'image/png', limits))!;
  expect(out.data.length).toBeLessThan(60_000);
  expect(['image/png', 'image/jpeg']).toContain(out.mimeType);
  const d = dims(out.data);
  expect(d.width / d.height).toBeCloseTo(1, 1);
});

it('resolves undefined when the image cannot fit at any size', async () => {
  const { png } = synthetic(50, 50, true);
  expect(await processor.prepare(png, 'image/png', { maxWidth: 2000, maxHeight: 2000, maxBytes: 10 })).toBeUndefined();
});

it('rejects corrupt, truncated, unsupported, and decompression-bomb input', async () => {
  const { png } = synthetic(64, 64, true);
  expect(await reject(processor.prepare(png.subarray(0, 60), 'image/png', NATIVE_IMAGE_LIMITS))).toBe('invalid_ref');
  expect(await reject(processor.prepare(Buffer.from('not an image at all'), 'image/png', NATIVE_IMAGE_LIMITS))).toBe('invalid_ref');
  expect(await reject(processor.prepare(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', NATIVE_IMAGE_LIMITS))).toBe('invalid_ref');
  const bomb = Buffer.from(png);
  bomb.writeUInt32BE(60000, 16); bomb.writeUInt32BE(60000, 20);
  expect(await reject(processor.prepare(bomb, 'image/png', NATIVE_IMAGE_LIMITS))).toBe('too_large');
});

it('feeds prepared images into native input blocks', async () => {
  const { png } = synthetic(2600, 100);
  const store = { open: async () => ({ ref: { name: 'big.png', image: true, mimeType: 'image/png' }, bytes: png }) } as never;
  const input = await buildNativeUserInput('hi', [{}], store, { images: processor });
  expect(Array.isArray(input) && input[1]).toMatchObject({ type: 'image' });
  const block = (input as { data: string }[])[1]!;
  expect(dims(block.data).width).toBe(2000);
});

it('applies EXIF flips and rotations instead of passing through the original bytes', async () => {
  const {jpeg}=synthetic(40,20);
  for(const orientation of [2,6]){
    const segment=Buffer.alloc(36);segment[0]=0xff;segment[1]=0xe1;segment.writeUInt16BE(34,2);segment.write('Exif\0\0',4,'binary');
    segment.write('II',10);segment.writeUInt16LE(42,12);segment.writeUInt32LE(8,14);segment.writeUInt16LE(1,18);
    segment.writeUInt16LE(0x0112,20);segment.writeUInt16LE(3,22);segment.writeUInt32LE(1,24);segment.writeUInt16LE(orientation,28);
    const input=Buffer.concat([jpeg.subarray(0,2),segment,jpeg.subarray(2)]);
    const output=(await processor.prepare(input,'image/jpeg',NATIVE_IMAGE_LIMITS))!;
    expect(output.data).not.toBe(input.toString('base64'));
    expect(dims(output.data)).toEqual(orientation===6?{width:20,height:40}:{width:40,height:20});
  }
});

it('terminates for a malformed unsigned WebP chunk length',async()=>{
  const image=new photon.PhotonImage(new Uint8Array(16).fill(255),2,2);
  let original:Buffer;try{original=Buffer.from(image.get_bytes_webp());}finally{image.free();}
  const junk=Buffer.alloc(8);junk.write('JUNK');junk.writeUInt32LE(0xfffffff8,4);
  const bytes=Buffer.concat([original,junk]);bytes.writeUInt32LE(bytes.length-8,4);
  const result=await processor.prepare(bytes,'image/webp',NATIVE_IMAGE_LIMITS).catch((error:MediaArtifactError)=>error.code);
  expect(result).toBeDefined();
});

function base64Length(b: Buffer) { return Math.ceil(b.length / 3) * 4; }
