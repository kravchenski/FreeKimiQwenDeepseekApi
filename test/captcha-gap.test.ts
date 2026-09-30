import { describe, expect, test } from 'bun:test';

import { findGapX, type RgbaImage } from '../src/browser/captcha/gap.ts';

function hashNoise(x: number, y: number, seed: number): number {
  let value = (x * 374761393 + y * 668265263 + seed * 144665) | 0;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return (value ^ (value >>> 16)) & 0xff;
}

function texture(width: number, height: number, seed: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const noise = hashNoise(x, y, seed);
      data[index] = noise;
      data[index + 1] = (noise * 3 + x) & 0xff;
      data[index + 2] = (noise * 5 + y) & 0xff;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

function crop(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const source = ((y + row) * image.width + x) * 4;
    data.set(image.data.subarray(source, source + width * 4), row * width * 4);
  }
  return { width, height, data };
}

describe('findGapX', () => {
  test('locates a piece cut from the background', () => {
    const background = texture(320, 160, 1);
    const piece = crop(background, 197, 5, 47, 150);
    const gap = findGapX(background, piece);
    expect(gap).not.toBeNull();
    expect(Math.abs(gap!.x - 197)).toBeLessThanOrEqual(2);
    expect(Math.abs(gap!.y - 5)).toBeLessThanOrEqual(3);
    expect(gap!.score).toBeGreaterThanOrEqual(0.35);
  });

  test('handles an alpha-masked piece', () => {
    const background = texture(320, 160, 2);
    const piece = crop(background, 100, 4, 47, 150);
    const data = new Uint8Array(piece.data);
    for (let y = 0; y < piece.height; y++) {
      for (let x = 0; x < piece.width; x++) {
        const inside = x >= 8 && x < piece.width - 8 && y >= 8 && y < piece.height - 8;
        data[(y * piece.width + x) * 4 + 3] = inside ? 255 : 0;
      }
    }
    const gap = findGapX(background, { ...piece, data });
    expect(gap).not.toBeNull();
    expect(Math.abs(gap!.x - 100)).toBeLessThanOrEqual(2);
  });

  test('rejects an unrelated piece', () => {
    const background = texture(320, 160, 3);
    const unrelated = crop(texture(320, 160, 4), 60, 5, 47, 150);
    expect(findGapX(background, unrelated)).toBeNull();
  });

  test('finds a dark hole cut into the background', () => {
    const background = texture(320, 160, 5);
    const piece = crop(background, 210, 5, 47, 150);
    const pieceData = new Uint8Array(piece.data);
    for (let y = 0; y < piece.height; y++) {
      for (let x = 0; x < piece.width; x++) {
        if (x < 3 || x >= piece.width - 3 || y < 3 || y >= piece.height - 3) {
          const index = (y * piece.width + x) * 4;
          pieceData[index] = Math.round(pieceData[index] * 0.35);
          pieceData[index + 1] = Math.round(pieceData[index + 1] * 0.35);
          pieceData[index + 2] = Math.round(pieceData[index + 2] * 0.35);
        }
      }
    }
    const data = new Uint8Array(background.data);
    for (let y = 5; y < 155; y++) {
      for (let x = 210; x < 257; x++) {
        const rim = x < 213 || x >= 254 || y < 8 || y >= 152;
        const index = (y * 320 + x) * 4;
        data[index] = rim ? 10 : 60;
        data[index + 1] = rim ? 10 : 62;
        data[index + 2] = rim ? 12 : 66;
      }
    }
    const gap = findGapX({ width: 320, height: 160, data }, { ...piece, data: pieceData }, { threshold: 0.1 });
    expect(gap).not.toBeNull();
    expect(Math.abs(gap!.x - 210)).toBeLessThanOrEqual(3);
  });

  test('aligns a bright neutral hole with a non-green outline piece', () => {
    const width = 320;
    const height = 160;
    const data = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index++) {
      data[index * 4] = 140;
      data[index * 4 + 1] = 160;
      data[index * 4 + 2] = 90;
      data[index * 4 + 3] = 255;
    }
    for (let y = 40; y < 100; y++) {
      for (let x = 210; x < 250; x++) {
        const pixel = (y * width + x) * 4;
        data[pixel] = 224;
        data[pixel + 1] = 225;
        data[pixel + 2] = 209;
      }
    }
    const pieceWidth = 47;
    const pieceHeight = 150;
    const pieceData = new Uint8Array(pieceWidth * pieceHeight * 4);
    for (let index = 0; index < pieceWidth * pieceHeight; index++) {
      pieceData[index * 4] = 140;
      pieceData[index * 4 + 1] = 160;
      pieceData[index * 4 + 2] = 90;
      pieceData[index * 4 + 3] = 255;
    }
    for (let y = 8; y < 141; y++) {
      for (let x = 4; x < 42; x++) {
        if (!(x < 7 || x >= 39 || y < 11 || y >= 138)) continue;
        const pixel = (y * pieceWidth + x) * 4;
        pieceData[pixel] = 60;
        pieceData[pixel + 1] = 90;
        pieceData[pixel + 2] = 170;
      }
    }
    const gap = findGapX({ width, height, data }, { width: pieceWidth, height: pieceHeight, data: pieceData });
    expect(gap).not.toBeNull();
    expect(Math.abs(gap!.x - 207)).toBeLessThanOrEqual(3);
  });

  test('prefers the vertically aligned piece among multiple blobs', () => {
    const width = 320;
    const height = 160;
    const data = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index++) {
      data[index * 4] = 140;
      data[index * 4 + 1] = 160;
      data[index * 4 + 2] = 90;
      data[index * 4 + 3] = 255;
    }
    for (let y = 60; y < 100; y++) {
      for (let x = 210; x < 250; x++) {
        const pixel = (y * width + x) * 4;
        data[pixel] = 224;
        data[pixel + 1] = 225;
        data[pixel + 2] = 209;
      }
    }
    const pieceWidth = 47;
    const pieceHeight = 150;
    const pieceData = new Uint8Array(pieceWidth * pieceHeight * 4);
    for (let index = 0; index < pieceWidth * pieceHeight; index++) {
      pieceData[index * 4] = 140;
      pieceData[index * 4 + 1] = 160;
      pieceData[index * 4 + 2] = 90;
      pieceData[index * 4 + 3] = 255;
    }
    const fill = (x0: number, x1: number, y0: number, y1: number, rgb: readonly [number, number, number]) => {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const pixel = (y * pieceWidth + x) * 4;
          pieceData[pixel] = rgb[0];
          pieceData[pixel + 1] = rgb[1];
          pieceData[pixel + 2] = rgb[2];
        }
      }
    };
    fill(10, 47, 5, 55, [60, 90, 170]);
    fill(4, 42, 68, 96, [60, 90, 170]);
    fill(8, 38, 72, 92, [140, 160, 90]);
    const gap = findGapX({ width, height, data }, { width: pieceWidth, height: pieceHeight, data: pieceData });
    expect(gap).not.toBeNull();
    expect(Math.abs(gap!.x - 207)).toBeLessThanOrEqual(2);
  });

  test('rejects images that cannot match', () => {
    expect(findGapX(texture(10, 10, 6), texture(40, 40, 6))).toBeNull();
    expect(findGapX(texture(40, 40, 7), { width: 4, height: 4, data: new Uint8Array(64) })).toBeNull();
  });
});
