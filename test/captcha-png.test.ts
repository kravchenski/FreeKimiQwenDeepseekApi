import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';

import { decodePng } from '../src/browser/captcha/png.ts';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function encodePng(width: number, height: number, rgb: Uint8Array, colorType: 2 | 6): Uint8Array {
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('decodePng', () => {
  test('decodes an RGBA png', () => {
    const pixels = new Uint8Array(2 * 3 * 4);
    for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 7) & 0xff;
    const image = decodePng(encodePng(3, 2, pixels, 6));
    expect(image.width).toBe(3);
    expect(image.height).toBe(2);
    expect([...image.data]).toEqual([...pixels]);
  });

  test('decodes an RGB png and fills alpha', () => {
    const pixels = new Uint8Array(2 * 2 * 3);
    for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 11) & 0xff;
    const image = decodePng(encodePng(2, 2, pixels, 2));
    expect(image.data.length).toBe(2 * 2 * 4);
    for (let index = 0; index < 4; index++) {
      expect(image.data[index * 4]).toBe(pixels[index * 3]);
      expect(image.data[index * 4 + 1]).toBe(pixels[index * 3 + 1]);
      expect(image.data[index * 4 + 2]).toBe(pixels[index * 3 + 2]);
      expect(image.data[index * 4 + 3]).toBe(255);
    }
  });

  test('rejects data that is not a png', () => {
    expect(() => decodePng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow('Not a PNG image');
  });

  test('rejects an incomplete png', () => {
    const encoded = encodePng(2, 2, new Uint8Array(2 * 2 * 4), 6);
    expect(() => decodePng(encoded.subarray(0, encoded.length - 8))).toThrow('PNG image is incomplete');
  });
});
