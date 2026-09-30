import { inflateSync } from 'node:zlib';

import type { RgbaImage } from './gap.ts';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft;
  const pa = Math.abs(prediction - left);
  const pb = Math.abs(prediction - up);
  const pc = Math.abs(prediction - upperLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upperLeft;
}

function unfilter(raw: Uint8Array, width: number, height: number, bytesPerPixel: number): Uint8Array {
  const stride = width * bytesPerPixel;
  const out = new Uint8Array(stride * height);
  let offset = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw[offset++];
    const current = out.subarray(row * stride, (row + 1) * stride);
    const previous = row > 0 ? out.subarray((row - 1) * stride, row * stride) : undefined;
    for (let column = 0; column < stride; column++) {
      const value = raw[offset + column];
      const left = column >= bytesPerPixel ? current[column - bytesPerPixel] : 0;
      const up = previous ? previous[column] : 0;
      const upperLeft = previous && column >= bytesPerPixel ? previous[column - bytesPerPixel] : 0;
      let restored: number;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + up; break;
        case 3: restored = value + ((left + up) >> 1); break;
        case 4: restored = value + paeth(left, up, upperLeft); break;
        default: throw new Error(`Unsupported PNG filter: ${filter}`);
      }
      current[column] = restored & 0xff;
    }
    offset += stride;
  }
  return out;
}

export function decodePng(buffer: Uint8Array): RgbaImage {
  for (let index = 0; index < SIGNATURE.length; index++) {
    if (buffer[index] !== SIGNATURE[index]) throw new Error('Not a PNG image');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (offset + 8 <= buffer.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(buffer[offset + 4], buffer[offset + 5], buffer[offset + 6], buffer[offset + 7]);
    const body = offset + 8;
    if (type === 'IHDR') {
      width = view.getUint32(body);
      height = view.getUint32(body + 4);
      bitDepth = buffer[body + 8];
      colorType = buffer[body + 9];
      interlace = buffer[body + 12];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(body, body + length));
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    offset = body + length + 4;
  }
  if (!ended || !width || !height) throw new Error('PNG image is incomplete');
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`Unsupported PNG color type: ${colorType}`);
  if (interlace !== 0) throw new Error('Interlaced PNG images are not supported');

  const total = idat.reduce((sum, part) => sum + part.length, 0);
  const compressed = new Uint8Array(total);
  let cursor = 0;
  for (const part of idat) {
    compressed.set(part, cursor);
    cursor += part.length;
  }
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const raw = inflateSync(compressed);
  const pixels = unfilter(raw, width, height, bytesPerPixel);

  const data = new Uint8Array(width * height * 4);
  if (bytesPerPixel === 4) {
    data.set(pixels);
  } else {
    for (let index = 0; index < width * height; index++) {
      data[index * 4] = pixels[index * 3];
      data[index * 4 + 1] = pixels[index * 3 + 1];
      data[index * 4 + 2] = pixels[index * 3 + 2];
      data[index * 4 + 3] = 255;
    }
  }
  return { width, height, data };
}
